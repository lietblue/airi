<script setup lang="ts">
import type { createVrmPoseApplier, PerceptionState } from '@proj-airi/model-driver-mediapipe'

import { createMocapEngine, createWorkerBackend } from '@proj-airi/model-driver-mediapipe'
import { ThreeScene, useModelStore } from '@proj-airi/stage-ui-three'
import { animations } from '@proj-airi/stage-ui-three/assets/vrm'
import { useSettings } from '@proj-airi/stage-ui/stores/settings'
import { computeOpenness, createGestureStateMachine } from '@proj-airi/stage-ui/utils/hand-gesture'
import { storeToRefs } from 'pinia'
import { Euler, Plane, Quaternion, Raycaster, Vector2, Vector3 } from 'three'
import { onMounted, onUnmounted, ref, toRaw, watch } from 'vue'

// Derive VRM type without importing @pixiv/three-vrm directly (not a direct dep of stage-web)
type VrmType = Parameters<ReturnType<typeof createVrmPoseApplier>['applyPoseTargetsToVrm']>[0]

// --- Status ---
const status = ref<'idle' | 'starting' | 'running' | 'error'>('idle')
const errorMessage = ref('')
const pipelineEnabled = ref(true)
const ignoreErrorsUntil = ref(0)

// --- DOM refs ---
const videoRef = ref<HTMLVideoElement>()
const canvasRef = ref<HTMLCanvasElement>()
const sceneRef = ref<InstanceType<typeof ThreeScene>>()

// --- Stream & engine ---
let stream: MediaStream | undefined
let engine: ReturnType<typeof createMocapEngine> | undefined

// Pose is enabled alongside hands so we can check elbow Y to detect raised arms
const config = ref({
  enabled: { pose: true, hands: true, face: false },
  hz: { pose: 30, hands: 30, face: 30 },
  maxPeople: 1 as const,
})

// --- Settings store (VRM model selection) ---
const settingsStore = useSettings()
const { stageModelRenderer, stageModelSelected, stageModelSelectedUrl } = storeToRefs(settingsStore)

// --- Model store (lookAt + tracking mode) ---
const modelStore = useModelStore()
const { lookAtTarget, eyeHeight, trackingMode } = storeToRefs(modelStore)
let savedTrackingMode: string | undefined

// --- Head tracking controls ---
// 'eyes': only move eyes (default lookAt); 'head': only rotate head/neck bones; 'both': both
const headMode = ref<'eyes' | 'head' | 'both'>('both')
// How far the head turns toward the target (0 = no movement, 1 = full range)
const headStrength = ref(0.3)

// Pre-allocated reusables for the per-frame head rotation hook (avoids GC pressure)
const _htr = {
  modelQ: new Quaternion(),
  invQ: new Quaternion(),
  dir: new Vector3(),
  fullQ: new Quaternion(),
  splitQ: new Quaternion(),
  euler: new Euler(0, 0, 0, 'YXZ'),
}

// Whether to invert tracking axes (configurable because camera placement varies)
const invertX = ref(false)
const invertY = ref(true) // Y is inverted relative to image-space by default; toggling corrects it

// When true, only activate tracking + gestures when the hand's arm is raised
// (wrist above the elbow in image space, using MediaPipe Pose landmarks).
// Falls back to "allow" when pose data is unavailable or visibility is too low.
const requireArmRaised = ref(true)

// How long to hold the last known hand position after tracking drops out before
// lerping back to the default gaze direction (avoids snapping on brief occlusions)
const HAND_HOLD_MS = 600
let _lastHandSeenMs = 0

// --- Hand tracking state ---
const handDetected = ref(false) // hand is tracked (arm raised, gestures active)
const handInFrame = ref(false) // hand is anywhere in frame (even when arm not raised)
const handIsOpen = ref(false)
const handOpenness = ref(0)

// --- Command buttons ---
// Three gesture-triggered indicators that glow when their gesture fires
const commands = ref([
  { label: '张合', sublabel: 'Single Open/Close', active: false },
  { label: '快速双张合', sublabel: 'Quick ×2', active: false },
  { label: '慢速双张开', sublabel: 'Slow Open ×2', active: false },
])
const cmdTimers: (ReturnType<typeof setTimeout> | undefined)[] = [undefined, undefined, undefined]

