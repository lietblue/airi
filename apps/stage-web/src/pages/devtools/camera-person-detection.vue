<script setup lang="ts">
import type { Landmark2D, VisionTaskModule } from '@proj-airi/model-driver-mediapipe/types'

import { importTasksVision, visionTaskAssets, visionTaskWasmRoot } from '@proj-airi/model-driver-mediapipe'
import { Checkbox } from '@proj-airi/ui'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

// Derived types from the dynamically-imported tasks-vision module.
// NOTICE: We avoid a direct @mediapipe/tasks-vision import in stage-web to
// prevent a redundant package resolution — tasks-vision is already a dep of
// @proj-airi/model-driver-mediapipe.  VisionTaskModule re-exports the full
// module type so we can derive concrete types from it without a direct dep.
//
// FaceLandmarker uses a static factory pattern (no public constructor), so we
// use Awaited<ReturnType<...createFromOptions>> to get the instance type.
type FaceLandmarkerType = Awaited<ReturnType<VisionTaskModule['FaceLandmarker']['createFromOptions']>>
type FaceLandmarkerResult = ReturnType<FaceLandmarkerType['detectForVideo']>

// ── Status ─────────────────────────────────────────────────────────────────

const status = ref<'idle' | 'starting' | 'running' | 'error'>('idle')
const errorMessage = ref('')
const cameraEnabled = ref(false)
const modelLoading = ref(false)

// ── Camera elements ─────────────────────────────────────────────────────────

const videoRef = ref<HTMLVideoElement>()
const canvasRef = ref<HTMLCanvasElement>()
let stream: MediaStream | undefined
let faceLandmarker: FaceLandmarkerType | undefined
let rafId: number | undefined

// ── Config ──────────────────────────────────────────────────────────────────

const maxFaces = ref(10)
const recognitionThreshold = ref(0.97)
const showLandmarks = ref(false)
const showBoundingBoxes = ref(true)

// ── Detection state ─────────────────────────────────────────────────────────

interface DetectedFace {
  id: number
  landmarks: Landmark2D[]
  bbox: { x: number, y: number, w: number, h: number }
  matchedName: string | null
  matchScore: number
}

const detectedFaces = ref<DetectedFace[]>([])
const personCount = computed(() => detectedFaces.value.length)
// Monotonically-increasing counter used to give each detected face a stable
// display ID within the current frame.  Resets on each frame.
let frameDetectedFaceCounter = 0

// ── Registered faces ─────────────────────────────────────────────────────────

interface RegisteredFace {
  id: number
  name: string
  /** Normalized landmark descriptor — Float32Array of length landmarks*3 */
  descriptor: Float32Array
  /** JPEG data URL for thumbnail display */
  thumbnail: string
  registeredAt: number
}

const registeredFaces = ref<RegisteredFace[]>([])
let registeredFaceId = 0

// ── Face descriptor utils ────────────────────────────────────────────────────
//
// We represent each face as a normalized vector of its 478 FaceLandmarker
// landmark (x, y, z) coordinates.  Landmarks are recentered to the face
// bounding box and scaled to a unit square, making the descriptor invariant
// to image-space position and approximate scale.  Cosine similarity is used
// for matching; > 0.97 is a reliable threshold for front-facing captures
// under typical lighting conditions.
//
// NOTICE: This is a geometric landmark descriptor, not a learned embedding.
// It works well for a devtool demo but degrades with large head-pose changes
// (e.g. profile view vs. frontal).  For production use, consider a proper
// face embedding model such as MobileFaceNet.

function computeDescriptor(landmarks: Landmark2D[]): Float32Array {
  if (landmarks.length === 0)
    return new Float32Array(0)

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const lm of landmarks) {
    if (lm.x < minX)
      minX = lm.x
    if (lm.y < minY)
      minY = lm.y
    if (lm.x > maxX)
      maxX = lm.x
    if (lm.y > maxY)
      maxY = lm.y
  }

  const w = maxX - minX || 1
  const h = maxY - minY || 1

  const desc = new Float32Array(landmarks.length * 3)
  for (let i = 0; i < landmarks.length; i++) {
    desc[i * 3] = (landmarks[i].x - minX) / w
    desc[i * 3 + 1] = (landmarks[i].y - minY) / h
    // Normalize z by face width to keep it scale-consistent with x/y
    desc[i * 3 + 2] = landmarks[i].z / w
  }

  return desc
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0)
    return 0

  let dot = 0
  let magA = 0
  let magB = 0

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    magA += a[i] * a[i]
    magB += b[i] * b[i]
  }

  if (magA === 0 || magB === 0)
    return 0

  return dot / (Math.sqrt(magA) * Math.sqrt(magB))
}

