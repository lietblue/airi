<script setup lang="ts">
import { useProvidersStore } from '@proj-airi/stage-ui/stores/providers'
import { Checkbox } from '@proj-airi/ui'
import { useIntervalFn } from '@vueuse/core'
import { streamText } from '@xsai/stream-text'
import { message } from '@xsai/utils-chat'
import { storeToRefs } from 'pinia'
import { computed, onUnmounted, ref, watch } from 'vue'

// ── Camera state ───────────────────────────────────────────────────────────

const status = ref<'idle' | 'starting' | 'running' | 'error'>('idle')
const errorMessage = ref('')
const cameraEnabled = ref(false)

const videoRef = ref<HTMLVideoElement>()
let stream: MediaStream | undefined

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
    status.value = 'running'
  }
  catch (err) {
    status.value = 'error'
    errorMessage.value = err instanceof Error ? err.message : String(err)
    cameraEnabled.value = false
  }
}

function stopCamera() {
  try {
    stream?.getTracks().forEach(t => t.stop())
  }
  catch {}
  stream = undefined
  if (videoRef.value)
    videoRef.value.srcObject = null
  status.value = 'idle'
}

watch(cameraEnabled, (enabled) => {
  enabled ? startCamera() : stopCamera()
})

onUnmounted(() => stopCamera())

// ── Providers store ────────────────────────────────────────────────────────

const providersStore = useProvidersStore()
const { persistedChatProvidersMetadata } = storeToRefs(providersStore)

// ── LLM Vision state ───────────────────────────────────────────────────────

const llmEnabled = ref(false)
const llmProvider = ref('')
const llmModel = ref('')
// Interval between captures (seconds)
const llmInterval = ref(5)
const llmMaxTokens = ref(1000)
const llmPrompt = ref(
  'Describe what you see in this camera frame in 1–2 sentences. Focus on the person\'s facial expression, head pose, and any notable action or gesture.',
)

interface LlmEntry {
  id: number
  frameDataUrl: string
  // wall-clock for display
  capturedAt: number
  // performance.now() snapshot for precise latency
  capturePerf: number
  latencyMs: number | null
  text: string
  // reasoning-delta content from thinking/reasoning models (e.g. qwen3, deepseek-r1)
  reasoning: string
  status: 'pending' | 'done' | 'error'
  error?: string
}

const llmHistory = ref<LlmEntry[]>([])
let _llmEntryId = 0
// Keep at most 20 entries to avoid unbounded memory growth
const LLM_MAX_HISTORY = 20

/**
 * Captures the current video frame onto an off-screen canvas and returns a
 * compressed JPEG data URL together with timing metadata.
 * Scales down to ≤640 px wide so the base64 payload stays manageable.
 */
function captureCurrentFrame(): { dataUrl: string, capturePerf: number, capturedAt: number } | null {
  const video = videoRef.value
  if (!video || video.readyState < 2)
    return null

  const sw = video.videoWidth || 640
  const sh = video.videoHeight || 480
  const maxW = 640
  const scale = sw > maxW ? maxW / sw : 1
  const dw = Math.round(sw * scale)
  const dh = Math.round(sh * scale)

  const offscreen = document.createElement('canvas')
  offscreen.width = dw
  offscreen.height = dh
  const ctx = offscreen.getContext('2d')
  if (!ctx)
    return null

  ctx.drawImage(video, 0, 0, dw, dh)
  const capturePerf = performance.now()
  const capturedAt = Date.now()
  const dataUrl = offscreen.toDataURL('image/jpeg', 0.75)
  return { dataUrl, capturePerf, capturedAt }
}