function activate(idx: number) {
  commands.value[idx].active = true
  clearTimeout(cmdTimers[idx])
  cmdTimers[idx] = setTimeout(() => {
    commands.value[idx].active = false
  }, 1800)
}

// --- Gesture state machine (uses shared utility) ---
// The devtools page tracks additional compound gestures (quick double clap, slow double open)
// on top of the basic open/close detection from the shared utility.
let recentClapTimes: number[] = []
let recentOpenTimes: number[] = []
let pendingClapTimer: ReturnType<typeof setTimeout> | undefined

const QUICK_DOUBLE_MS = 700 // two claps within this window = quick double
const SLOW_OPEN_MIN_MS = 800 // slow double open: gap must be at least this
const SLOW_OPEN_MAX_MS = 3500 // ...and at most this

function onHandOpen() {
  const now = Date.now()
  // Look for a prior open event in the slow-double window
  const prior = recentOpenTimes.findIndex(
    t => now - t >= SLOW_OPEN_MIN_MS && now - t <= SLOW_OPEN_MAX_MS,
  )
  if (prior !== -1) {
    activate(2) // Command 3: slow double open
    recentOpenTimes = []
  }
  else {
    // Keep only events within the max window
    recentOpenTimes = [...recentOpenTimes.filter(t => now - t < SLOW_OPEN_MAX_MS + 500), now]
  }
}

function onHandClap() {
  const now = Date.now()
  recentClapTimes = [...recentClapTimes.filter(t => now - t < 2000), now]
  clearTimeout(pendingClapTimer)

  // Check if there is a prior clap within the quick-double window
  const hasQuickPrior = recentClapTimes.some(
    t => t !== now && now - t < QUICK_DOUBLE_MS,
  )
  if (hasQuickPrior) {
    activate(1) // Command 2: quick double clap
    recentClapTimes = []
    pendingClapTimer = undefined
  }
  else {
    // Wait before confirming single clap in case a second comes soon
    pendingClapTimer = setTimeout(() => {
      activate(0) // Command 1: single clap confirmed
      recentClapTimes = []
    }, QUICK_DOUBLE_MS)
  }
}

const gestureSM = createGestureStateMachine({
  onOpen: () => {
    handIsOpen.value = true
    onHandOpen()
  },
  onClose: () => {
    handIsOpen.value = false
    onHandClap()
  },
})

// --- Project 2D hand position to 3D lookAt world space ---
// Mirrors the lookAtMouse() logic inside VRMModel.vue (packages/stage-ui-three).
// nx, ny are MediaPipe normalized coords [0,1]; y increases downward.
const _raycaster = new Raycaster()
const _mouse = new Vector2()
const _plane = new Plane()
const _hit = new Vector3()
const _dir = new Vector3()

function handNdcToWorld(nx: number, ny: number): { x: number, y: number, z: number } {
  const cam = sceneRef.value?.camera()
  // sx/sy: ±1 sign multipliers that combine the axis-invert prefs with the baseline
  // mirror flip needed for a front-facing camera (x must be negated; y is image→NDC).
  const sx = invertX.value ? 1 : -1
  const sy = invertY.value ? 1 : -1
  if (!cam) {
    // Fallback before the 3D scene is ready
    return {
      x: sx * (nx - 0.5) * 1.0,
      y: eyeHeight.value + sy * (0.5 - ny) * 0.5,
      z: 0,
    }
  }
  // Map MediaPipe [0,1] coords to NDC [-1,1], applying invert prefs
  _mouse.x = sx * (nx * 2 - 1)
  _mouse.y = sy * (ny * 2 - 1)
  _raycaster.setFromCamera(_mouse, cam)
  cam.getWorldDirection(_dir)
  _plane.setFromNormalAndCoplanarPoint(_dir, cam.position.clone().addScaledVector(_dir, 1))
  const hit = _raycaster.ray.intersectPlane(_plane, _hit)
  if (!hit)
    return { x: 0, y: eyeHeight.value, z: -100 }
  return { x: _hit.x, y: _hit.y, z: _hit.z }
}