function matchFace(descriptor: Float32Array): { name: string, score: number } | null {
  if (registeredFaces.value.length === 0 || descriptor.length === 0)
    return null

  let bestName = ''
  let bestScore = 0

  for (const reg of registeredFaces.value) {
    const score = cosineSimilarity(descriptor, reg.descriptor)
    if (score > bestScore) {
      bestScore = score
      bestName = reg.name
    }
  }

  if (bestScore >= recognitionThreshold.value)
    return { name: bestName, score: bestScore }

  return null
}

// ── Canvas overlay ────────────────────────────────────────────────────────────

function drawFaceOverlay(
  ctx: CanvasRenderingContext2D,
  face: DetectedFace,
  vw: number,
  vh: number,
) {
  const { x, y, w, h } = face.bbox
  const px = x * vw
  const py = y * vh
  const pw = w * vw
  const ph = h * vh

  const color = face.matchedName ? '#34d399' : '#60a5fa'

  if (showBoundingBoxes.value) {
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.strokeRect(px, py, pw, ph)
  }

  const label = face.matchedName
    ? `${face.matchedName} (${(face.matchScore * 100).toFixed(0)}%)`
    : `Person ${face.id}`

  ctx.font = 'bold 13px sans-serif'
  const textW = ctx.measureText(label).width + 8
  const textH = 18

  ctx.fillStyle = color
  ctx.fillRect(px, py - textH - 2, textW, textH)
  ctx.fillStyle = '#fff'
  ctx.fillText(label, px + 4, py - 6)

  if (showLandmarks.value) {
    ctx.fillStyle = 'rgba(255, 200, 0, 0.6)'
    for (const lm of face.landmarks) {
      ctx.beginPath()
      ctx.arc(lm.x * vw, lm.y * vh, 1, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}

// ── Detection loop ─────────────────────────────────────────────────────────────

function processFrame() {
  const video = videoRef.value
  const canvas = canvasRef.value

  if (!video || !canvas || !faceLandmarker || video.readyState < 2) {
    if (status.value === 'running')
      rafId = requestAnimationFrame(processFrame)
    return
  }

  const vw = video.videoWidth || 640
  const vh = video.videoHeight || 480

  if (canvas.width !== vw)
    canvas.width = vw
  if (canvas.height !== vh)
    canvas.height = vh

  const result: FaceLandmarkerResult = faceLandmarker.detectForVideo(video, performance.now())

  frameDetectedFaceCounter = 0
  const faces: DetectedFace[] = (result.faceLandmarks ?? []).map((landmarks: Landmark2D[]) => {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity

    for (const lm of landmarks) {
      if (lm.x < minX)
        minX = lm.x
      if (lm.y < minY)
        minY = lm.y
      if (lm.x > maxX)
        maxX = lm.x
      if (lm.y > maxY)
        maxY = lm.y
    }

    const pad = 0.05
    const bbox = {
      x: Math.max(0, minX - pad),
      y: Math.max(0, minY - pad),
      w: Math.min(1 - Math.max(0, minX - pad), maxX - minX + pad * 2),
      h: Math.min(1 - Math.max(0, minY - pad), maxY - minY + pad * 2),
    }

    const descriptor = computeDescriptor(landmarks)
    const match = matchFace(descriptor)

    return {
      id: ++frameDetectedFaceCounter,
      landmarks,
      bbox,
      matchedName: match?.name ?? null,
      matchScore: match?.score ?? 0,
    }
  })

  detectedFaces.value = faces

  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.clearRect(0, 0, vw, vh)
    for (const face of faces)
      drawFaceOverlay(ctx, face, vw, vh)

    // Person count HUD badge in top-left corner
    const count = faces.length
    const badge = `${count} person${count !== 1 ? 's' : ''} detected`
    ctx.font = 'bold 14px sans-serif'
    const badgeW = ctx.measureText(badge).width + 16
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'
    ctx.beginPath()
    ctx.roundRect(8, 8, badgeW, 28, 6)
    ctx.fill()
    ctx.fillStyle = count > 0 ? '#34d399' : '#f9a8d4'
    ctx.fillText(badge, 16, 26)
  }

  if (status.value === 'running')
    rafId = requestAnimationFrame(processFrame)
}

// ── Model init ────────────────────────────────────────────────────────────────

async function initModel() {
  modelLoading.value = true
  try {
    // Close previous instance if maxFaces changed
    faceLandmarker?.close()
    faceLandmarker = undefined

    const { FaceLandmarker, FilesetResolver } = await importTasksVision()
    const vision = await FilesetResolver.forVisionTasks(visionTaskWasmRoot)

    faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: visionTaskAssets.face },
      runningMode: 'VIDEO',
      numFaces: maxFaces.value,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    })
  }
  finally {
    modelLoading.value = false
  }
}

