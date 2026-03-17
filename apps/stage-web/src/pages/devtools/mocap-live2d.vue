<script setup lang="ts">
import type { FaceState, PerceptionState, VrmPoseTargets } from '@proj-airi/model-driver-mediapipe'
import type { Vector3Like } from 'three'

import { createMediaPipeBackend, createMocapEngine, createVrmPoseApplier, drawOverlay, poseToVrmTargets } from '@proj-airi/model-driver-mediapipe'
import { ThreeScene } from '@proj-airi/stage-ui-three'
import { animations } from '@proj-airi/stage-ui-three/assets/vrm'
import { SceneLive2D } from '@proj-airi/stage-ui/components/scenes'
import { useLive2d } from '@proj-airi/stage-ui/stores/live2d'
import { useSettings } from '@proj-airi/stage-ui/stores/settings'
import { Checkbox } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref, toRaw, watch } from 'vue'

// ── Model tab ──────────────────────────────────────────────────────────────

type ModelTab = 'vrm' | 'live2d'
const activeTab = ref<ModelTab>('live2d')

// ── Camera / pipeline state ────────────────────────────────────────────────

const status = ref<'idle' | 'starting' | 'running' | 'error'>('idle')
const errorMessage = ref('')
const pipelineEnabled = ref(true)
const syncingToggleState = ref(false)
const ignoreErrorsUntil = ref(0)

const videoRef = ref<HTMLVideoElement>()
const canvasRef = ref<HTMLCanvasElement>()
const sceneRef = ref<InstanceType<typeof ThreeScene>>()
let stream: MediaStream | undefined
let engine: ReturnType<typeof createMocapEngine> | undefined

// ── MediaPipe config ───────────────────────────────────────────────────────

const config = ref({
  enabled: {
    pose: true,
    hands: false,
    face: true,
  },
  hz: {
    pose: 30,
    hands: 30,
    face: 30,
  },
  maxPeople: 1 as const,
})

const vrmMapping = ref({
  flipX: true,
  flipY: true,
  flipZ: false,
})

const poseFiltering = ref({
  minVisibility: 0.5,
})

// Smoothing alpha: 0 = no smoothing (snap), 1 = frozen
const smoothing = ref(0.35)

// ── Perception state ────────────────────────────────────────────────────────

const latestState = ref<PerceptionState>()
const latestPoseTargets = ref<VrmPoseTargets>()
const prevPoseTargets = ref<VrmPoseTargets>()
const prevPoseForward = ref<Vector3Like>()

// ── VRM driver ─────────────────────────────────────────────────────────────

const vrmPoseApplier = createVrmPoseApplier({ alpha: 1 })

function onVrmFrame(vrm: Parameters<typeof vrmPoseApplier.applyPoseDirectionsToVrm>[0]) {
  const targets = latestPoseTargets.value
  if (!targets)
    return
  vrmPoseApplier.applyPoseTargetsToVrm(vrm, targets)
}

const vrmFrameHook = (vrm: Parameters<typeof vrmPoseApplier.applyPoseDirectionsToVrm>[0]) => onVrmFrame(vrm)

// ── Live2D driver ──────────────────────────────────────────────────────────

const live2dStore = useLive2d()
const { modelParameters } = storeToRefs(live2dStore)

/**
 * Lerps a single value toward target, respecting the smoothing alpha.
 * alpha=0 → snap immediately, alpha=1 → no change.
 */
function lerpParam(current: number, target: number): number {
  return current + (target - current) * (1 - smoothing.value)
}

/**
 * Maps MediaPipe face landmarks (478-point face mesh) to Live2D model parameters.
 *
 * Landmark index reference (FaceLandmarker):
 *   1   – nose tip
 *   10  – forehead top
 *   33  – left eye outer corner  (camera-left = character-right)
 *   133 – left eye inner corner
 *   145 – left eye lower lid
 *   152 – chin
 *   159 – left eye upper lid
 *   263 – right eye outer corner
 *   362 – right eye inner corner
 *   374 – right eye lower lid
 *   386 – right eye upper lid
 *   61  – left mouth corner
 *   13  – upper lip center
 *   14  – lower lip center
 *   291 – right mouth corner
 *   107 – left brow inner
 *   223 – left brow outer
 *   336 – right brow inner
 *   443 – right brow outer
 */