// --- Smooth lookAt lerp state (declared here so applyHeadRotation can reference it) ---
// We write directly into modelStore.lookAtTarget each frame; the reactive chain
// propagates to ThreeScene → VRMModel → VRM.lookAt.target automatically.
let _currentLookAt = { x: 0, y: 0, z: -100 }
let _handTarget = { x: 0, y: 0, z: -100 }
// Velocity of _currentLookAt in world units/sec; used to coast smoothly after tracking loss
let _vel = { x: 0, y: 0, z: 0 }
let _prevFrameMs = 0
let _rafId: number | undefined
// NOTICE: exponential lerp coefficient — higher values yield snappier eye tracking
const LERP_K = 12
// NOTICE: velocity decay coefficient during coast phase — 1/DECEL_K ≈ seconds to coast to rest
const DECEL_K = 4

// --- Head bone rotation (applied per frame via vrmFrameHook) ---
// Rotates the neck (40%) and head (60%) bones toward _currentLookAt.
// The rotation is computed in normalized VRM space by un-rotating world-space direction
// through the model's own world quaternion, so it's correct regardless of model rotation.
const MAX_HEAD_YAW = Math.PI / 3 // 60° horizontal
const MAX_HEAD_PITCH = Math.PI / 5 // 36° vertical

function applyHeadRotation(vrm: VrmType, strength: number) {
  const headBone = vrm.humanoid?.getNormalizedBoneNode('head')
  const neckBone = vrm.humanoid?.getNormalizedBoneNode('neck')
  if (!headBone)
    return

  // Get the direction from the model's eye level to the target in world space
  _htr.dir.set(_currentLookAt.x, _currentLookAt.y - eyeHeight.value, _currentLookAt.z)
  if (_htr.dir.lengthSq() < 1e-10)
    return

  _htr.dir.normalize()

  // Transform direction to normalized VRM model space so yaw/pitch are in the right frame.
  // In normalized VRM space the character's forward is +Z, left is +X.
  vrm.scene.getWorldQuaternion(_htr.modelQ)
  _htr.invQ.copy(_htr.modelQ).invert()
  _htr.dir.applyQuaternion(_htr.invQ)

  const hDist = Math.sqrt(_htr.dir.x * _htr.dir.x + _htr.dir.z * _htr.dir.z)
  // NOTICE: invModelQ is a 180° Y rotation, so a world direction toward the camera
  // becomes dir.z ≈ −1 in model space. Using atan2(dir.x, dir.z) puts the reference
  // in the atan2(*, negative) quadrant whose discontinuity sits at ±π — right where
  // the hand crosses center. Negate both axes to anchor the reference to +Z (≡ −Z
  // world = actual visual forward), making the discontinuity unreachable in practice.
  const yaw = Math.atan2(-_htr.dir.x, -_htr.dir.z)
  // Negative pitch: positive dir.y means target is above → head tilts up → negative X rotation
  const pitch = -Math.atan2(_htr.dir.y, Math.max(hDist, 0.001))

  const sy = Math.max(-MAX_HEAD_YAW, Math.min(MAX_HEAD_YAW, yaw)) * strength
  const sp = Math.max(-MAX_HEAD_PITCH, Math.min(MAX_HEAD_PITCH, pitch)) * strength

  _htr.euler.set(sp, sy, 0, 'YXZ')
  _htr.fullQ.setFromEuler(_htr.euler)

  // Split the rotation: neck carries 40%, head carries 60%.
  // NOTICE: use copy() not multiply() — the idle animation may not drive head/neck bones,
  // so their quaternions are NOT reset each frame; multiply() would accumulate infinitely.
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

function vrmHeadHook(vrm: VrmType, _delta: number) {
  if (headMode.value === 'eyes') {
    // Reset neck/head to rest pose so a prior head-mode tracking offset doesn't persist
    vrm.humanoid?.getNormalizedBoneNode('neck')?.quaternion.identity()
    vrm.humanoid?.getNormalizedBoneNode('head')?.quaternion.identity()
    return
  }
  applyHeadRotation(vrm, headStrength.value)
}

function rafTick(now: number) {
  const dt = _prevFrameMs ? Math.min((now - _prevFrameMs) / 1000, 0.1) : 0.016
  _prevFrameMs = now

  if (handDetected.value) {
    // --- Phase 1: active tracking — exponential lerp toward hand position ---
    const alpha = 1 - Math.exp(-LERP_K * dt)
    const px = _currentLookAt.x
    const py = _currentLookAt.y
    const pz = _currentLookAt.z
    _currentLookAt.x += (_handTarget.x - _currentLookAt.x) * alpha
    _currentLookAt.y += (_handTarget.y - _currentLookAt.y) * alpha
    _currentLookAt.z += (_handTarget.z - _currentLookAt.z) * alpha
    // Record the frame velocity so we can coast with it after tracking is lost
    _vel.x = (_currentLookAt.x - px) / dt
    _vel.y = (_currentLookAt.y - py) / dt
    _vel.z = (_currentLookAt.z - pz) / dt
  }
  else if (now - _lastHandSeenMs < HAND_HOLD_MS) {
    // --- Phase 2: coast — apply last velocity then exponentially decay it ---
    // This gives the head natural momentum instead of freezing on tracking loss.
    _currentLookAt.x += _vel.x * dt
    _currentLookAt.y += _vel.y * dt
    _currentLookAt.z += _vel.z * dt
    const decelAlpha = 1 - Math.exp(-DECEL_K * dt)
    _vel.x *= (1 - decelAlpha)
    _vel.y *= (1 - decelAlpha)
    _vel.z *= (1 - decelAlpha)
  }
  else {
    // --- Phase 3: return — lerp smoothly back to the neutral gaze direction ---
    _vel.x = 0
    _vel.y = 0
    _vel.z = 0
    const alpha = 1 - Math.exp(-LERP_K * dt)
    _currentLookAt.x += (0 - _currentLookAt.x) * alpha
    _currentLookAt.y += (eyeHeight.value - _currentLookAt.y) * alpha
    _currentLookAt.z += (-100 - _currentLookAt.z) * alpha
  }

  // Only drive VRM's built-in eye lookAt system when eyes are active
  if (headMode.value !== 'head') {
    lookAtTarget.value.x = _currentLookAt.x
    lookAtTarget.value.y = _currentLookAt.y
    lookAtTarget.value.z = _currentLookAt.z
  }

  _rafId = requestAnimationFrame(rafTick)
}

// --- Canvas skeleton overlay ---
// Connections taken from the MediaPipe hand landmark topology
const HAND_CONNECTIONS: [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4], // thumb
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8], // index
  [0, 9],
  [9, 10],
  [10, 11],
  [11, 12], // middle
  [0, 13],
  [13, 14],
  [14, 15],
  [15, 16], // ring
  [0, 17],
  [17, 18],
  [18, 19],
  [19, 20], // pinky
  [5, 9],
  [9, 13],
  [13, 17], // palm arch
]