// ── Camera lifecycle ──────────────────────────────────────────────────────────

async function startCamera() {
  if (status.value === 'starting' || status.value === 'running')
    return

  status.value = 'starting'
  errorMessage.value = ''

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })

    if (!videoRef.value)
      throw new Error('video element not mounted')

    videoRef.value.srcObject = stream
    await videoRef.value.play()

    if (!faceLandmarker)
      await initModel()

    status.value = 'running'
    rafId = requestAnimationFrame(processFrame)
  }
  catch (err) {
    status.value = 'error'
    errorMessage.value = err instanceof Error ? err.message : String(err)
    cameraEnabled.value = false
  }
}

function stopCamera() {
  if (rafId != null) {
    cancelAnimationFrame(rafId)
    rafId = undefined
  }

  detectedFaces.value = []

  try {
    stream?.getTracks().forEach(t => t.stop())
  }
  catch {}

  stream = undefined

  if (videoRef.value)
    videoRef.value.srcObject = null

  if (canvasRef.value) {
    const ctx = canvasRef.value.getContext('2d')
    ctx?.clearRect(0, 0, canvasRef.value.width, canvasRef.value.height)
  }

  status.value = 'idle'
}

// ── Register face panel ────────────────────────────────────────────────────────

const registeringName = ref('')
const showRegisterPanel = ref(false)
const selectedFaceIndex = ref(0)

/**
 * Crops the current video frame to the face bounding box and returns a JPEG
 * thumbnail data URL at 64×64 px.
 */
function captureFaceThumbnail(landmarks: Landmark2D[]): string {
  const video = videoRef.value
  if (!video || video.readyState < 2)
    return ''

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const lm of landmarks) {
    if (lm.x < minX)
      minX = lm.x
    if (lm.y < minY)
      minY = lm.y
    if (lm.x > maxX)
      maxX = lm.x
    if (lm.y > maxY)
      maxY = lm.y
  }

  const pad = 0.1
  const vw = video.videoWidth
  const vh = video.videoHeight
  const sx = Math.max(0, (minX - pad) * vw)
  const sy = Math.max(0, (minY - pad) * vh)
  const sw = Math.min(vw - sx, (maxX - minX + pad * 2) * vw)
  const sh = Math.min(vh - sy, (maxY - minY + pad * 2) * vh)

  const offscreen = document.createElement('canvas')
  offscreen.width = 64
  offscreen.height = 64
  const ctx = offscreen.getContext('2d')
  if (!ctx)
    return ''

  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, 64, 64)
  return offscreen.toDataURL('image/jpeg', 0.85)
}

function openRegisterPanel() {
  if (detectedFaces.value.length === 0)
    return
  selectedFaceIndex.value = 0
  registeringName.value = ''
  showRegisterPanel.value = true
}

function confirmRegister() {
  const name = registeringName.value.trim()
  if (!name)
    return

  const face = detectedFaces.value[selectedFaceIndex.value]
  if (!face)
    return

  registeredFaces.value.push({
    id: registeredFaceId++,
    name,
    descriptor: computeDescriptor(face.landmarks),
    thumbnail: captureFaceThumbnail(face.landmarks),
    registeredAt: Date.now(),
  })

  showRegisterPanel.value = false
  registeringName.value = ''
}

function deleteRegisteredFace(id: number) {
  const index = registeredFaces.value.findIndex(f => f.id === id)
  if (index !== -1)
    registeredFaces.value.splice(index, 1)
}