function applyFaceToLive2d(face: FaceState): void {
  const lm = face.landmarks2d
  if (!lm || lm.length < 478)
    return

  // ── Geometry helpers ──────────────────────────────────────────────────

  const noseTip = lm[1]!
  const foreheadTop = lm[10]!
  const leftEyeOuter = lm[33]!
  const leftEyeInner = lm[133]!
  const leftEyeLower = lm[145]!
  const chinTip = lm[152]!
  const leftEyeUpper = lm[159]!
  const rightEyeOuter = lm[263]!
  const rightEyeInner = lm[362]!
  const rightEyeLower = lm[374]!
  const rightEyeUpper = lm[386]!
  const leftMouthCorner = lm[61]!
  const upperLipCenter = lm[13]!
  const lowerLipCenter = lm[14]!
  const rightMouthCorner = lm[291]!
  const leftBrowInner = lm[107]!
  const leftBrowOuter = lm[223]!
  const rightBrowInner = lm[336]!
  const rightBrowOuter = lm[443]!

  // ── Normalization base lengths ─────────────────────────────────────────

  // Face width: distance between outer eye corners (robust across distances)
  const faceWidth = Math.hypot(
    rightEyeOuter.x - leftEyeOuter.x,
    rightEyeOuter.y - leftEyeOuter.y,
  )
  // Face height: forehead to chin
  const faceHeight = Math.hypot(
    foreheadTop.x - chinTip.x,
    foreheadTop.y - chinTip.y,
  )
  const eps = 1e-6

  // ── Head rotation ──────────────────────────────────────────────────────

  // Midpoint between eye outer corners ≈ horizontal face center
  const midEyeX = (leftEyeOuter.x + rightEyeOuter.x) / 2
  const midFaceY = (foreheadTop.y + chinTip.y) / 2

  // Yaw (AngleY): nose offset left/right.  Negate because camera is mirrored.
  // When character turns their right, nose moves to image-right (larger x).
  const rawYaw = -(noseTip.x - midEyeX) / (faceWidth + eps)
  const angleY = Math.max(-30, Math.min(30, rawYaw * 60))

  // Pitch (AngleX): nose offset up/down relative to face center.
  // Positive pitch = looking down; negate so positive = nodding up.
  const rawPitch = (noseTip.y - midFaceY) / (faceHeight + eps)
  const angleX = Math.max(-30, Math.min(30, -rawPitch * 40))

  // Roll (AngleZ): signed angle of the inter-eye axis.
  // Negate to match Live2D convention (right-tilt = negative).
  const eyeRollDeg = Math.atan2(
    rightEyeOuter.y - leftEyeOuter.y,
    rightEyeOuter.x - leftEyeOuter.x,
  ) * (180 / Math.PI)
  const angleZ = Math.max(-30, Math.min(30, -eyeRollDeg * 2))

  // ── Eye openness (Eye Aspect Ratio) ───────────────────────────────────

  // EAR = vertical eye span / horizontal eye span
  const leftEyeEAR = Math.abs(leftEyeUpper.y - leftEyeLower.y)
    / (Math.hypot(leftEyeInner.x - leftEyeOuter.x, leftEyeInner.y - leftEyeOuter.y) + eps)
  const rightEyeEAR = Math.abs(rightEyeUpper.y - rightEyeLower.y)
    / (Math.hypot(rightEyeInner.x - rightEyeOuter.x, rightEyeInner.y - rightEyeOuter.y) + eps)

  // Calibration: fully open EAR ≈ 0.25–0.35 for most people
  const earOpen = 0.28
  const earClosed = 0.04
  const leftEyeOpen = Math.max(0, Math.min(1, (leftEyeEAR - earClosed) / (earOpen - earClosed)))
  const rightEyeOpen = Math.max(0, Math.min(1, (rightEyeEAR - earClosed) / (earOpen - earClosed)))

  // ── Mouth openness ─────────────────────────────────────────────────────

  const mouthGap = Math.abs(upperLipCenter.y - lowerLipCenter.y) / (faceHeight + eps)
  // Typical closed: ~0.01–0.02, open: ~0.07–0.12
  const mouthOpen = Math.max(0, Math.min(1, (mouthGap - 0.01) / (0.08 - 0.01)))

  // Mouth form (smile/frown): compare corner height vs lip center midpoint.
  // Positive in Live2D = smile.  When corners are above (smaller y) the lips = smile.
  const lipMidY = (upperLipCenter.y + lowerLipCenter.y) / 2
  const cornerMidY = (leftMouthCorner.y + rightMouthCorner.y) / 2
  const rawMouthForm = (lipMidY - cornerMidY) / (faceHeight + eps)
  const mouthForm = Math.max(-1, Math.min(1, rawMouthForm * 20))

  // ── Eyebrow Y position ─────────────────────────────────────────────────

  // Compare brow mid-height to upper eyelid: raised brow = smaller y diff
  const leftBrowMidY = (leftBrowInner.y + leftBrowOuter.y) / 2
  const rightBrowMidY = (rightBrowInner.y + rightBrowOuter.y) / 2

  // Distance from brow to eye upper lid, normalized by face height.
  // Resting ≈ 0.06–0.10; raised ≈ 0.04; lowered ≈ 0.12
  const leftBrowDist = (leftEyeUpper.y - leftBrowMidY) / (faceHeight + eps)
  const rightBrowDist = (rightEyeUpper.y - rightBrowMidY) / (faceHeight + eps)
  const browRest = 0.08
  // Positive Live2D BrowY = raised; negative = lowered
  const leftEyebrowY = Math.max(-1, Math.min(1, (browRest - leftBrowDist) / 0.04))
  const rightEyebrowY = Math.max(-1, Math.min(1, (browRest - rightBrowDist) / 0.04))

  // ── Smooth & apply ────────────────────────────────────────────────────

  const p = modelParameters.value
  p.angleX = lerpParam(p.angleX, angleX)
  p.angleY = lerpParam(p.angleY, angleY)
  p.angleZ = lerpParam(p.angleZ, angleZ)
  p.leftEyeOpen = lerpParam(p.leftEyeOpen, leftEyeOpen)
  p.rightEyeOpen = lerpParam(p.rightEyeOpen, rightEyeOpen)
  p.mouthOpen = lerpParam(p.mouthOpen, mouthOpen)
  p.mouthForm = lerpParam(p.mouthForm, mouthForm)
  p.leftEyebrowY = lerpParam(p.leftEyebrowY, leftEyebrowY)
  p.rightEyebrowY = lerpParam(p.rightEyebrowY, rightEyebrowY)
}

