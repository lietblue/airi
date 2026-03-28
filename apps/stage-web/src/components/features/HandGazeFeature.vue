<script setup lang="ts">
import type { PerceptionState } from '@proj-airi/model-driver-mediapipe'
import type { VrmFrameHook } from '@proj-airi/stage-ui-three'

import { errorMessageFrom } from '@moeru/std'
import { createMediaPipeBackend, createMocapEngine } from '@proj-airi/model-driver-mediapipe'
import { useModelStore } from '@proj-airi/stage-ui-three'
import { useHandVisionStore } from '@proj-airi/stage-ui/stores/modules/hand-vision'
import { computeOpenness, createGestureStateMachine } from '@proj-airi/stage-ui/utils/hand-gesture'
import { storeToRefs } from 'pinia'
import { Euler, Plane, Quaternion, Raycaster, Vector2, Vector3 } from 'three'
import { onMounted, onUnmounted, ref, toRaw, watch } from 'vue'

const handVisionStore = useHandVisionStore()
const {
  gazeEnabled,
  requireArmRaised,
  gazeAmplitude,
  gazeInvertX,
  gazeInvertY,
  headTrackingEnabled,
  headTrackingStrength,
} = storeToRefs(handVisionStore)

const modelStore = useModelStore()
const { lookAtTarget, eyeHeight, trackingMode } = storeToRefs(modelStore)
let savedTrackingMode: string | undefined

// --- Gesture state machine for open→close detection ---
const gestureSM = createGestureStateMachine({
  onOpen: () => {
    handVisionStore.handIsOpen = true
  },
  onClose: () => {
    handVisionStore.handIsOpen = false
  },
  onOpenClose: () => {
    handVisionStore.tryTriggerByGesture()
  },
})

// --- DOM refs ---
const videoRef = ref<HTMLVideoElement>()

// --- Stream & engine ---
let stream: MediaStream | undefined
let engine: ReturnType<typeof createMocapEngine> | undefined
const status = ref<'idle' | 'starting' | 'running' | 'error'>('idle')
let ignoreErrorsUntil = 0

// Enabled both hands and pose so we can check elbow Y for arm-raise detection
const config = {
  enabled: { pose: true, hands: true, face: false },
  hz: { pose: 30, hands: 30, face: 30 },
  maxPeople: 1 as const,
}

// --- Gaze lerp state ---
// Three-phase: active tracking → coast (momentum) → return to neutral.
let _currentLookAt = { x: 0, y: 0, z: -100 }
let _handTarget = { x: 0, y: 0, z: -100 }
const _vel = { x: 0, y: 0, z: 0 }
let _prevFrameMs = 0
let _rafId: number | undefined
let _lastHandSeenMs = 0

// NOTICE: same coefficients as hand-tracker.vue
const LERP_K = 12
const DECEL_K = 4
const HAND_HOLD_MS = 600

// Pre-allocated raycaster reusables for handNdcToWorld
const _raycaster = new Raycaster()
const _mouse = new Vector2()
const _plane = new Plane()
const _hit = new Vector3()
const _dirWs = new Vector3()

// --- isArmRaised: mirrors hand-tracker.vue logic ---
// Falls back to true (allow tracking) when pose data or visibility is insufficient.
function isArmRaised(hand: NonNullable<PerceptionState['hands']>[number], pose: PerceptionState['pose']): boolean {
  if (!requireArmRaised.value)
    return true
  const lm = pose?.landmarks2d
  if (!lm)
    return true
  // NOTICE: elbow indices from MediaPipe Pose (person's perspective, matching HandState.handedness):
  // Left elbow = 13, Right elbow = 14
  const elbowIdx = hand.handedness === 'Left' ? 13 : 14
  const elbow = lm[elbowIdx]
  if (!elbow)
    return true
  const MIN_VIS = 0.3
  if (elbow.visibility != null && elbow.visibility < MIN_VIS)
    return true
  const wrist = hand.landmarks2d[0]
  return wrist.y < elbow.y // image-space y increases downward; wrist above elbow = raised
}