// ── Watchers ────────────────────────────────────────────────────────────────

watch(cameraEnabled, (enabled) => {
  if (enabled)
    startCamera()
  else
    stopCamera()
})

// Reinitialize the landmarker when maxFaces changes and camera is running
watch(maxFaces, async () => {
  if (status.value !== 'running')
    return
  await initModel()
})

// ── Lifecycle ────────────────────────────────────────────────────────────────

onMounted(() => {
  // Pre-load model in the background so the first camera start is faster
  initModel()
})

onUnmounted(() => {
  stopCamera()
  faceLandmarker?.close()
  faceLandmarker = undefined
})
</script>

<template>
  <div :class="['p-4', 'space-y-4']">
    <!-- Header -->
    <div>
      <div :class="['text-lg', 'font-600']">
        Camera — Person Detection & Face Recognition
      </div>
      <div :class="['text-xs', 'text-neutral-500', 'mt-1']">
        Real-time multi-person detection via MediaPipe FaceLandmarker. Register known faces to enable recognition.
      </div>
    </div>

    <!-- Config panel -->
    <div :class="['rounded-2xl', 'border', 'border-neutral-300/40', 'dark:border-neutral-700/40', 'p-3']">
      <div :class="['flex', 'items-center', 'flex-wrap', 'gap-x-6', 'gap-y-3']">
        <!-- Toggle -->
        <label :class="['flex', 'items-center', 'gap-2']">
          <Checkbox v-model="cameraEnabled" :disabled="modelLoading" />
          <span :class="['text-sm', 'text-neutral-600', 'dark:text-neutral-300']">
            {{ modelLoading ? 'Loading…' : cameraEnabled ? 'Running' : 'Stopped' }}
          </span>
        </label>

        <!-- Max faces -->
        <label :class="['flex', 'items-center', 'gap-2']">
          <span :class="['text-xs', 'text-neutral-500', 'shrink-0']">Max people</span>
          <input
            v-model.number="maxFaces"
            type="range"
            min="1"
            max="20"
            step="1"
            :class="['w-24']"
          >
          <span :class="['text-xs', 'tabular-nums', 'text-neutral-500', 'w-4']">{{ maxFaces }}</span>
        </label>

        <!-- Recognition threshold -->
        <label :class="['flex', 'items-center', 'gap-2']">
          <span :class="['text-xs', 'text-neutral-500', 'shrink-0']">Threshold</span>
          <input
            v-model.number="recognitionThreshold"
            type="range"
            min="0.80"
            max="1.00"
            step="0.01"
            :class="['w-24']"
          >
          <span :class="['text-xs', 'tabular-nums', 'text-neutral-500', 'w-8']">{{ recognitionThreshold.toFixed(2) }}</span>
        </label>

        <!-- Display toggles -->
        <label :class="['flex', 'items-center', 'gap-1.5', 'text-xs', 'text-neutral-600', 'dark:text-neutral-300']">
          <Checkbox v-model="showBoundingBoxes" />
          <span>Boxes</span>
        </label>
        <label :class="['flex', 'items-center', 'gap-1.5', 'text-xs', 'text-neutral-600', 'dark:text-neutral-300']">
          <Checkbox v-model="showLandmarks" />
          <span>Landmarks</span>
        </label>
      </div>
    </div>

    <!-- Main: camera (left) + side panels (right) -->
    <div :class="['grid', 'gap-4', 'lg:grid-cols-2']">
      <!-- Camera feed -->
      <div :class="['flex', 'flex-col', 'gap-3']">
        <!-- Error banner -->
        <div
          v-if="status === 'error'"
          :class="['rounded-xl', 'bg-red-100', 'dark:bg-red-900/30', 'border', 'border-red-300/40', 'dark:border-red-700/40', 'px-3', 'py-2', 'text-xs', 'text-red-700', 'dark:text-red-300']"
        >
          <span :class="['i-solar:danger-circle-bold', 'mr-1', 'align-middle']" />
          {{ errorMessage }}
        </div>

        <div :class="['relative', 'aspect-video', 'overflow-hidden', 'rounded-2xl', 'bg-neutral-100', 'dark:bg-neutral-900', 'border', 'border-neutral-300/40', 'dark:border-neutral-700/40']">
          <video
            ref="videoRef"
            :class="['absolute', 'inset-0', 'h-full', 'w-full', 'object-cover', status === 'running' ? '' : 'invisible']"
            autoplay
            muted
            playsinline
          />
          <canvas
            v-show="status === 'running'"
            ref="canvasRef"
            :class="['absolute', 'inset-0', 'h-full', 'w-full']"
            style="pointer-events: none;"
          />
          <!-- Placeholder when idle/starting -->
          <div
            v-if="status !== 'running'"
            :class="['absolute', 'inset-0', 'flex', 'flex-col', 'items-center', 'justify-center', 'gap-2', 'text-neutral-400']"
          >
            <div v-if="status === 'starting' || modelLoading" :class="['i-svg-spinners:ring-resize', 'text-2xl']" />
            <div v-else :class="['i-solar:camera-bold-duotone', 'text-2xl']" />
            <div :class="['text-xs']">
              {{ status === 'starting' ? 'Starting camera…' : modelLoading ? 'Loading model…' : 'Enable camera to start' }}
            </div>
          </div>
        </div>
      </div>

      <!-- Right: detected + registered -->
      <div :class="['flex', 'flex-col', 'gap-3']">
        <!-- Detected faces -->
        <div :class="['rounded-2xl', 'border', 'border-neutral-300/40', 'dark:border-neutral-700/40', 'p-3', 'space-y-2']">
          <div :class="['flex', 'items-center', 'justify-between']">
            <div :class="['font-600', 'text-sm']">
              Detected — {{ personCount }} person{{ personCount !== 1 ? 's' : '' }}
            </div>
            <button
              v-if="personCount > 0"
              :class="[
                'rounded-lg', 'px-2', 'py-1', 'text-xs', 'font-500', 'transition-colors',
                'bg-blue-100', 'dark:bg-blue-900/30', 'text-blue-700', 'dark:text-blue-300',
                'hover:bg-blue-200', 'dark:hover:bg-blue-900/50',
              ]"
              @click="openRegisterPanel"
            >
              <span :class="['i-solar:user-plus-bold', 'mr-1', 'align-middle']" />
              Register
            </button>
          </div>

          <div v-if="personCount === 0" :class="['text-xs', 'text-neutral-400', 'py-2', 'text-center']">
            No faces detected
          </div>

          <div v-else :class="['space-y-1']">
            <div
              v-for="face in detectedFaces"
              :key="face.id"
              :class="[
                'flex', 'items-center', 'justify-between', 'gap-2',
                'rounded-lg', 'px-2', 'py-1.5',
                'bg-neutral-50', 'dark:bg-neutral-800/50',
              ]"
            >
              <div :class="['flex', 'items-center', 'gap-2']">
                <div :class="['i-solar:user-bold-duotone', 'text-neutral-400', 'text-sm', 'shrink-0']" />
                <span :class="['text-xs']">Person {{ face.id }}</span>
              </div>
              <span
                v-if="face.matchedName"
                :class="['inline-flex', 'items-center', 'gap-1', 'rounded-full', 'px-2', 'py-0.5', 'text-xs', 'font-500', 'bg-emerald-100', 'dark:bg-emerald-900/30', 'text-emerald-700', 'dark:text-emerald-400']"
              >
                <span :class="['i-solar:check-circle-bold', 'text-xs']" />
                {{ face.matchedName }} {{ (face.matchScore * 100).toFixed(0) }}%
              </span>
              <span v-else :class="['text-xs', 'text-neutral-400']">Unknown</span>
            </div>
          </div>
        </div>

        <!-- Registered faces -->
        <div :class="['rounded-2xl', 'border', 'border-neutral-300/40', 'dark:border-neutral-700/40', 'p-3', 'space-y-2']">
          <div :class="['font-600', 'text-sm']">
            Registered — {{ registeredFaces.length }}
          </div>

          <div v-if="registeredFaces.length === 0" :class="['text-xs', 'text-neutral-400', 'py-2', 'text-center']">
            No registered faces yet
          </div>

          <div v-else :class="['space-y-1']">
            <div
              v-for="reg in registeredFaces"
              :key="reg.id"
              :class="[
                'flex', 'items-center', 'justify-between', 'gap-2',
                'rounded-lg', 'px-2', 'py-1.5',
                'bg-neutral-50', 'dark:bg-neutral-800/50',
              ]"
            >
              <div :class="['flex', 'items-center', 'gap-2']">
                <img
                  v-if="reg.thumbnail"
                  :src="reg.thumbnail"
                  :class="['w-7', 'h-7', 'rounded-full', 'object-cover', 'border', 'border-neutral-200', 'dark:border-neutral-700', 'shrink-0']"
                >
                <div
                  v-else
                  :class="['w-7', 'h-7', 'rounded-full', 'bg-neutral-200', 'dark:bg-neutral-700', 'flex', 'items-center', 'justify-center', 'shrink-0']"
                >
                  <span :class="['i-solar:user-bold', 'text-neutral-400', 'text-xs']" />
                </div>
                <span :class="['text-xs', 'font-500']">{{ reg.name }}</span>
              </div>
              <button
                :class="[
                  'rounded', 'p-1', 'text-neutral-400', 'transition-colors',
                  'hover:bg-red-100', 'dark:hover:bg-red-900/30', 'hover:text-red-600', 'dark:hover:text-red-400',
                ]"
                title="Remove"
                @click="deleteRegisteredFace(reg.id)"
              >
                <span :class="['i-solar:trash-bin-trash-line-duotone', 'text-sm', 'block']" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Register face modal -->
    <Teleport to="body">
      <div
        v-if="showRegisterPanel"
        :class="['fixed', 'inset-0', 'z-50', 'flex', 'items-center', 'justify-center', 'bg-black/50', 'backdrop-blur-sm']"
        @click.self="showRegisterPanel = false"
      >
        <div
          :class="[
            'w-full', 'max-w-sm', 'mx-4',
            'rounded-2xl', 'bg-white', 'dark:bg-neutral-900',
            'border', 'border-neutral-200', 'dark:border-neutral-700',
            'p-5', 'space-y-4', 'shadow-2xl',
          ]"
        >
          <div :class="['font-600', 'text-base']">
            Register face
          </div>

          <!-- Face selector (if multiple detected) -->
          <div v-if="detectedFaces.length > 1" :class="['space-y-1']">
            <div :class="['text-xs', 'text-neutral-500']">
              Select person to register
            </div>
            <div :class="['flex', 'gap-2', 'flex-wrap']">
              <button
                v-for="(face, i) in detectedFaces"
                :key="face.id"
                :class="[
                  'rounded-lg', 'px-2.5', 'py-1', 'text-xs', 'font-500', 'transition-colors',
                  selectedFaceIndex === i
                    ? 'bg-blue-500 text-white'
                    : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300',
                ]"
                @click="selectedFaceIndex = i"
              >
                Person {{ face.id }}
              </button>
            </div>
          </div>

          <!-- Name input -->
          <div :class="['space-y-1']">
            <label :class="['text-xs', 'text-neutral-500']">Name</label>
            <input
              v-model="registeringName"
              type="text"
              placeholder="Enter a name…"
              :class="[
                'w-full', 'rounded-lg', 'border', 'border-neutral-300/60', 'dark:border-neutral-700/60',
                'bg-white', 'dark:bg-neutral-800', 'px-3', 'py-2', 'text-sm',
                'outline-none', 'focus:ring-2', 'focus:ring-blue-500/40',
              ]"
              autofocus
              @keydown.enter="confirmRegister"
              @keydown.esc="showRegisterPanel = false"
            >
          </div>

          <!-- Actions -->
          <div :class="['flex', 'justify-end', 'gap-2']">
            <button
              :class="[
                'rounded-lg', 'px-3', 'py-1.5', 'text-sm', 'transition-colors',
                'bg-neutral-100', 'dark:bg-neutral-800', 'text-neutral-600', 'dark:text-neutral-300',
                'hover:bg-neutral-200', 'dark:hover:bg-neutral-700',
              ]"
              @click="showRegisterPanel = false"
            >
              Cancel
            </button>
            <button
              :class="[
                'rounded-lg', 'px-3', 'py-1.5', 'text-sm', 'font-500', 'transition-colors',
                'bg-blue-500', 'text-white',
                'hover:bg-blue-600',
                !registeringName.trim() ? 'opacity-50 cursor-not-allowed' : '',
              ]"
              :disabled="!registeringName.trim()"
              @click="confirmRegister"
            >
              Register
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