// ── Settings store (model selection) ───────────────────────────────────────

const settingsStore = useSettings()
const { stageModelRenderer, stageModelSelected, stageModelSelectedUrl, stageViewControlsEnabled } = storeToRefs(settingsStore)

// ── Debug summary ──────────────────────────────────────────────────────────

const summary = computed(() => {
  const enabled = Object.entries(config.value.enabled)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(', ') || 'none'

  const fps = latestState.value?.quality.fps
  const latency = latestState.value?.quality.latencyMs
  const dropped = latestState.value?.quality.droppedFrames

  return [
    `enabled: ${enabled}`,
    `hz: pose ${config.value.hz.pose}, face ${config.value.hz.face}`,
    fps != null ? `fps ${fps.toFixed(1)}` : null,
    latency != null ? `latency ${latency.toFixed(1)}ms` : null,
    dropped != null ? `dropped ${dropped}` : null,
  ].filter(Boolean).join(' | ')
})

const faceDebug = computed(() => {
  const p = modelParameters.value
  return [
    `angleX ${p.angleX.toFixed(1)}`,
    `angleY ${p.angleY.toFixed(1)}`,
    `angleZ ${p.angleZ.toFixed(1)}`,
    `eyeL ${p.leftEyeOpen.toFixed(2)}`,
    `eyeR ${p.rightEyeOpen.toFixed(2)}`,
    `mouth ${p.mouthOpen.toFixed(2)}`,
  ].join(' | ')
})

// ── Camera / pipeline lifecycle ────────────────────────────────────────────

async function startCamera() {
  if (status.value === 'starting' || status.value === 'running')
    return

  status.value = 'starting'
  errorMessage.value = ''

  try {
    stop()
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

    syncingToggleState.value = true
    pipelineEnabled.value = false
    syncingToggleState.value = false
  }
}