/** Captures one frame and streams it through a vision-capable LLM for real-time analysis. */
async function runLlmAnalysis() {
  if (!llmEnabled.value || !llmProvider.value || !llmModel.value)
    return

  const frame = captureCurrentFrame()
  if (!frame)
    return

  const providerConfig = providersStore.getProviderConfig(llmProvider.value)
  if (!providerConfig)
    return

  llmHistory.value.unshift({
    id: _llmEntryId++,
    frameDataUrl: frame.dataUrl,
    capturedAt: frame.capturedAt,
    capturePerf: frame.capturePerf,
    latencyMs: null,
    text: '',
    reasoning: '',
    status: 'pending',
  })
  if (llmHistory.value.length > LLM_MAX_HISTORY)
    llmHistory.value.pop()

  // Use the reactive proxy from the array so mutations trigger Vue reactivity
  const liveEntry = llmHistory.value[0]

  const { fullStream } = streamText({
    apiKey: (providerConfig.apiKey as string | undefined) ?? '',
    baseURL: (providerConfig.baseUrl as string | undefined) ?? '',
    model: llmModel.value,
    messages: message.messages(
      message.user([
        message.textPart(llmPrompt.value),
        message.imagePart(frame.dataUrl),
      ]),
    ),
    max_tokens: llmMaxTokens.value,
  })

  const reader = fullStream.getReader()
  try {
    while (true) {
      const { done, value: event } = await reader.read()
      if (done)
        break
      if (event.type === 'text-delta') {
        liveEntry.text += event.text
      }
      else if (event.type === 'reasoning-delta') {
        liveEntry.reasoning += event.text
      }
      else if (event.type === 'error') {
        throw event.error
      }
    }
    liveEntry.latencyMs = Math.round(performance.now() - frame.capturePerf)
    liveEntry.status = 'done'
  }
  catch (err) {
    console.error('[llm-camera] stream error:', err)
    liveEntry.latencyMs = Math.round(performance.now() - frame.capturePerf)
    liveEntry.status = 'error'
    liveEntry.error = err instanceof Error ? err.message : String(err)
  }
  finally {
    reader.releaseLock()
  }
}

const { pause: pauseLlm, resume: resumeLlm } = useIntervalFn(
  runLlmAnalysis,
  computed(() => llmInterval.value * 1000),
  { immediate: false, immediateCallback: false },
)

watch(llmEnabled, (enabled) => {
  if (enabled) {
    // Fire immediately, then on interval
    runLlmAnalysis()
    resumeLlm()
  }
  else {
    pauseLlm()
  }
})
</script>

