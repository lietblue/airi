<script setup lang="ts">
import type { PerceptionState } from '@proj-airi/model-driver-mediapipe'

import { errorMessageFrom } from '@moeru/std'
import { createMocapEngine, createWorkerBackend, drawOverlay } from '@proj-airi/model-driver-mediapipe'
import { onUnmounted, ref, toRaw } from 'vue'

const videoRef = ref<HTMLVideoElement>()
const canvasRef = ref<HTMLCanvasElement>()

let stream: MediaStream | undefined
let engine: ReturnType<typeof createMocapEngine> | undefined

const status = ref<'idle' | 'starting' | 'running' | 'error'>('idle')
const errorMessage = ref('')
const faceDetected = ref(false)
const handInFrame = ref(false)
const armRaised = ref(false)

// All three jobs enabled so the debug overlay shows everything at once
const config = {
  enabled: { pose: true, hands: true, face: true },
  hz: { pose: 15, hands: 15, face: 10 },
  maxPeople: 1 as const,
}

// Mirrors isArmRaised logic from HandGazeFeature — always shows raw detection
// regardless of the requireArmRaised setting (this is the raw debug view)
function checkArmRaised(state: PerceptionState): boolean {
  const hand = state.hands?.[0]
  if (!hand)
    return false
  const lm = state.pose?.landmarks2d
  if (!lm)
    return true // fail open when pose unavailable
  const elbowIdx = hand.handedness === 'Left' ? 13 : 14
  const elbow = lm[elbowIdx]
  if (!elbow)
    return true
  if (elbow.visibility != null && elbow.visibility < 0.3)
    return true
  return hand.landmarks2d[0].y < elbow.y
}

function onPerception(state: PerceptionState) {
  faceDetected.value = state.face?.hasFace ?? false
  handInFrame.value = (state.hands?.length ?? 0) > 0
  armRaised.value = checkArmRaised(state)

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
    drawOverlay(ctx, state)
}

async function start() {
  if (status.value === 'starting' || status.value === 'running')
    return
  status.value = 'starting'
  errorMessage.value = ''
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
    if (!videoRef.value)
      throw new Error('Video element not mounted')
    videoRef.value.srcObject = stream
    await videoRef.value.play()

    const backend = createWorkerBackend()
    engine = createMocapEngine(backend, toRaw(config))
    await engine.init()
    engine.start(
      { getFrame: () => videoRef.value as HTMLVideoElement },
      onPerception,
      {
        onError: (err) => {
          errorMessage.value = errorMessageFrom(err) ?? 'Unknown error'
          stop()
          status.value = 'error'
        },
      },
    )
    status.value = 'running'
  }
  catch (err) {
    status.value = 'error'
    errorMessage.value = errorMessageFrom(err) ?? 'Failed to start camera'
  }
}

function stop() {
  engine?.dispose()
  engine = undefined
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
  faceDetected.value = false
  handInFrame.value = false
  armRaised.value = false
  status.value = 'idle'
}

onUnmounted(stop)
</script>

<template>
  <div :class="['flex', 'flex-col', 'gap-3']">
    <!-- Camera viewport with canvas landmark overlay -->
    <div :class="['relative', 'overflow-hidden', 'rounded-xl', 'bg-black', 'aspect-video']">
      <video
        ref="videoRef"
        :class="['w-full', 'h-full', 'object-cover', 'scale-x-[-1]']"
        autoplay
        muted
        playsinline
      />
      <!-- Canvas is NOT mirrored: drawOverlay draws in image-space coordinates so
           the mirror flip only needs to be on the video element itself -->
      <canvas
        ref="canvasRef"
        :class="['absolute', 'inset-0', 'w-full', 'h-full', 'pointer-events-none', 'scale-x-[-1]']"
      />

      <!-- Idle / loading overlay -->
      <div
        v-if="status !== 'running'"
        :class="['absolute', 'inset-0', 'flex', 'items-center', 'justify-center', 'bg-black/60']"
      >
        <span v-if="status === 'idle'" :class="['text-neutral-400', 'text-sm']">Camera off</span>
        <span v-else-if="status === 'starting'" :class="['text-neutral-300', 'text-sm', 'animate-pulse']">Starting…</span>
        <span v-else-if="status === 'error'" :class="['text-red-400', 'text-sm', 'px-4', 'text-center']">{{ errorMessage }}</span>
      </div>

      <!-- Live detection badges (top-right corner) -->
      <div
        v-if="status === 'running'"
        :class="['absolute', 'top-2', 'right-2', 'flex', 'flex-col', 'items-end', 'gap-1']"
      >
        <span
          :class="[
            'rounded-full', 'px-2', 'py-0.5', 'text-xs', 'font-medium',
            faceDetected
              ? 'bg-emerald-500/90 text-white'
              : 'bg-black/60 text-neutral-400',
          ]"
        >
          Face {{ faceDetected ? '✓' : '—' }}
        </span>
        <span
          :class="[
            'rounded-full', 'px-2', 'py-0.5', 'text-xs', 'font-medium',
            handInFrame
              ? 'bg-blue-500/90 text-white'
              : 'bg-black/60 text-neutral-400',
          ]"
        >
          Hand {{ handInFrame ? '✓' : '—' }}
        </span>
        <span
          :class="[
            'rounded-full', 'px-2', 'py-0.5', 'text-xs', 'font-medium',
            armRaised
              ? 'bg-amber-500/90 text-white animate-pulse'
              : 'bg-black/60 text-neutral-400',
          ]"
        >
          Arm raised {{ armRaised ? '✓' : '—' }}
        </span>
      </div>
    </div>

    <!-- Start / stop toggle -->
    <button
      :class="[
        'rounded-lg', 'px-4', 'py-2', 'text-sm', 'font-medium', 'transition-colors',
        status === 'running'
          ? 'bg-red-500 text-white hover:bg-red-600'
          : 'bg-primary-500 text-white hover:bg-primary-600',
        status === 'starting' && 'opacity-50 cursor-not-allowed',
      ]"
      :disabled="status === 'starting'"
      @click="status === 'running' ? stop() : start()"
    >
      {{ status === 'running' ? 'Stop Camera' : status === 'starting' ? 'Starting…' : 'Start Camera' }}
    </button>
  </div>
</template>
