<script setup lang="ts">
import { useHandVisionStore } from '@proj-airi/stage-ui/stores/modules/hand-vision'
import { usePresenceStore } from '@proj-airi/stage-ui/stores/modules/presence'
import { useVisionProcessingStore } from '@proj-airi/stage-ui/stores/modules/vision'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import VisionDebugCamera from '../../../components/features/VisionDebugCamera.vue'

const { t } = useI18n()
const presenceStore = usePresenceStore()
const handVisionStore = useHandVisionStore()
const visionProcessingStore = useVisionProcessingStore()

const {
  state: presenceState,
  lastSeenAt,
} = storeToRefs(presenceStore)

const {
  handDetected,
} = storeToRefs(handVisionStore)

const {
  isRunning: sceneRunning,
  captureCount,
  contextUpdateCount,
  lastCaptureAt,
} = storeToRefs(visionProcessingStore)

function formatRelative(ts: number | null): string {
  if (!ts)
    return 'Never'
  const diff = Math.floor((Date.now() - ts) / 1000)
  if (diff < 60)
    return `${diff}s ago`
  return `${Math.floor(diff / 60)}m ago`
}

const lastSeenFormatted = computed(() => formatRelative(lastSeenAt.value))
const lastCaptureFormatted = computed(() => formatRelative(lastCaptureAt.value))
</script>

<template>
  <div :class="['flex', 'flex-col', 'gap-4']">
    <!-- Live camera feed with landmark overlay -->
    <div :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
      <div :class="['flex', 'flex-col', 'gap-3']">
        <h2 :class="['text-lg', 'md:text-2xl']">
          Camera Preview
        </h2>
        <p :class="['text-xs', 'text-neutral-400']">
          Starts an independent detection pipeline — face, hands and pose landmarks are drawn in real time. This runs separately from the active feature components.
        </p>
        <VisionDebugCamera />
      </div>
    </div>

    <!-- Presence detection -->
    <div :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
      <div :class="['flex', 'flex-col', 'gap-3']">
        <h2 :class="['text-lg', 'md:text-2xl']">
          {{ t('settings.pages.vision.presence.title') }}
        </h2>
        <div :class="['grid', 'gap-3', 'sm:grid-cols-3']">
          <div :class="['rounded-lg', 'border', 'border-neutral-200', 'bg-white', 'p-3', 'dark:border-neutral-800', 'dark:bg-neutral-900']">
            <div :class="['text-xs', 'uppercase', 'tracking-wide', 'text-neutral-400']">
              {{ t('settings.pages.vision.debug.presence-state') }}
            </div>
            <div :class="['flex', 'items-center', 'gap-2', 'mt-1']">
              <div
                :class="[
                  'h-2.5', 'w-2.5', 'rounded-full',
                  presenceState === 'active' ? 'bg-emerald-400' : 'bg-neutral-400',
                ]"
              />
              <span :class="['text-sm', 'font-medium', 'capitalize']">{{ presenceState }}</span>
            </div>
          </div>
          <div :class="['rounded-lg', 'border', 'border-neutral-200', 'bg-white', 'p-3', 'dark:border-neutral-800', 'dark:bg-neutral-900']">
            <div :class="['text-xs', 'uppercase', 'tracking-wide', 'text-neutral-400']">
              {{ t('settings.pages.vision.debug.last-seen') }}
            </div>
            <div :class="['mt-1', 'text-sm', 'font-medium']">
              {{ lastSeenFormatted }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Hand detection -->
    <div :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
      <div :class="['flex', 'flex-col', 'gap-3']">
        <h2 :class="['text-lg', 'md:text-2xl']">
          {{ t('settings.pages.vision.hand.title') }}
        </h2>
        <div :class="['grid', 'gap-3', 'sm:grid-cols-2']">
          <div :class="['rounded-lg', 'border', 'border-neutral-200', 'bg-white', 'p-3', 'dark:border-neutral-800', 'dark:bg-neutral-900']">
            <div :class="['text-xs', 'uppercase', 'tracking-wide', 'text-neutral-400']">
              {{ t('settings.pages.vision.debug.hand-detected') }}
            </div>
            <div :class="['flex', 'items-center', 'gap-2', 'mt-1']">
              <div
                :class="[
                  'h-2.5', 'w-2.5', 'rounded-full',
                  handDetected ? 'bg-emerald-400 animate-pulse' : 'bg-neutral-400',
                ]"
              />
              <span :class="['text-sm', 'font-medium']">{{ handDetected ? 'Detected' : 'Not detected' }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Scene detection -->
    <div :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
      <div :class="['flex', 'flex-col', 'gap-3']">
        <h2 :class="['text-lg', 'md:text-2xl']">
          {{ t('settings.pages.vision.scene.title') }}
        </h2>
        <div :class="['grid', 'gap-3', 'sm:grid-cols-3']">
          <div :class="['rounded-lg', 'border', 'border-neutral-200', 'bg-white', 'p-3', 'dark:border-neutral-800', 'dark:bg-neutral-900']">
            <div :class="['text-xs', 'uppercase', 'tracking-wide', 'text-neutral-400']">
              Ticker
            </div>
            <div :class="['mt-1', 'text-sm', 'font-medium']">
              {{ sceneRunning ? 'Active' : 'Idle' }}
            </div>
          </div>
          <div :class="['rounded-lg', 'border', 'border-neutral-200', 'bg-white', 'p-3', 'dark:border-neutral-800', 'dark:bg-neutral-900']">
            <div :class="['text-xs', 'uppercase', 'tracking-wide', 'text-neutral-400']">
              {{ t('settings.pages.vision.debug.scene-last-capture') }}
            </div>
            <div :class="['mt-1', 'text-sm', 'font-medium']">
              {{ lastCaptureFormatted }}
            </div>
            <div :class="['text-xs', 'text-neutral-400']">
              {{ captureCount }} total
            </div>
          </div>
          <div :class="['rounded-lg', 'border', 'border-neutral-200', 'bg-white', 'p-3', 'dark:border-neutral-800', 'dark:bg-neutral-900']">
            <div :class="['text-xs', 'uppercase', 'tracking-wide', 'text-neutral-400']">
              {{ t('settings.pages.vision.debug.scene-context-updates') }}
            </div>
            <div :class="['mt-1', 'text-sm', 'font-medium']">
              {{ contextUpdateCount }}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.vision.debug.title
  subtitleKey: settings.pages.vision.title
  stageTransition:
    name: slide
</route>