async function startPipeline() {
  if (!videoRef.value || engine)
    return

  const backend = createMediaPipeBackend()
  engine = createMocapEngine(backend, toRaw(config.value))
  await engine.init()

  engine.start(
    { getFrame: () => videoRef.value as HTMLVideoElement },
    (state) => {
      latestState.value = state

      // ── VRM pose ────────────────────────────────────────────────────────
      const axis = {
        x: vrmMapping.value.flipX ? -1 : 1,
        y: vrmMapping.value.flipY ? -1 : 1,
        z: vrmMapping.value.flipZ ? -1 : 1,
      } as const

      const poseTargets = (config.value.enabled.pose && state.pose?.worldLandmarks?.length)
        ? poseToVrmTargets(state.pose, {
            axis,
            confidence: { minVisibility: poseFiltering.value.minVisibility },
            stabilize: {
              previousTargets: prevPoseTargets.value,
              previousForward: prevPoseForward.value,
            },
          })
        : {}

      const hasAny = Object.keys(poseTargets).length > 0
      latestPoseTargets.value = hasAny ? poseTargets : undefined
      if (hasAny) {
        prevPoseTargets.value = poseTargets
        const derivedForward = poseTargets.hips?.pole ?? poseTargets.spine?.pole
        if (derivedForward)
          prevPoseForward.value = derivedForward
      }

      // ── Live2D face ─────────────────────────────────────────────────────
      if (config.value.enabled.face && state.face?.hasFace) {
        applyFaceToLive2d(state.face)
      }

      // ── Canvas overlay ──────────────────────────────────────────────────
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
      if (ctx)
        drawOverlay(ctx, state, config.value.enabled)
    },
    {
      onError: (err) => {
        if (!pipelineEnabled.value || Date.now() < ignoreErrorsUntil.value) {
          console.warn('Ignored pipeline error during stop:', err)
          return
        }
        errorMessage.value = err instanceof Error ? err.message : String(err)
        stop()
        status.value = 'error'
        console.error('Pipeline error:', err)
      },
    },
  )
}

function stopPipeline() {
  engine?.stop()
  engine = undefined
  latestState.value = undefined
  latestPoseTargets.value = undefined
  prevPoseTargets.value = undefined
  prevPoseForward.value = undefined
}

function stop() {
  ignoreErrorsUntil.value = Date.now() + 1500
  canvasRef.value?.getContext('2d')?.clearRect(0, 0, canvasRef.value.width, canvasRef.value.height)
  stopPipeline()

  try {
    stream?.getTracks().forEach(t => t.stop())
  }
  catch {}

  stream = undefined
  if (videoRef.value)
    videoRef.value.srcObject = null

  status.value = 'idle'
}

// ── Model switching ────────────────────────────────────────────────────────

function switchToVrm() {
  activeTab.value = 'vrm'
  stageModelSelected.value = 'preset-vrm-1'
  settingsStore.updateStageModel().catch(console.error)
}

function switchToLive2d() {
  activeTab.value = 'live2d'
  stageModelSelected.value = 'preset-live2d-1'
  settingsStore.updateStageModel().catch(console.error)
}

// ── Watchers ───────────────────────────────────────────────────────────────

watch(config, val => engine?.updateConfig(toRaw(val)), { deep: true })

watch(sceneRef, (scene, prev) => {
  prev?.setVrmFrameHook(undefined)
  scene?.setVrmFrameHook(vrmFrameHook)
}, { immediate: true })

watch(pipelineEnabled, async (enabled) => {
  if (syncingToggleState.value)
    return
  enabled ? await startCamera() : stop()
})

// ── Lifecycle ──────────────────────────────────────────────────────────────

onMounted(() => {
  // Default to Live2D on open
  if (stageModelRenderer.value !== 'live2d') {
    stageModelSelected.value = 'preset-live2d-1'
    settingsStore.updateStageModel().catch(console.error)
  }

  if (pipelineEnabled.value)
    startCamera()
})

onUnmounted(() => {
  sceneRef.value?.setVrmFrameHook(undefined)
  stop()
})
</script>

