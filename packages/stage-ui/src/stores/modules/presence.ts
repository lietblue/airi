import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { ref } from 'vue'

export type PresenceState = 'idle' | 'active'

const PRESENCE_IDLE_TIMEOUT_DEFAULT_MS = 5 * 60 * 1000

export const usePresenceStore = defineStore('presence', () => {
  // --- Settings (persisted) ---

  /** Whether presence detection is enabled. Off by default to avoid unexpected camera access. */
  const enabled = useLocalStorageManualReset('settings/presence/enabled', false)

  /**
   * How long (ms) without a detected face before transitioning to idle.
   * Default: 5 minutes.
   */
  const idleTimeoutMs = useLocalStorageManualReset('settings/presence/idle-timeout-ms', PRESENCE_IDLE_TIMEOUT_DEFAULT_MS)

  /** Whether to send a welcome message when presence transitions idle → active. */
  const welcomeEnabled = useLocalStorageManualReset('settings/presence/welcome-enabled', true)

  /** Pool of welcome messages. A random one is picked on each activation. */
  const welcomeMessages = useLocalStorageManualReset<string[]>('settings/presence/welcome-messages', [
    'Hello! Nice to see you.',
    'Oh, you\'re back!',
    'Hi there!',
  ])

  /**
   * Tag name to bind welcome actions. When set, a random action from the named tag pool
   * is played alongside the welcome message. Empty string = no action.
   */
  const welcomeActionTag = useLocalStorageManualReset('settings/presence/welcome-action-tag', '')

  /**
   * When enabled, after a welcome message is used the store calls the LLM (via the
   * consciousness provider) to generate a replacement using the current conversation context.
   * The generated text replaces the used entry in welcomeMessages.
   */
  const welcomeAiRegenEnabled = useLocalStorageManualReset('settings/presence/welcome-ai-regen', false)

  // --- Runtime state ---

  /** Camera lifecycle status written by PresenceDetector.vue. */
  const cameraStatus = ref<'idle' | 'starting' | 'running' | 'error'>('idle')

  /** Human-readable error from PresenceDetector.vue when cameraStatus === 'error'. */
  const cameraError = ref('')

  const state = ref<PresenceState>('idle')

  /** Timestamp of the most recent idle → active transition. */
  const lastActivatedAt = ref<number | null>(null)

  /** Timestamp of the most recent detected face. */
  const lastSeenAt = ref<number | null>(null)

  /**
   * When set, Stage.vue should send this as a chat message then call clearPendingWelcome().
   * Set to the chosen welcome message when presence transitions to active.
   */
  const pendingWelcome = ref<string | null>(null)

  /** Index of the welcome message that was most recently used (for AI regen replacement). */
  const lastUsedWelcomeIndex = ref<number>(-1)

  let _idleTimer: ReturnType<typeof setTimeout> | null = null

  // --- Internal helpers ---

  function _cancelIdleTimer() {
    if (_idleTimer !== null) {
      clearTimeout(_idleTimer)
      _idleTimer = null
    }
  }

  function _scheduleIdleTransition() {
    _cancelIdleTimer()
    _idleTimer = setTimeout(() => {
      state.value = 'idle'
      _idleTimer = null
    }, idleTimeoutMs.value)
  }

  function _emitWelcome() {
    const pool = welcomeMessages.value
    if (!pool.length)
      return
    const idx = Math.floor(Math.random() * pool.length)
    lastUsedWelcomeIndex.value = idx
    pendingWelcome.value = pool[idx]
  }

  function _transitionToActive() {
    state.value = 'active'
    lastActivatedAt.value = Date.now()
    if (welcomeEnabled.value)
      _emitWelcome()
  }

  // --- Public API ---

  /**
   * Called by PresenceDetector.vue each detection tick with the count of visible faces.
   * Manages the idle timer and fires the idle → active transition when a face appears.
   */
  function onFaceDetected(count: number) {
    if (!enabled.value)
      return

    if (count > 0) {
      lastSeenAt.value = Date.now()
      _cancelIdleTimer()
      if (state.value === 'idle')
        _transitionToActive()
    }
    else {
      if (_idleTimer === null)
        _scheduleIdleTransition()
    }
  }

  /** Called by Stage.vue after consuming the pending welcome message. */
  function clearPendingWelcome() {
    pendingWelcome.value = null
  }

  /**
   * Replace the last-used welcome message with a freshly AI-generated one.
   * Called by Stage.vue after sending the welcome if welcomeAiRegenEnabled is true.
   * The actual LLM call is performed in Stage.vue using the consciousness provider;
   * this function applies the result to the pool.
   */
  function applyRegenWelcome(newMessage: string) {
    const idx = lastUsedWelcomeIndex.value
    if (idx < 0 || idx >= welcomeMessages.value.length)
      return
    const updated = [...welcomeMessages.value]
    updated[idx] = newMessage
    welcomeMessages.value = updated
    lastUsedWelcomeIndex.value = -1
  }

  function resetState() {
    _cancelIdleTimer()
    state.value = 'idle'
    lastActivatedAt.value = null
    lastSeenAt.value = null
    pendingWelcome.value = null
    lastUsedWelcomeIndex.value = -1
  }

  return {
    // Settings
    enabled,
    idleTimeoutMs,
    welcomeEnabled,
    welcomeMessages,
    welcomeActionTag,
    welcomeAiRegenEnabled,

    // Runtime
    cameraStatus,
    cameraError,
    state,
    lastActivatedAt,
    lastSeenAt,
    pendingWelcome,
    lastUsedWelcomeIndex,

    // Actions
    onFaceDetected,
    clearPendingWelcome,
    applyRegenWelcome,
    resetState,
  }
})