// --- handNdcToWorld: project 2D hand position to 3D lookAt world space ---
// Uses fallback formula (no camera ref needed); equivalent to the pre-scene fallback in hand-tracker.vue.
// A camera-based raycaster upgrade can be added later by passing a ThreeScene ref as a prop.
function handNdcToWorld(nx: number, ny: number): { x: number, y: number, z: number } {
  // NOTICE: default sx=-1 because the front-facing camera is mirrored; sy=+1 because
  // image-space Y increases downward while world Y increases upward.
  const sx = gazeInvertX.value ? 1 : -1
  const sy = gazeInvertY.value ? 1 : -1
  const amp = gazeAmplitude.value
  return {
    x: sx * (nx - 0.5) * amp,
    y: eyeHeight.value + sy * (0.5 - ny) * 0.5 * amp,
    z: 0,
  }
}

// --- Head bone rotation ---
// Pre-allocated reusables to avoid GC pressure each frame (mirrors hand-tracker.vue).
const _htr = {
  modelQ: new Quaternion(),
  invQ: new Quaternion(),
  dir: new Vector3(),
  fullQ: new Quaternion(),
  splitQ: new Quaternion(),
  euler: new Euler(0, 0, 0, 'YXZ'),
}
const MAX_HEAD_YAW = Math.PI / 3 // 60° horizontal
const MAX_HEAD_PITCH = Math.PI / 5 // 36° vertical

// NOTICE: vrm parameter typed as `any` to avoid importing @pixiv/three-vrm directly
// into stage-web (which does not depend on it). The shape (humanoid, scene) is stable
// across three-vrm versions and matches what VRMModel.vue passes to the hook.
function applyHeadRotation(vrm: any, strength: number) {
  const headBone = vrm.humanoid?.getNormalizedBoneNode('head')
  const neckBone = vrm.humanoid?.getNormalizedBoneNode('neck')
  if (!headBone)
    return

  // NOTICE: handNdcToWorld returns z=0 (no camera raycaster available). With z=0,
  // dir.z=0 after model-space transform → atan2(x, 0) = ±90° snap for any non-zero x.
  // Fix: use a fixed forward depth of -1 to produce proportional yaw angles, mirroring
  // what the devtool camera raycaster naturally achieves. Eye tracking is unaffected
  // because it uses the VRM's built-in lookAt which handles z=0 targets differently.
  const FORWARD_DEPTH = -1.0
  _htr.dir.set(_currentLookAt.x, _currentLookAt.y - eyeHeight.value, FORWARD_DEPTH)
  if (_htr.dir.lengthSq() < 1e-10)
    return
  _htr.dir.normalize()

  // Transform to normalized VRM model space so yaw/pitch are in the character's frame.
  // NOTICE: same axis convention as hand-tracker.vue — see that file for detail.
  vrm.scene.getWorldQuaternion(_htr.modelQ)
  _htr.invQ.copy(_htr.modelQ).invert()
  _htr.dir.applyQuaternion(_htr.invQ)

  const hDist = Math.sqrt(_htr.dir.x * _htr.dir.x + _htr.dir.z * _htr.dir.z)
  const yaw = Math.atan2(-_htr.dir.x, -_htr.dir.z)
  const pitch = -Math.atan2(_htr.dir.y, Math.max(hDist, 0.001))

  const sy = Math.max(-MAX_HEAD_YAW, Math.min(MAX_HEAD_YAW, yaw)) * strength
  const sp = Math.max(-MAX_HEAD_PITCH, Math.min(MAX_HEAD_PITCH, pitch)) * strength

  _htr.euler.set(sp, sy, 0, 'YXZ')
  _htr.fullQ.setFromEuler(_htr.euler)

  // Split: neck 40%, head 60%.
  // NOTICE: use copy() not multiply() — idle animation may not reset head/neck each frame,
  // so multiply() would accumulate infinitely. Same approach as hand-tracker.vue.
  if (neckBone) {
    _htr.splitQ.identity().slerp(_htr.fullQ, 0.4)
    neckBone.quaternion.copy(_htr.splitQ)
    _htr.splitQ.identity().slerp(_htr.fullQ, 0.6)
    headBone.quaternion.copy(_htr.splitQ)
  }
  else {
    headBone.quaternion.copy(_htr.fullQ)
  }
}