<template>
  <div :class="['p-4', 'space-y-4']">
    <!-- Camera + config panel -->
    <div :class="['rounded-2xl', 'border', 'border-neutral-300/40', 'dark:border-neutral-700/40', 'p-3', 'space-y-3']">
      <!-- Header row: camera thumbnail + controls -->
      <div :class="['flex', 'items-start', 'gap-3']">
        <!-- Compact camera preview -->
        <div :class="['relative', 'w-64', 'shrink-0', 'rounded-xl', 'overflow-hidden', 'bg-black', 'aspect-video']">
          <video
            ref="videoRef"
            muted
            playsinline
            :class="['absolute', 'inset-0', 'h-full', 'w-full', 'object-cover']"
          />
          <!-- Status overlay -->
          <div
            :class="[
              'absolute', 'inset-x-0', 'bottom-0',
              'bg-black/60', 'px-1.5', 'py-0.5',
              'text-xs', 'text-white/80', 'text-center', 'truncate',
            ]"
          >
            <span v-if="status === 'error'" :class="['text-red-300']">{{ errorMessage }}</span>
            <span v-else>{{ status }}</span>
          </div>
        </div>

        <!-- Title + toggles -->
        <div :class="['flex-1', 'min-w-0', 'space-y-2']">
          <div :class="['font-600', 'text-sm']">
            LLM Camera Vision
          </div>
          <label :class="['flex', 'items-center', 'gap-2']">
            <Checkbox v-model="cameraEnabled" />
            <span :class="['text-sm', 'text-neutral-600', 'dark:text-neutral-300']">
              {{ cameraEnabled ? 'Camera On' : 'Camera Off' }}
            </span>
          </label>
          <label :class="['flex', 'items-center', 'gap-2']">
            <Checkbox v-model="llmEnabled" :disabled="!llmProvider || !llmModel || status !== 'running'" />
            <span :class="['text-sm', 'text-neutral-600', 'dark:text-neutral-300']">
              {{ llmEnabled ? 'Analysis Running' : 'Analysis Stopped' }}
            </span>
          </label>
        </div>
      </div>

      <!-- Provider selector -->
      <div :class="['space-y-1.5']">
        <div :class="['text-xs', 'font-500', 'text-neutral-600', 'dark:text-neutral-300']">
          Provider
        </div>
        <div v-if="persistedChatProvidersMetadata.length === 0" :class="['text-xs', 'text-amber-500']">
          No chat providers configured. Go to Settings → Providers to add one.
        </div>
        <div v-else :class="['flex', 'flex-wrap', 'gap-1.5']">
          <button
            v-for="p in persistedChatProvidersMetadata"
            :key="p.id"
            :class="[
              'rounded-lg', 'px-3', 'py-1.5', 'text-xs', 'font-500', 'transition-colors',
              llmProvider === p.id
                ? 'bg-primary-500 text-white'
                : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700',
            ]"
            @click="llmProvider = p.id"
          >
            {{ p.localizedName || p.name }}
          </button>
        </div>
      </div>

      <!-- Model input -->
      <div :class="['space-y-1.5']">
        <div :class="['text-xs', 'font-500', 'text-neutral-600', 'dark:text-neutral-300']">
          Model (vision-capable)
        </div>
        <input
          v-model="llmModel"
          type="text"
          placeholder="e.g. gpt-4o, llama-3.2-11b-vision-preview…"
          :class="['w-full', 'rounded-lg', 'border', 'border-neutral-300/60', 'bg-white', 'px-3', 'py-1.5', 'text-sm', 'dark:bg-neutral-900/60', 'dark:border-neutral-700/60', 'outline-none', 'focus:border-primary-400']"
        >
      </div>

      <!-- Interval + max tokens -->
      <div :class="['grid', 'gap-3', 'sm:grid-cols-2']">
        <label :class="['flex', 'flex-col', 'gap-1']">
          <div :class="['flex', 'justify-between', 'items-baseline']">
            <span :class="['text-xs', 'font-500', 'text-neutral-600', 'dark:text-neutral-300']">Capture interval</span>
            <span :class="['text-xs', 'tabular-nums', 'text-neutral-500']">{{ llmInterval }}s</span>
          </div>
          <input v-model.number="llmInterval" type="range" min="1" max="30" step="1" :class="['w-full']">
          <div :class="['text-xs', 'text-neutral-400', 'dark:text-neutral-500']">
            Seconds between frame captures
          </div>
        </label>
        <label :class="['flex', 'flex-col', 'gap-1']">
          <div :class="['flex', 'justify-between', 'items-baseline']">
            <span :class="['text-xs', 'font-500', 'text-neutral-600', 'dark:text-neutral-300']">Max tokens</span>
            <span :class="['text-xs', 'tabular-nums', 'text-neutral-500']">{{ llmMaxTokens }}</span>
          </div>
          <input v-model.number="llmMaxTokens" type="range" min="50" max="500" step="50" :class="['w-full']">
          <div :class="['text-xs', 'text-neutral-400', 'dark:text-neutral-500']">
            LLM response length cap
          </div>
        </label>
      </div>

      <!-- Prompt -->
      <div :class="['space-y-1.5']">
        <div :class="['text-xs', 'font-500', 'text-neutral-600', 'dark:text-neutral-300']">
          Prompt
        </div>
        <textarea
          v-model="llmPrompt"
          rows="2"
          :class="['w-full', 'rounded-lg', 'border', 'border-neutral-300/60', 'bg-white', 'px-3', 'py-2', 'text-sm', 'dark:bg-neutral-900/60', 'dark:border-neutral-700/60', 'resize-none', 'outline-none', 'focus:border-primary-400']"
        />
      </div>
    </div>

    <!-- Current frame -->
    <div v-if="llmHistory.length > 0" :class="['rounded-2xl', 'border', 'border-neutral-300/40', 'dark:border-neutral-700/40', 'p-3', 'space-y-2']">
      <div :class="['text-xs', 'font-500', 'text-neutral-600', 'dark:text-neutral-300']">
        Latest Frame
      </div>
      <div :class="['flex', 'gap-3', 'items-start']">
        <!-- Thumbnail -->
        <div :class="['shrink-0', 'rounded-lg', 'overflow-hidden', 'border', 'border-neutral-300/40', 'dark:border-neutral-700/40']">
          <img
            :src="llmHistory[0].frameDataUrl"
            :class="['w-32', 'h-auto', 'block']"
            alt="Captured frame"
          >
        </div>
        <!-- Meta + text -->
        <div :class="['flex-1', 'min-w-0', 'space-y-1.5']">
          <div :class="['flex', 'gap-2', 'items-center', 'flex-wrap']">
            <!-- Status badge -->
            <span
              :class="[
                'rounded-md', 'px-2', 'py-0.5', 'text-xs', 'font-500',
                llmHistory[0].status === 'done' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                : llmHistory[0].status === 'error' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                  : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
              ]"
            >{{ llmHistory[0].status }}</span>
            <!-- Latency -->
            <span
              v-if="llmHistory[0].latencyMs != null"
              :class="['text-xs', 'tabular-nums', 'font-500', 'text-neutral-500']"
            >{{ llmHistory[0].latencyMs }}ms</span>
            <!-- Capture time -->
            <span :class="['text-xs', 'text-neutral-400']">
              {{ new Date(llmHistory[0].capturedAt).toLocaleTimeString() }}
            </span>
          </div>
          <!-- Waiting (no tokens yet) -->
          <div
            v-if="llmHistory[0].status === 'pending' && !llmHistory[0].text && !llmHistory[0].reasoning"
            :class="['flex', 'items-center', 'gap-2', 'text-xs', 'text-neutral-500']"
          >
            <div :class="['i-solar:spinner-line-duotone', 'animate-spin', 'text-base']" />
            Waiting for LLM…
          </div>
          <!-- Error -->
          <div
            v-else-if="llmHistory[0].status === 'error'"
            :class="['text-xs', 'text-red-500', 'break-words']"
          >
            {{ llmHistory[0].error }}
          </div>
          <!-- Final text response -->
          <div
            v-else-if="llmHistory[0].text"
            :class="['text-sm', 'text-neutral-700', 'dark:text-neutral-300', 'leading-relaxed']"
          >
            {{ llmHistory[0].text }}<span
              v-if="llmHistory[0].status === 'pending'"
              :class="['inline-block', 'w-0.5', 'h-3.5', 'ml-0.5', 'align-middle', 'bg-neutral-400', 'animate-pulse']"
            />
          </div>
          <!-- Reasoning-only (thinking models like qwen3, deepseek-r1) -->
          <div
            v-else-if="llmHistory[0].reasoning"
            :class="['space-y-1']"
          >
            <div :class="['flex', 'items-center', 'gap-1.5', 'text-xs', 'text-violet-500', 'dark:text-violet-400']">
              <div :class="['i-solar:brain-linear', 'text-sm']" />
              Thinking…
            </div>
            <div :class="['text-sm', 'text-neutral-500', 'dark:text-neutral-400', 'leading-relaxed', 'italic']">
              {{ llmHistory[0].reasoning }}<span
                v-if="llmHistory[0].status === 'pending'"
                :class="['inline-block', 'w-0.5', 'h-3.5', 'ml-0.5', 'align-middle', 'bg-neutral-400', 'animate-pulse']"
              />
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- History -->
    <div v-if="llmHistory.length > 1" :class="['rounded-2xl', 'border', 'border-neutral-300/40', 'dark:border-neutral-700/40', 'p-3', 'space-y-2']">
      <div :class="['text-xs', 'font-500', 'text-neutral-600', 'dark:text-neutral-300']">
        History ({{ llmHistory.length - 1 }} previous)
      </div>
      <div :class="['max-h-80', 'overflow-y-auto', 'space-y-2', 'pr-1']">
        <div
          v-for="entry in llmHistory.slice(1)"
          :key="entry.id"
          :class="['flex', 'gap-3', 'items-start', 'rounded-xl', 'border', 'border-neutral-200/60', 'dark:border-neutral-700/40', 'p-2']"
        >
          <img
            :src="entry.frameDataUrl"
            :class="['w-16', 'h-auto', 'shrink-0', 'rounded-md', 'block']"
            alt="Historical frame"
          >
          <div :class="['flex-1', 'min-w-0', 'space-y-1']">
            <div :class="['flex', 'gap-2', 'items-center', 'flex-wrap']">
              <span
                :class="[
                  'rounded-md', 'px-1.5', 'py-0.5', 'text-xs', 'font-500',
                  entry.status === 'done' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                  : entry.status === 'error' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                    : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
                ]"
              >{{ entry.status }}</span>
              <span
                v-if="entry.latencyMs != null"
                :class="['text-xs', 'tabular-nums', 'font-500', 'text-neutral-500']"
              >{{ entry.latencyMs }}ms</span>
              <span :class="['text-xs', 'text-neutral-400']">
                {{ new Date(entry.capturedAt).toLocaleTimeString() }}
              </span>
            </div>
            <div
              :class="['text-xs', 'leading-relaxed', 'line-clamp-2', 'break-words',
                       entry.text ? 'text-neutral-600 dark:text-neutral-300' : 'text-neutral-400 dark:text-neutral-500 italic']"
            >
              {{ entry.status === 'error' ? entry.error : (entry.text || entry.reasoning) }}
            </div>
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
