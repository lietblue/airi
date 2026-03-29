<script setup lang="ts">
import { OnboardingDialog, OnboardingStepAnalyticsNotice, ToasterRoot } from '@proj-airi/stage-ui/components'
import { isPosthogAvailableInBuild, useSharedAnalyticsStore } from '@proj-airi/stage-ui/stores/analytics'
import { useSpeakingStore } from '@proj-airi/stage-ui/stores/audio'
import { useCharacterOrchestratorStore, useCharacterStore } from '@proj-airi/stage-ui/stores/character'
import { useChatOrchestratorStore } from '@proj-airi/stage-ui/stores/chat'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useDisplayModelsStore } from '@proj-airi/stage-ui/stores/display-models'
import { useModsServerChannelStore } from '@proj-airi/stage-ui/stores/mods/api/channel-server'
import { useContextBridgeStore } from '@proj-airi/stage-ui/stores/mods/api/context-bridge'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { useAnimationActionsStore } from '@proj-airi/stage-ui/stores/modules/animation-actions'
import { useHandVisionStore } from '@proj-airi/stage-ui/stores/modules/hand-vision'
import { usePresenceStore } from '@proj-airi/stage-ui/stores/modules/presence'
import { useVisionProcessingStore } from '@proj-airi/stage-ui/stores/modules/vision'
import { useOnboardingStore } from '@proj-airi/stage-ui/stores/onboarding'
import { useSettings, useSettingsAudioDevice, useSettingsGreenScreen } from '@proj-airi/stage-ui/stores/settings'
import { useTheme } from '@proj-airi/ui'
import { StageTransitionGroup } from '@proj-airi/ui-transitions'
import { useMagicKeys, whenever } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterView } from 'vue-router'
import { toast, Toaster } from 'vue-sonner'

import PerformanceOverlay from './components/Devtools/PerformanceOverlay.vue'
import HandGazeFeature from './components/features/HandGazeFeature.vue'
import PresenceDetector from './components/features/PresenceDetector.vue'

import { usePWAStore } from './stores/pwa'

usePWAStore()

// --- Vision feature stores (persistent across all routes) ---
const presenceStore = usePresenceStore()
const handVisionStore = useHandVisionStore()
const animationActionsStore = useAnimationActionsStore()
const characterStore = useCharacterStore()
const visionProcessingStore = useVisionProcessingStore()
const settingsAudioDeviceStore = useSettingsAudioDevice()
const chatSessionStore = useChatSessionStore()
const { state: presenceState } = storeToRefs(presenceStore)

// Speak a welcome message and play the configured welcome action when someone appears
watch(() => presenceStore.pendingWelcome, async (msg) => {
  if (!msg)
    return
  presenceStore.clearPendingWelcome()
  if (presenceStore.welcomeActionTag) {
    const id = animationActionsStore.pickRandomFromTag(presenceStore.welcomeActionTag)
    if (id)
      animationActionsStore.playAction(id, 'tool')
  }
  await characterStore.emitTextOutput(msg)
})

// --- Stores needed for chat-active suppression and hand-raise message sending ---
const speakingStore = useSpeakingStore()
const chatOrchestrator = useChatOrchestratorStore()

// NOTICE: autoAsrActivatedMic is set only when we programmatically enable the mic via
// pendingAutoAsr consumption. This avoids false positives when the user manually toggles
// the microphone while autoAsrAfterMessage is enabled.
let autoAsrActivatedMic = false

// Emit a hand-raised message as a fake assistant reply: TTS + chat history, no LLM round-trip
watch(() => handVisionStore.pendingMessage, async (msg) => {
  if (!msg)
    return
  handVisionStore.clearPendingMessage()
  if (handVisionStore.messageActionTag) {
    const id = animationActionsStore.pickRandomFromTag(handVisionStore.messageActionTag)
    if (id)
      animationActionsStore.playAction(id, 'tool')
  }

  // If auto-ASR is enabled, flag that we should open the mic after TTS finishes
  if (handVisionStore.autoAsrAfterMessage)
    handVisionStore.pendingAutoAsr = true

  // Add as an assistant message to the active chat session so it appears in the chat UI
  const sessionId = chatSessionStore.activeSessionId
  if (sessionId) {
    const messages = chatSessionStore.sessionMessages[sessionId]
    if (messages) {
      messages.push({ role: 'assistant', content: msg, slices: [], tool_results: [], createdAt: Date.now() })
      chatSessionStore.persistSessionMessages(sessionId)
    }
  }

  // Play TTS via speech pipeline (no LLM request)
  await characterStore.emitTextOutput(msg)

  // Fallback: if TTS never started (no provider, error, etc.), nowSpeaking never fires.
  // Wait a short grace period for the speech pipeline to begin playback before assuming
  // TTS is absent — emitTextOutput only queues text; actual playback starts asynchronously.
  if (handVisionStore.pendingAutoAsr) {
    await new Promise(resolve => setTimeout(resolve, 500))
    if (handVisionStore.pendingAutoAsr && !speakingStore.nowSpeaking) {
      handVisionStore.pendingAutoAsr = false
      autoAsrActivatedMic = true
      if (!settingsAudioDeviceStore.enabled)
        settingsAudioDeviceStore.enabled = true
    }
  }
})