function buildVrmFrameHook(): VrmFrameHook {
  return (vrm: any, _delta: number) => {
    if (!headTrackingEnabled.value) {
      // Reset bones to rest when tracking is disabled so they don't freeze
      vrm.humanoid?.getNormalizedBoneNode('neck')?.quaternion.identity()
      vrm.humanoid?.getNormalizedBoneNode('head')?.quaternion.identity()
      return
    }
    applyHeadRotation(vrm, headTrackingStrength.value)
  }
}

// Register / unregister the store-level frame hook when headTrackingEnabled changes
watch(headTrackingEnabled, (enabled) => {
  modelStore.vrmFrameHook = enabled ? buildVrmFrameHook() : undefined
}, { immediate: false })

// --- RAF loop: three-phase lookAt update ---
function rafTick(now: number) {
  const dt = _prevFrameMs ? Math.min((now - _prevFrameMs) / 1000, 0.1) : 0.016
  _prevFrameMs = now

  if (handVisionStore.handDetected) {
    const alpha = 1 - Math.exp(-LERP_K * dt)
    const px = _currentLookAt.x
    const py = _currentLookAt.y
    const pz = _currentLookAt.z
    _currentLookAt.x += (_handTarget.x - _currentLookAt.x) * alpha
    _currentLookAt.y += (_handTarget.y - _currentLookAt.y) * alpha
    _currentLookAt.z += (_handTarget.z - _currentLookAt.z) * alpha
    _vel.x = (_currentLookAt.x - px) / dt
    _vel.y = (_currentLookAt.y - py) / dt
    _vel.z = (_currentLookAt.z - pz) / dt
  }
  else if (now - _lastHandSeenMs < HAND_HOLD_MS) {
    _currentLookAt.x += _vel.x * dt
    _currentLookAt.y += _vel.y * dt
    _currentLookAt.z += _vel.z * dt
    const decelAlpha = 1 - Math.exp(-DECEL_K * dt)
    _vel.x *= (1 - decelAlpha)
    _vel.y *= (1 - decelAlpha)
    _vel.z *= (1 - decelAlpha)
  }
  else {
    _vel.x = 0
    _vel.y = 0
    _vel.z = 0
    const alpha = 1 - Math.exp(-LERP_K * dt)
    _currentLookAt.x += (0 - _currentLookAt.x) * alpha
    _currentLookAt.y += (eyeHeight.value - _currentLookAt.y) * alpha
    _currentLookAt.z += (-100 - _currentLookAt.z) * alpha
  }

  // Only write lookAtTarget when gaze mode is active
  if (gazeEnabled.value) {
    lookAtTarget.value.x = _currentLookAt.x
    lookAtTarget.value.y = _currentLookAt.y
    lookAtTarget.value.z = _currentLookAt.z
  }

  _rafId = requestAnimationFrame(rafTick)
}

