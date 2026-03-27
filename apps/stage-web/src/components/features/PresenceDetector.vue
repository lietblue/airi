<script setup lang="ts">
import type { VisionTaskModule } from '@proj-airi/model-driver-mediapipe/types'

import { errorMessageFrom } from '@moeru/std'
import { importTasksVision, visionTaskAssets, visionTaskWasmRoot } from '@proj-airi/model-driver-mediapipe'
import { usePresenceStore } from '@proj-airi/stage-ui/stores/modules/presence'
import { onMounted, onUnmounted, ref } from 'vue'

// NOTICE: Derive instance type without a direct @mediapipe/tasks-vision import —
// tasks-vision is already a dep of model-driver-mediapipe; importing via VisionTaskModule
// prevents a duplicate package resolution in stage-web.
type FaceLandmarkerType = Awaited<ReturnType<VisionTaskModule['FaceLandmarker']['createFromOptions']>>

// NOTICE: Tick interval for presence detection. 1 fps is sufficient for person-in-room
// detection and keeps CPU usage negligible.
const TICK_INTERVAL_MS = 1000

const presenceStore = usePresenceStore()

const videoRef = ref<HTMLVideoElement>()

let stream: MediaStream | undefined
let faceLandmarker: FaceLandmarkerType | undefined
let tickHandle: ReturnType<typeof setInterval> | null = null

async function initModel() {
  faceLandmarker?.close()
  faceLandmarker = undefined

  const { FaceLandmarker, FilesetResolver } = await importTasksVision()
  const vision = await FilesetResolver.forVisionTasks(visionTaskWasmRoot)
  // NOTICE: numFaces: 1 — presence detection only needs to know if at least one face
  // exists; setting higher values increases per-frame cost for no benefit here.
  // outputFaceBlendshapes and outputFacialTransformationMatrixes are disabled because
  // we only read faceLandmarks.length (face count), not the landmark geometry.
  // For even lighter detection, replace with FaceDetector (bounding-box only model)
  // once a face_detector.task asset is available in this package.
  faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: visionTaskAssets.face },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: false,
  })
}

function tick() {
  const video = videoRef.value
  if (!video || !faceLandmarker || video.readyState < 2) {
    presenceStore.onFaceDetected(0)
    return
  }

  try {
    const result = faceLandmarker.detectForVideo(video, performance.now())
    presenceStore.onFaceDetected(result.faceLandmarks?.length ?? 0)
  }
  catch {
    presenceStore.onFaceDetected(0)
  }
}

async function start() {
  presenceStore.cameraStatus = 'starting'
  presenceStore.cameraError = ''
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })

    if (!videoRef.value)
      return

    videoRef.value.srcObject = stream
    await videoRef.value.play()

    if (!faceLandmarker)
      await initModel()

    tickHandle = setInterval(tick, TICK_INTERVAL_MS)
    presenceStore.cameraStatus = 'running'
  }
  catch (err) {
    presenceStore.cameraStatus = 'error'
    presenceStore.cameraError = errorMessageFrom(err) ?? 'Failed to start camera'
    console.warn('[PresenceDetector] failed to start:', presenceStore.cameraError)
  }
}

function stop() {
  if (tickHandle !== null) {
    clearInterval(tickHandle)
    tickHandle = null
  }

  try {
    stream?.getTracks().forEach(t => t.stop())
  }
  catch {}

  stream = undefined

  if (videoRef.value)
    videoRef.value.srcObject = null

  presenceStore.onFaceDetected(0)
  presenceStore.cameraStatus = 'idle'
  presenceStore.cameraError = ''
}

onMounted(() => start())
onUnmounted(() => stop())
</script>

<template>
  <!-- Hidden video element used solely for face detection; never shown to the user. -->
  <video ref="videoRef" style="display:none" muted playsinline />
</template>