// --- Chat-active suppression: prevent hand-raise triggers during conversation ---

watch(
  () => chatOrchestrator.sending || speakingStore.nowSpeaking,
  active => handVisionStore.setChatActive(active),
  { immediate: true },
)

// --- Auto-ASR: open microphone after TTS finishes speaking ---
// When pendingAutoAsr is true and TTS stops, enable the microphone.
// The existing ChatArea watchers will auto-start listening and auto-send via VAD/debounce.
watch(
  () => speakingStore.nowSpeaking,
  (speaking, wasSpeaking) => {
    if (wasSpeaking && !speaking && handVisionStore.pendingAutoAsr) {
      handVisionStore.pendingAutoAsr = false
      autoAsrActivatedMic = true
      if (!settingsAudioDeviceStore.enabled) {
        settingsAudioDeviceStore.enabled = true
      }
    }
  },
)

watch(() => chatOrchestrator.sending, (sending, wasSending) => {
  // After a send completes and we auto-activated the mic, turn it off
  if (wasSending && !sending && autoAsrActivatedMic) {
    autoAsrActivatedMic = false
    // Wait for TTS to finish before disabling (the speaking watcher handles the actual disable)
    // Only disable if not currently speaking (TTS may still be playing the response)
    if (!speakingStore.nowSpeaking) {
      settingsAudioDeviceStore.enabled = false
    }
  }
})

// Also disable mic when TTS finishes if auto-ASR conversation turn completed
watch(() => speakingStore.nowSpeaking, (speaking, wasSpeaking) => {
  if (wasSpeaking && !speaking && autoAsrActivatedMic && !chatOrchestrator.sending) {
    autoAsrActivatedMic = false
    settingsAudioDeviceStore.enabled = false
  }
})

// Gate LLM scene detection on presence active state and scene enabled flag
watch(presenceState, (s) => {
  if (!presenceStore.enabled || !visionProcessingStore.enabled)
    return
  if (s === 'active')
    visionProcessingStore.startTicker(async () => {})
  else
    visionProcessingStore.stopTicker()
})

// Stop the ticker immediately when scene detection is disabled
watch(() => visionProcessingStore.enabled, (v) => {
  if (!v)
    visionProcessingStore.stopTicker()
})

const contextBridgeStore = useContextBridgeStore()
const i18n = useI18n()
const displayModelsStore = useDisplayModelsStore()
const settingsStore = useSettings()
const settings = storeToRefs(settingsStore)
const onboardingStore = useOnboardingStore()
const serverChannelStore = useModsServerChannelStore()
const characterOrchestratorStore = useCharacterOrchestratorStore()
const { showingSetup } = storeToRefs(onboardingStore)
const { isDark } = useTheme()
const cardStore = useAiriCardStore()
const analyticsStore = useSharedAnalyticsStore()

// --- Green Screen Mode: toggle with H key ---
const greenScreenStore = useSettingsGreenScreen()
const { h: hKey } = useMagicKeys()
let lastHPress = 0
whenever(hKey, () => {
  // Skip if user is typing in an input, textarea, or contenteditable element
  const el = document.activeElement
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable))
    return

  const now = Date.now()
  if (greenScreenStore.enabled) {
    // Double-press H (within 300ms) to exit green screen
    if (now - lastHPress < 300)
      greenScreenStore.toggle()
    lastHPress = now
  }
  else {
    // Single press H to enter green screen
    greenScreenStore.toggle()
  }
})