<template>
  <div :class="['p-4', 'space-y-4']">
    <div>
      <div :class="['text-lg', 'font-600']">
        Mocap → Live2D / VRM
      </div>
      <div :class="['text-xs', 'text-neutral-500', 'mt-1']">
        Camera-based motion capture mapped to Live2D face parameters and VRM body bones via MediaPipe.
      </div>
    </div>

    <!-- Config panel -->
    <div :class="['rounded-2xl', 'border', 'border-neutral-300/40', 'dark:border-neutral-700/40', 'p-3', 'space-y-3']">
      <div :class="['flex', 'items-start', 'justify-between', 'gap-3', 'flex-wrap']">
        <div :class="['space-y-1']">
          <div :class="['font-600']">
            Config
          </div>
          <div :class="['text-xs', 'text-neutral-500']">
            {{ summary }}
          </div>
          <div :class="['text-xs', 'text-neutral-500']">
            {{ faceDebug }}
          </div>
        </div>

        <label :class="['flex', 'items-center', 'gap-3']">
          <div :class="['text-sm', 'text-neutral-600', 'dark:text-neutral-300']">
            {{ pipelineEnabled ? 'Running' : 'Stopped' }}
          </div>
          <Checkbox v-model="pipelineEnabled" />
        </label>
      </div>

      <!-- Detection toggles + Hz -->
      <div :class="['grid', 'gap-3', 'lg:grid-cols-2']">
        <div :class="['flex', 'items-center', 'justify-between', 'gap-3']">
          <label :class="['flex', 'items-center', 'gap-2', 'text-sm']">
            <input v-model="config.enabled.pose" type="checkbox">
            Pose (body → VRM)
          </label>
          <label :class="['flex', 'items-center', 'gap-2']">
            <div :class="['text-xs', 'text-neutral-500']">
              Hz
            </div>
            <input
              v-model.number="config.hz.pose"
              type="number"
              min="1"
              max="60"
              :class="['w-20', 'rounded-lg', 'border', 'border-neutral-300/60', 'bg-white', 'px-2', 'py-1', 'text-sm', 'dark:bg-neutral-900/60', 'dark:border-neutral-700/60']"
            >
          </label>
        </div>

        <div :class="['flex', 'items-center', 'justify-between', 'gap-3']">
          <label :class="['flex', 'items-center', 'gap-2', 'text-sm']">
            <input v-model="config.enabled.face" type="checkbox">
            Face (head → Live2D)
          </label>
          <label :class="['flex', 'items-center', 'gap-2']">
            <div :class="['text-xs', 'text-neutral-500']">
              Hz
            </div>
            <input
              v-model.number="config.hz.face"
              type="number"
              min="1"
              max="60"
              :class="['w-20', 'rounded-lg', 'border', 'border-neutral-300/60', 'bg-white', 'px-2', 'py-1', 'text-sm', 'dark:bg-neutral-900/60', 'dark:border-neutral-700/60']"
            >
          </label>
        </div>
      </div>

      <!-- VRM axis flip + smoothing -->
      <div :class="['flex', 'items-center', 'flex-wrap', 'justify-between', 'gap-4']">
        <div :class="['text-sm', 'text-neutral-600', 'dark:text-neutral-300']">
          VRM Axis Flip
        </div>
        <div :class="['flex', 'items-center', 'gap-6', 'flex-wrap']">
          <label :class="['flex', 'items-center', 'gap-3']">
            <div :class="['text-sm', 'text-neutral-600', 'dark:text-neutral-300']">
              Flip X
            </div>
            <Checkbox v-model="vrmMapping.flipX" />
          </label>
          <label :class="['flex', 'items-center', 'gap-3']">
            <div :class="['text-sm', 'text-neutral-600', 'dark:text-neutral-300']">
              Flip Y
            </div>
            <Checkbox v-model="vrmMapping.flipY" />
          </label>
          <label :class="['flex', 'items-center', 'gap-3']">
            <div :class="['text-sm', 'text-neutral-600', 'dark:text-neutral-300']">
              Flip Z
            </div>
            <Checkbox v-model="vrmMapping.flipZ" />
          </label>
        </div>
      </div>

      <div :class="['flex', 'items-center', 'justify-between', 'gap-4', 'flex-wrap']">
        <div :class="['text-sm', 'text-neutral-600', 'dark:text-neutral-300']">
          Smoothing
        </div>
        <label :class="['flex', 'items-center', 'gap-3']">
          <div :class="['text-xs', 'text-neutral-500']">
            {{ (smoothing * 100).toFixed(0) }}%
          </div>
          <input
            v-model.number="smoothing"
            type="range"
            min="0"
            max="0.95"
            step="0.05"
            :class="['w-32']"
          >
        </label>
      </div>

      <div :class="['text-xs', 'text-neutral-500']">
        Note: `@mediapipe/tasks-vision` runs sync and may block the main thread. Frames are dropped when busy to keep UI responsive.
      </div>
    </div>

    <!-- Model type tabs -->
    <div :class="['flex', 'gap-2']">
      <button
        :class="[
          'rounded-xl', 'px-4', 'py-2', 'text-sm', 'font-500', 'transition-colors',
          activeTab === 'live2d'
            ? 'bg-primary-500 text-white'
            : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700',
        ]"
        @click="switchToLive2d"
      >
        Live2D (face mocap)
      </button>
      <button
        :class="[
          'rounded-xl', 'px-4', 'py-2', 'text-sm', 'font-500', 'transition-colors',
          activeTab === 'vrm'
            ? 'bg-primary-500 text-white'
            : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700',
        ]"
        @click="switchToVrm"
      >
        VRM (full-body mocap)
      </button>
    </div>

    <!-- Main: camera + model viewer -->
    <div :class="['grid', 'gap-4', 'lg:grid-cols-2']">
      <!-- Camera feed -->
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
            :class="['absolute', 'inset-0', 'h-full', 'w-full', 'object-cover', 'opacity-70']"
          />
          <div
            :class="[
              'absolute', 'left-3', 'top-3',
              'rounded-lg', 'bg-black/50', 'px-2', 'py-1',
              'text-xs', 'text-white', 'backdrop-blur',
            ]"
          >
            <div>Status: {{ status }}</div>
            <div v-if="status === 'error'" :class="['text-red-300']">
              {{ errorMessage }}
            </div>
          </div>
          <div
            :class="[
              'absolute', 'right-3', 'bottom-3',
              'rounded-lg', 'bg-black/50', 'px-2', 'py-1',
              'text-xs', 'text-white', 'backdrop-blur',
            ]"
          >
            Camera ({{ activeTab === 'live2d' ? 'face tracked' : 'pose + face tracked' }})
          </div>
        </div>
      </div>

      <!-- Model viewer -->
      <div :class="['rounded-2xl', 'border', 'border-neutral-300/40', 'dark:border-neutral-700/40', 'overflow-hidden']">
        <div :class="['h-full', 'min-h-80']">
          <!-- Live2D viewer -->
          <template v-if="activeTab === 'live2d'">
            <SceneLive2D
              v-if="stageModelRenderer === 'live2d'"
              :model-src="stageModelSelectedUrl"
              :paused="false"
              :disable-focus-at="true"
              :live2d-idle-animation-enabled="false"
              :live2d-auto-blink-enabled="false"
              :live2d-force-auto-blink-enabled="false"
            />
            <div v-else :class="['flex', 'h-full', 'items-center', 'justify-center', 'p-4', 'text-sm', 'text-neutral-500']">
              Loading Live2D model…
            </div>
          </template>

          <!-- VRM viewer -->
          <template v-else>
            <ThreeScene
              v-if="stageModelRenderer === 'vrm'"
              ref="sceneRef"
              :model-src="stageModelSelectedUrl"
              :idle-animation="animations.idleLoop.toString()"
              :show-axes="stageViewControlsEnabled"
              :paused="false"
              @error="console.error"
            />
            <div v-else :class="['flex', 'h-full', 'items-center', 'justify-center', 'p-4', 'text-sm', 'text-neutral-500']">
              Loading VRM model…
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- Live2D parameter sliders (debug / manual override) -->
    <div
      v-if="activeTab === 'live2d'"
      :class="['rounded-2xl', 'border', 'border-neutral-300/40', 'dark:border-neutral-700/40', 'p-3', 'space-y-3']"
    >
      <div :class="['font-600', 'text-sm']">
        Live2D Parameters (live / debug)
      </div>
      <div :class="['grid', 'gap-2', 'sm:grid-cols-2', 'lg:grid-cols-3']">
        <label
          v-for="(range, key) in ({
            angleX: [-30, 30],
            angleY: [-30, 30],
            angleZ: [-30, 30],
            leftEyeOpen: [0, 1],
            rightEyeOpen: [0, 1],
            mouthOpen: [0, 1],
            mouthForm: [-1, 1],
            leftEyebrowY: [-1, 1],
            rightEyebrowY: [-1, 1],
          } as Record<string, [number, number]>)"
          :key="key"
          :class="['flex', 'items-center', 'justify-between', 'gap-2', 'text-xs']"
        >
          <span :class="['text-neutral-600', 'dark:text-neutral-400', 'w-28', 'shrink-0']">{{ key }}</span>
          <input
            :value="(modelParameters as Record<string, number>)[key]"
            type="range"
            :min="range[0]"
            :max="range[1]"
            :step="key.includes('angle') ? 0.5 : 0.02"
            :class="['flex-1']"
            @input="(e) => { (modelParameters as Record<string, number>)[key] = Number((e.target as HTMLInputElement).value) }"
          >
          <span :class="['w-10', 'text-right', 'tabular-nums', 'text-neutral-500']">
            {{ ((modelParameters as Record<string, number>)[key] ?? 0).toFixed(2) }}
          </span>
        </label>
      </div>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: plain
</route>