// --- MediaPipe perception callback ---
function onPerception(state: PerceptionState) {
  const hand = state.hands?.[0] ?? null
  const raised = hand !== null && isArmRaised(hand, state.pose)

  if (raised) {
    const now = Date.now()
    _lastHandSeenMs = now
    _handTarget = handNdcToWorld(hand.landmarks2d[0].x, hand.landmarks2d[0].y)

    // Update detection state and raise timestamp
    handVisionStore.onHandRaised()

    // Attempt duration-based trigger (checks threshold internally)
    handVisionStore.tryTriggerByDuration(now)

    // Feed gesture state machine for open→close detection
    const openness = computeOpenness(hand.landmarks2d)
    handVisionStore.handOpenness = openness
    gestureSM.process(openness)
  }
  else {
    handVisionStore.onHandLost()
    handVisionStore.handOpenness = 0
    handVisionStore.handIsOpen = false
    gestureSM.reset()
  }
}

// --- Camera / pipeline lifecycle ---
async function startPipeline() {
  if (!videoRef.value || engine)
    return
  const backend = createMediaPipeBackend()
  engine = createMocapEngine(backend, toRaw(config))
  await engine.init()
  engine.start(
    { getFrame: () => videoRef.value as HTMLVideoElement },
    onPerception,
    {
      onError: (err) => {
        if (Date.now() < ignoreErrorsUntil)
          return
        console.warn('[HandGazeFeature] pipeline error:', errorMessageFrom(err))
        stopAll()
      },
    },
  )
}

async function startCamera() {
  if (status.value === 'starting' || status.value === 'running')
    return
  status.value = 'starting'
  handVisionStore.cameraStatus = 'starting'
  handVisionStore.cameraError = ''
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
    if (!videoRef.value)
      throw new Error('video element not mounted')
    videoRef.value.srcObject = stream
    await videoRef.value.play()
    status.value = 'running'
    handVisionStore.cameraStatus = 'running'
    await startPipeline()
  }
  catch (err) {
    status.value = 'error'
    handVisionStore.cameraStatus = 'error'
    handVisionStore.cameraError = errorMessageFrom(err) ?? 'Failed to start camera'
    console.warn('[HandGazeFeature] failed to start camera:', handVisionStore.cameraError)
  }
}

function stopAll() {
  ignoreErrorsUntil = Date.now() + 1500
  engine?.stop()
  engine = undefined
  handVisionStore.onHandLost()
  try {
    stream?.getTracks().forEach(t => t.stop())
  }
  catch {}
  stream = undefined
  if (videoRef.value)
    videoRef.value.srcObject = null
  status.value = 'idle'
  handVisionStore.cameraStatus = 'idle'
  handVisionStore.cameraError = ''
}

onMounted(() => {
  // Disable built-in VRM tracking so we can drive lookAtTarget ourselves
  savedTrackingMode = trackingMode.value
  trackingMode.value = 'none'

  // Sync lerp state with current store value
  _currentLookAt = { ...lookAtTarget.value }
  _handTarget = { x: 0, y: eyeHeight.value, z: -100 }

  // Install head bone hook if head tracking is already enabled
  if (headTrackingEnabled.value)
    modelStore.vrmFrameHook = buildVrmFrameHook()

  _rafId = requestAnimationFrame(rafTick)
  startCamera()
})

onUnmounted(() => {
  stopAll()
  if (_rafId !== undefined) {
    cancelAnimationFrame(_rafId)
    _rafId = undefined
  }
  // Clear the global frame hook so the VRM resets to idle animation control
  modelStore.vrmFrameHook = undefined
  // Restore original tracking mode so the normal eye-tracking resumes
  if (savedTrackingMode !== undefined) {
    trackingMode.value = savedTrackingMode
    savedTrackingMode = undefined
  }
  // Reset lookAt to neutral so eyes don't freeze at the last hand position
  lookAtTarget.value = { x: 0, y: eyeHeight.value, z: -100 }
})

// Suppress unused import warnings from three.js (raycaster vars reserved for future camera upgrade)
void _raycaster
void _mouse
void _plane
void _hit
void _dirWs
</script>

<template>
  <!-- Hidden video element used solely for hand/pose detection; never shown to the user. -->
  <video ref="videoRef" style="display:none" muted playsinline />
</template>