const primaryColor = computed(() => {
  return isDark.value
    ? `color-mix(in srgb, oklch(95% var(--chromatic-chroma-900) calc(var(--chromatic-hue) + ${0})) 70%, oklch(50% 0 360))`
    : `color-mix(in srgb, oklch(95% var(--chromatic-chroma-900) calc(var(--chromatic-hue) + ${0})) 90%, oklch(90% 0 360))`
})

const secondaryColor = computed(() => {
  return isDark.value
    ? `color-mix(in srgb, oklch(95% var(--chromatic-chroma-900) calc(var(--chromatic-hue) + ${180})) 70%, oklch(50% 0 360))`
    : `color-mix(in srgb, oklch(95% var(--chromatic-chroma-900) calc(var(--chromatic-hue) + ${180})) 90%, oklch(90% 0 360))`
})

const tertiaryColor = computed(() => {
  return isDark.value
    ? `color-mix(in srgb, oklch(95% var(--chromatic-chroma-900) calc(var(--chromatic-hue) + ${60})) 70%, oklch(50% 0 360))`
    : `color-mix(in srgb, oklch(95% var(--chromatic-chroma-900) calc(var(--chromatic-hue) + ${60})) 90%, oklch(90% 0 360))`
})

const colors = computed(() => {
  return [primaryColor.value, secondaryColor.value, tertiaryColor.value, isDark.value ? '#121212' : '#FFFFFF']
})

const onboardingExtraSteps = computed(() => {
  return isPosthogAvailableInBuild()
    ? [{ id: 'analytics-notice', component: OnboardingStepAnalyticsNotice }]
    : []
})

watch(settings.language, () => {
  i18n.locale.value = settings.language.value
})

watch(settings.themeColorsHue, () => {
  document.documentElement.style.setProperty('--chromatic-hue', settings.themeColorsHue.value.toString())
}, { immediate: true })

watch(settings.themeColorsHueDynamic, () => {
  document.documentElement.classList.toggle('dynamic-hue', settings.themeColorsHueDynamic.value)
}, { immediate: true })

// Initialize first-time setup check when app mounts
onMounted(async () => {
  analyticsStore.initialize()
  cardStore.initialize()

  if (onboardingStore.needsOnboarding) {
    onboardingStore.showingSetup = true
  }

  await chatSessionStore.initialize()
  await serverChannelStore.initialize({ possibleEvents: ['ui:configure'] }).catch(err => console.error('Failed to initialize Mods Server Channel in App.vue:', err))
  await contextBridgeStore.initialize()
  characterOrchestratorStore.initialize()

  await displayModelsStore.loadDisplayModelsFromIndexedDB()
  await settingsStore.initializeStageModel()
  await settingsAudioDeviceStore.initialize()
})

onUnmounted(() => {
  contextBridgeStore.dispose()
})

// Handle first-time setup events
function handleSetupConfigured() {
  onboardingStore.markSetupCompleted()
}

function handleSetupSkipped() {
  onboardingStore.markSetupSkipped()
}
</script>

<template>
  <!-- Vision feature components: headless, persist across all routes -->
  <PresenceDetector v-if="presenceStore.enabled" />
  <HandGazeFeature v-if="handVisionStore.gazeEnabled || handVisionStore.messageEnabled || handVisionStore.headTrackingEnabled" />

  <StageTransitionGroup
    :primary-color="primaryColor"
    :secondary-color="secondaryColor"
    :tertiary-color="tertiaryColor"
    :colors="colors"
    :z-index="100"
    :disable-transitions="settings.disableTransitions.value"
    :use-page-specific-transitions="settings.usePageSpecificTransitions.value"
  >
    <RouterView v-slot="{ Component }">
      <component :is="Component" />
    </RouterView>
  </StageTransitionGroup>

  <template v-if="!greenScreenStore.enabled">
    <ToasterRoot @close="id => toast.dismiss(id)">
      <Toaster />
    </ToasterRoot>

    <!-- First Time Setup Dialog -->
    <OnboardingDialog
      v-model="showingSetup"
      :extra-steps="onboardingExtraSteps"
      @configured="handleSetupConfigured"
      @skipped="handleSetupSkipped"
    />

    <PerformanceOverlay />
  </template>
</template>

<style>
/* We need this to properly animate the CSS variable */
@property --chromatic-hue {
  syntax: '<number>';
  initial-value: 0;
  inherits: true;
}

@keyframes hue-anim {
  from {
    --chromatic-hue: 0;
  }
  to {
    --chromatic-hue: 360;
  }
}

.dynamic-hue {
  animation: hue-anim 10s linear infinite;
}
</style>
