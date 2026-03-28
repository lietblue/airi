<script setup lang="ts">
import type { VisionTaskModule } from '@proj-airi/model-driver-mediapipe/types'

import { errorMessageFrom } from '@moeru/std'
import { importTasksVision, visionTaskAssets, visionTaskWasmRoot } from '@proj-airi/model-driver-mediapipe'
import { usePresenceStore } from '@proj-airi/stage-ui/stores/modules/presence'
import { onMounted, onUnmounted, ref } from 'vue'

// NOTICE: Derive instance type without a direct @mediapipe/tasks-vision import —
// tasks-vision is already a dep of model-driver-mediapipe; importing via VisionTaskModule
// prevents a duplicate package resolution in stage-web.
type FaceDetectorType = Awaited<ReturnType<VisionTaskModule['FaceDetector']['createFromOptions']>>

// NOTICE: Tick interval for presence detection. 1 fps is sufficient for person-in-room
// detection and keeps CPU usage negligible.
const TICK_INTERVAL_MS = 1000

const presenceStore = usePresenceStore()

const videoRef = ref<HTMLVideoElement>()

let stream: MediaStream | undefined
let faceDetector: FaceDetectorType | undefined
let tickHandle: ReturnType<typeof setInterval> | null = null

async function initModel() {
  faceDetector?.close()
  faceDetector = undefined

  // NOTICE: FaceDetector (blaze_face_short_range) is significantly lighter than
  // FaceLandmarker — it outputs bounding boxes only (no 468-point mesh), which is
  // sufficient for presence detection. Model file: blaze_face_short_range.tflite (224 KB).
  const { FaceDetector, FilesetResolver } = await importTasksVision()
  const vision = await FilesetResolver.forVisionTasks(visionTaskWasmRoot)
  faceDetector = await FaceDetector.createFromOptions(vision, {
    baseOptions: { modelAssetPath: visionTaskAssets.faceDetector },
    runningMode: 'VIDEO',
  })
}

function tick() {
  const video = videoRef.value
  if (!video || !faceDetector || video.readyState < 2) {
    presenceStore.onFaceDetected(0)
    return
  }

  try {
    const result = faceDetector.detectForVideo(video, performance.now())
    presenceStore.onFaceDetected(result.detections?.length ?? 0)
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

    if (!faceDetector)
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
  faceDetector?.close()
  faceDetector = undefined

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