function drawHandOverlay(state: PerceptionState) {
  const canvas = canvasRef.value
  const video = videoRef.value
  if (!canvas || !video)
    return
  const w = video.videoWidth || 640
  const h = video.videoHeight || 480
  if (canvas.width !== w)
    canvas.width = w
  if (canvas.height !== h)
    canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx)
    return
  ctx.clearRect(0, 0, w, h)

  // Draw elbow + shoulder landmarks from pose so the user can see the raise boundary
  const poseLm = state.pose?.landmarks2d
  if (poseLm) {
    // left: shoulder=11,elbow=13 / right: shoulder=12,elbow=14
    for (const [shoulderIdx, elbowIdx] of [[11, 13], [12, 14]] as const) {
      const shoulder = poseLm[shoulderIdx]
      const elbow = poseLm[elbowIdx]
      if (!shoulder || !elbow)
        continue
      const MIN_VIS = 0.3
      const vis = Math.min(shoulder.visibility ?? 1, elbow.visibility ?? 1)
      if (vis < MIN_VIS)
        continue
      const alpha = Math.max(0.3, vis)
      // Line: shoulder → elbow
      ctx.strokeStyle = `rgba(251, 191, 36, ${alpha * 0.7})`
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(shoulder.x * w, shoulder.y * h)
      ctx.lineTo(elbow.x * w, elbow.y * h)
      ctx.stroke()
      // Elbow dot (amber = reference point for the raise check)
      ctx.beginPath()
      ctx.arc(elbow.x * w, elbow.y * h, 5, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(251, 191, 36, ${alpha})`
      ctx.fill()
    }
  }

  for (const hand of (state.hands ?? [])) {
    const lm = hand.landmarks2d
    // Dim the skeleton when the arm is not raised
    const raised = isArmRaised(hand, state.pose)
    ctx.strokeStyle = raised ? '#34d399' : 'rgba(52, 211, 153, 0.3)'
    ctx.lineWidth = 2
    for (const [a, b] of HAND_CONNECTIONS) {
      if (!lm[a] || !lm[b])
        continue
      ctx.beginPath()
      ctx.moveTo(lm[a].x * w, lm[a].y * h)
      ctx.lineTo(lm[b].x * w, lm[b].y * h)
      ctx.stroke()
    }
    for (let i = 0; i < lm.length; i++) {
      ctx.beginPath()
      ctx.arc(lm[i].x * w, lm[i].y * h, i === 0 ? 5 : 3, 0, Math.PI * 2)
      // Wrist in amber, fingertips in white, other joints slightly dimmed; all faded if below threshold
      ctx.fillStyle = raised
        ? (i === 0 ? '#f59e0b' : [4, 8, 12, 16, 20].includes(i) ? '#ffffff' : '#d1d5db')
        : (i === 0 ? 'rgba(245,158,11,0.3)' : 'rgba(209,213,219,0.3)')
      ctx.fill()
    }
  }
}

// --- Arm-raised detection using MediaPipe Pose elbow landmarks ---
// MediaPipe Pose indices (from person's perspective, matching HandState.handedness):
//   left shoulder=11, left elbow=13 / right shoulder=12, right elbow=14
// In image-space y increases downward, so wrist.y < elbow.y means the wrist is
// higher on screen (arm raised). Falls back to true when pose data is missing or
// landmark visibility is too low to trust.
function isArmRaised(hand: NonNullable<PerceptionState['hands']>[number], pose: PerceptionState['pose']): boolean {
  if (!requireArmRaised.value)
    return true
  const lm = pose?.landmarks2d
  if (!lm)
    return true // no pose data available → fail open
  const elbowIdx = hand.handedness === 'Left' ? 13 : 14
  const elbow = lm[elbowIdx]
  if (!elbow)
    return true
  // NOTICE: NormalizedLandmark.visibility is optional and may be undefined on some backends
  const MIN_VIS = 0.3
  if (elbow.visibility != null && elbow.visibility < MIN_VIS)
    return true // landmark not visible enough → fail open
  const wrist = hand.landmarks2d[0] // hand wrist landmark
  return wrist.y < elbow.y // wrist higher (smaller y) = arm is raised
}

// --- MediaPipe perception callback ---
function onPerception(state: PerceptionState) {
  const hands = state.hands ?? []
  const hand = hands[0] ?? null
  handInFrame.value = hand != null

  // Only activate tracking and gesture detection when the arm is raised
  const raised = hand != null && isArmRaised(hand, state.pose)
  handDetected.value = raised

  if (raised) {
    _lastHandSeenMs = Date.now()
    const lm = hand.landmarks2d
    // Use wrist (landmark 0) as the gaze anchor point
    _handTarget = handNdcToWorld(lm[0].x, lm[0].y)
    const openness = computeOpenness(lm)
    handOpenness.value = openness
    gestureSM.process(openness)
  }
  else {
    gestureSM.reset()
  }

  drawHandOverlay(state)
}

// --- Camera / pipeline lifecycle (mirrors model-driver-mediapipe.vue) ---
async function startCamera() {
  if (status.value === 'starting' || status.value === 'running')
    return
  status.value = 'starting'
  errorMessage.value = ''
  try {
    stopAll()
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
    if (!videoRef.value)
      throw new Error('video element not mounted')
    videoRef.value.srcObject = stream
    await videoRef.value.play()
    status.value = 'running'
    await startPipeline()
  }
  catch (err) {
    status.value = 'error'
    errorMessage.value = err instanceof Error ? err.message : String(err)
    pipelineEnabled.value = false
  }
}

async function startPipeline() {
  if (!videoRef.value || engine)
    return
  const backend = createWorkerBackend()
  engine = createMocapEngine(backend, toRaw(config.value))
  await engine.init()
  engine.start(
    { getFrame: () => videoRef.value as HTMLVideoElement },
    onPerception,
    {
      onError: (err) => {
        if (!pipelineEnabled.value || Date.now() < ignoreErrorsUntil.value)
          return
        errorMessage.value = err instanceof Error ? err.message : String(err)
        stopAll()
        status.value = 'error'
      },
    },
  )
}

function stopAll() {
  ignoreErrorsUntil.value = Date.now() + 1500
  canvasRef.value?.getContext('2d')?.clearRect(0, 0, canvasRef.value.width, canvasRef.value.height)
  engine?.dispose()
  engine = undefined
  handDetected.value = false
  try {
    stream?.getTracks().forEach(t => t.stop())
  }
  catch {}
  stream = undefined
  if (videoRef.value)
    videoRef.value.srcObject = null
  status.value = 'idle'
}

watch(pipelineEnabled, async (enabled) => {
  if (enabled)
    await startCamera()
  else
    stopAll()
})

// Register / unregister the head bone hook whenever the ThreeScene mounts or remounts
watch(sceneRef, (scene, prev) => {
  prev?.setVrmFrameHook(undefined)
  scene?.setVrmFrameHook(vrmHeadHook)
}, { immediate: true })

// When switching to head-only mode, reset lookAtTarget so eyes look straight forward
watch(headMode, (mode) => {
  if (mode === 'head') {
    const y = eyeHeight.value
    lookAtTarget.value = { x: 0, y, z: -100 }
    _currentLookAt = { x: 0, y, z: -100 }
    _vel = { x: 0, y: 0, z: 0 }
  }
})

onMounted(() => {
  // Ensure a VRM model is selected
  const needsFallback = !stageModelSelectedUrl.value || stageModelRenderer.value !== 'vrm'
  if (needsFallback)
    stageModelSelected.value = 'preset-vrm-1'
  settingsStore.updateStageModel().catch(console.error)

  // Disable built-in tracking so we can drive lookAtTarget ourselves
  savedTrackingMode = trackingMode.value
  trackingMode.value = 'none'

  // Sync lerp state with current store value
  _currentLookAt = { ...lookAtTarget.value }
  _handTarget = { x: 0, y: eyeHeight.value, z: -100 }

  _rafId = requestAnimationFrame(rafTick)

  if (pipelineEnabled.value)
    startCamera()
})

onUnmounted(() => {
  sceneRef.value?.setVrmFrameHook(undefined)
  stopAll()
  if (_rafId !== undefined)
    cancelAnimationFrame(_rafId)
  clearTimeout(pendingClapTimer)
  cmdTimers.forEach(t => clearTimeout(t))
  // Restore the user's previous tracking mode
  if (savedTrackingMode !== undefined)
    trackingMode.value = savedTrackingMode as 'camera' | 'mouse' | 'none'
})
</script>

<template>
  <div :class="['p-4', 'space-y-4']">
    <!-- Title -->
    <div>
      <div :class="['text-lg', 'font-600']">
        Hand Tracker — 手势控制
      </div>
      <div :class="['text-xs', 'text-neutral-500', 'mt-0.5']">
        VRM look-at follows your hand. Open/close triggers gesture commands.
      </div>
    </div>

    <!-- Head / eye tracking controls -->
    <div :class="['rounded-2xl', 'border', 'border-neutral-300/40', 'dark:border-neutral-700/40', 'p-3', 'space-y-3']">
      <div :class="['font-600', 'text-sm']">
        Tracking Mode
      </div>
      <div :class="['flex', 'flex-wrap', 'items-center', 'gap-4']">
        <!-- Mode selector -->
        <div :class="['flex', 'items-center', 'gap-1', 'rounded-xl', 'border', 'border-neutral-300/40', 'dark:border-neutral-700/40', 'p-1']">
          <button
            v-for="opt in (['eyes', 'head', 'both'] as const)"
            :key="opt"
            :class="[
              'rounded-lg', 'px-3', 'py-1', 'text-sm', 'transition-all', 'duration-150',
              headMode === opt
                ? ['bg-neutral-200', 'dark:bg-neutral-700', 'font-600']
                : ['text-neutral-500', 'hover:text-neutral-700', 'dark:hover:text-neutral-300'],
            ]"
            @click="headMode = opt"
          >
            {{ opt === 'eyes' ? 'Eyes only' : opt === 'head' ? 'Head only' : 'Both' }}
          </button>
        </div>

        <!-- Head strength slider (shown when head is active) -->
        <template v-if="headMode !== 'eyes'">
          <div :class="['flex', 'items-center', 'gap-2', 'flex-1', 'min-w-48']">
            <span :class="['text-sm', 'text-neutral-500', 'shrink-0']">Head strength</span>
            <input
              v-model.number="headStrength"
              type="range"
              min="0"
              max="1"
              step="0.05"
              :class="['flex-1', 'cursor-pointer']"
            >
            <span :class="['text-sm', 'text-neutral-500', 'w-10', 'text-right', 'shrink-0']">
              {{ (headStrength * 100).toFixed(0) }}%
            </span>
          </div>
        </template>
      </div>

      <!-- Axis invert + height threshold row -->
      <div :class="['flex', 'flex-wrap', 'items-center', 'gap-4', 'pt-1', 'border-t', 'border-neutral-200/40', 'dark:border-neutral-700/40']">
        <!-- Invert toggles -->
        <div :class="['flex', 'items-center', 'gap-3']">
          <span :class="['text-sm', 'text-neutral-500', 'shrink-0']">Invert</span>
          <label :class="['flex', 'items-center', 'gap-1.5', 'text-sm', 'cursor-pointer']">
            <input v-model="invertX" type="checkbox" :class="['cursor-pointer']">
            X
          </label>
          <label :class="['flex', 'items-center', 'gap-1.5', 'text-sm', 'cursor-pointer']">
            <input v-model="invertY" type="checkbox" :class="['cursor-pointer']">
            Y
          </label>
        </div>

        <!-- Require arm raised toggle -->
        <label :class="['flex', 'items-center', 'gap-2', 'text-sm', 'cursor-pointer']">
          <input v-model="requireArmRaised" type="checkbox" :class="['cursor-pointer']">
          <span :class="['text-neutral-600', 'dark:text-neutral-300']">Require arm raised</span>
          <span :class="['text-xs', 'text-neutral-400']">(wrist above elbow)</span>
        </label>
      </div>
    </div>

    <!-- Command indicators -->
    <div :class="['grid', 'grid-cols-3', 'gap-3']">
      <!-- Command 0: single open/close (amber) -->
      <div
        :class="[
          'rounded-2xl', 'border', 'p-4', 'text-center', 'transition-all', 'duration-300',
          commands[0].active
            ? ['border-amber-400/80', 'bg-amber-400/10', 'shadow-lg', 'shadow-amber-500/20']
            : ['border-neutral-300/40', 'dark:border-neutral-700/40'],
        ]"
      >
        <div :class="['font-600', 'text-sm', commands[0].active ? 'text-amber-500' : '']">
          {{ commands[0].label }}
        </div>
        <div :class="['text-xs', 'text-neutral-500', 'mt-0.5']">
          {{ commands[0].sublabel }}
        </div>
        <div
          :class="[
            'mt-3', 'h-2.5', 'w-2.5', 'rounded-full', 'mx-auto', 'transition-all', 'duration-200',
            commands[0].active
              ? ['bg-amber-400', 'shadow-[0_0_10px_2px]', 'shadow-amber-400/60']
              : ['bg-neutral-300', 'dark:bg-neutral-600'],
          ]"
        />
      </div>

      <!-- Command 1: quick double clap (sky) -->
      <div
        :class="[
          'rounded-2xl', 'border', 'p-4', 'text-center', 'transition-all', 'duration-300',
          commands[1].active
            ? ['border-sky-400/80', 'bg-sky-400/10', 'shadow-lg', 'shadow-sky-500/20']
            : ['border-neutral-300/40', 'dark:border-neutral-700/40'],
        ]"
      >
        <div :class="['font-600', 'text-sm', commands[1].active ? 'text-sky-500' : '']">
          {{ commands[1].label }}
        </div>
        <div :class="['text-xs', 'text-neutral-500', 'mt-0.5']">
          {{ commands[1].sublabel }}
        </div>
        <div
          :class="[
            'mt-3', 'h-2.5', 'w-2.5', 'rounded-full', 'mx-auto', 'transition-all', 'duration-200',
            commands[1].active
              ? ['bg-sky-400', 'shadow-[0_0_10px_2px]', 'shadow-sky-400/60']
              : ['bg-neutral-300', 'dark:bg-neutral-600'],
          ]"
        />
      </div>

      <!-- Command 2: slow double open (emerald) -->
      <div
        :class="[
          'rounded-2xl', 'border', 'p-4', 'text-center', 'transition-all', 'duration-300',
          commands[2].active
            ? ['border-emerald-400/80', 'bg-emerald-400/10', 'shadow-lg', 'shadow-emerald-500/20']
            : ['border-neutral-300/40', 'dark:border-neutral-700/40'],
        ]"
      >
        <div :class="['font-600', 'text-sm', commands[2].active ? 'text-emerald-500' : '']">
          {{ commands[2].label }}
        </div>
        <div :class="['text-xs', 'text-neutral-500', 'mt-0.5']">
          {{ commands[2].sublabel }}
        </div>
        <div
          :class="[
            'mt-3', 'h-2.5', 'w-2.5', 'rounded-full', 'mx-auto', 'transition-all', 'duration-200',
            commands[2].active
              ? ['bg-emerald-400', 'shadow-[0_0_10px_2px]', 'shadow-emerald-400/60']
              : ['bg-neutral-300', 'dark:bg-neutral-600'],
          ]"
        />
      </div>
    </div>

    <!-- Status bar -->
    <div :class="['flex', 'items-center', 'justify-between', 'gap-3']">
      <div :class="['flex', 'items-center', 'gap-2', 'text-sm', 'text-neutral-500']">
        <!-- Green = tracking active, amber = in frame but below threshold, grey = no hand -->
        <span
          :class="[
            'inline-block', 'h-2', 'w-2', 'rounded-full', 'transition-colors',
            handDetected ? 'bg-green-400' : handInFrame ? 'bg-amber-400' : 'bg-neutral-400',
          ]"
        />
        <span>
          {{ handDetected ? 'Tracking' : handInFrame ? 'In frame (below threshold)' : 'No hand' }}
        </span>
        <template v-if="handDetected">
          <span>|</span>
          <span>{{ handIsOpen ? 'Open' : 'Closed' }}</span>
          <span :class="['text-xs']">({{ (handOpenness * 100).toFixed(0) }}%)</span>
        </template>
      </div>

      <label :class="['flex', 'items-center', 'gap-2', 'text-sm', 'text-neutral-600', 'dark:text-neutral-300', 'cursor-pointer']">
        <span>{{ pipelineEnabled ? 'Running' : 'Stopped' }}</span>
        <input v-model="pipelineEnabled" type="checkbox" :class="['cursor-pointer']">
      </label>
    </div>

    <!-- Camera feed + VRM scene -->
    <div :class="['grid', 'gap-4', 'lg:grid-cols-2']">
      <!-- Camera feed with hand skeleton overlay -->
      <div :class="['rounded-2xl', 'border', 'border-neutral-300/40', 'dark:border-neutral-700/40', 'overflow-hidden']">
        <div :class="['relative', 'aspect-video', 'bg-black']">
          <video
            ref="videoRef"
            muted
            playsinline
            :class="['absolute', 'inset-0', 'h-full', 'w-full', 'object-cover', 'opacity-70']"
          />
          <canvas
            ref="canvasRef"
            :class="['absolute', 'inset-0', 'h-full', 'w-full', 'object-cover']"
          />
          <div
            :class="[
              'absolute', 'left-3', 'top-3',
              'rounded-lg', 'bg-black/50', 'px-2', 'py-1',
              'text-xs', 'text-white', 'backdrop-blur',
            ]"
          >
            <div>Status: {{ status }}</div>
            <div v-if="errorMessage" :class="['text-red-300']">
              {{ errorMessage }}
            </div>
          </div>
        </div>
      </div>

      <!-- VRM scene (eyes follow hand) -->
      <div :class="['rounded-2xl', 'border', 'border-neutral-300/40', 'dark:border-neutral-700/40', 'overflow-hidden']">
        <div :class="['h-full', 'min-h-80']">
          <ThreeScene
            v-if="stageModelRenderer === 'vrm'"
            ref="sceneRef"
            :model-src="stageModelSelectedUrl"
            :idle-animation="animations.idleLoop.toString()"
            :paused="false"
            @error="console.error"
          />
          <div v-else :class="['p-4', 'text-sm', 'text-red-500']">
            请选择 VRM 模型（当前模型类型不支持）。
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: plain
</route>
