import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useHandVisionStore = defineStore('hand-vision', () => {
  // --- Settings (persisted) ---

  /**
   * When enabled, AIRI's gaze tracks the raised hand via the camera.
   * Requires camera access; activates HandGazeFeature.vue in Stage.vue.
   */
  const gazeEnabled = useLocalStorageManualReset('settings/hand-vision/gaze-enabled', false)

  /**
   * When enabled, raising an arm triggers AIRI to say a message from the pool.
   * Activates HandGazeFeature.vue if not already active for gaze.
   */
  const messageEnabled = useLocalStorageManualReset('settings/hand-vision/message-enabled', false)

  /** Pool of messages said when an arm is raised. A random one is picked each time. */
  const messagePool = useLocalStorageManualReset<string[]>('settings/hand-vision/messages', [
    'Do you need something?',
    'Are you waving at me?',
    'Hi! Can I help you?',
  ])

  /**
   * Tag name for actions to play when arm is raised. When set, a random action from
   * the named tag pool is played alongside the message. Empty string = no action.
   */
  const messageActionTag = useLocalStorageManualReset('settings/hand-vision/action-tag', '')

  /**
   * When enabled, after a hand-raised message is used the store calls the LLM to
   * regenerate a replacement. Applied via applyRegenMessage().
   */
  const messageAiRegenEnabled = useLocalStorageManualReset('settings/hand-vision/ai-regen', false)

  /**
   * When true, gaze tracking and message triggering only activate when the arm is raised
   * (wrist above elbow in image space). Prevents accidental triggers when hands are at rest.
   */
  const requireArmRaised = useLocalStorageManualReset('settings/hand-vision/require-arm-raised', true)

  /**
   * How long (ms) the arm must be continuously raised before triggering a message.
   * Prevents accidental triggers from brief hand movements.
   */
  const messageDurationThresholdMs = useLocalStorageManualReset('settings/hand-vision/message-duration-ms', 2000)

  /**
   * When enabled, an open→close hand gesture while arm is raised also triggers
   * a message (bypasses the duration threshold).
   */
  const messageGestureEnabled = useLocalStorageManualReset('settings/hand-vision/message-gesture-enabled', true)

  /**
   * When enabled, the microphone activates automatically after the AI finishes speaking
   * in response to a hand-raise message. Combined with hearing auto-send, this enables
   * a fully hands-free conversation flow.
   */
  const autoAsrAfterMessage = useLocalStorageManualReset('settings/hand-vision/auto-asr-after-message', false)

  /**
   * Cooldown (ms) after a hand-raise message before another can trigger.
   * Prevents rapid re-triggers across raise cycles.
   */
  const messageCooldownMs = useLocalStorageManualReset('settings/hand-vision/message-cooldown-ms', 5000)

  /**
   * Multiplier for the gaze movement range. 1.0 = default; higher values make AIRI's
   * eyes move further toward the edges of the frame when tracking the hand.
   */
  const gazeAmplitude = useLocalStorageManualReset('settings/hand-vision/gaze-amplitude', 1.0)

  /**
   * Invert the X axis of the gaze target (left/right flip).
   * Default false — the sign is already negated to correct for mirror convention.
   */
  const gazeInvertX = useLocalStorageManualReset('settings/hand-vision/gaze-invert-x', false)

  /**
   * Invert the Y axis of the gaze target (up/down flip).
   * Default true — image-space Y increases downward, so inversion is needed by default.
   */
  const gazeInvertY = useLocalStorageManualReset('settings/hand-vision/gaze-invert-y', true)

  /**
   * When enabled, AIRI's head/neck bones also rotate toward the tracked hand in addition
   * to (or instead of) the eye lookAt system.
   */
  const headTrackingEnabled = useLocalStorageManualReset('settings/hand-vision/head-tracking-enabled', false)

  /**
   * How strongly the head turns toward the hand target. 0 = no movement, 1 = full range.
   * Neck carries 40% of the rotation, head carries 60%.
   */
  const headTrackingStrength = useLocalStorageManualReset('settings/hand-vision/head-tracking-strength', 0.3)

  // --- Runtime state ---

  /** Camera lifecycle status written by HandGazeFeature.vue. */
  const cameraStatus = ref<'idle' | 'starting' | 'running' | 'error'>('idle')

  /** Human-readable error from HandGazeFeature.vue when cameraStatus === 'error'. */
  const cameraError = ref('')

  /** True while an arm is detected as raised in the current frame. */
  const handDetected = ref(false)

  /** Face detection count from the last PresenceDetector tick (used for debug page). */
  const lastFaceCount = ref(0)

  /**
   * When set, App.vue should send this as a chat message then call clearPendingMessage().
   * Guarded by duration threshold, gesture trigger, chat-active suppression, and cooldown.
   */
  const pendingMessage = ref<string | null>(null)

  /** Index of the message that was most recently used (for AI regen replacement). */
  const lastUsedMessageIndex = ref<number>(-1)

  /** Timestamp when arm was first continuously detected as raised (0 = not raised). */
  const armRaisedSinceMs = ref(0)

  /** Whether the duration threshold has already fired for this raise cycle. */
  const durationFired = ref(false)

  /**
   * True when conversation is active (sending to LLM, streaming response, or TTS playing).
   * Set by App.vue watcher. Suppresses new hand-raise message triggers.
   */
  const chatActive = ref(false)

  /** When true, the microphone should be activated after TTS finishes. Set by App.vue. */
  const pendingAutoAsr = ref(false)

  /** Current hand openness value (0=fist, 1=fully open). Updated by HandGazeFeature.vue. */
  const handOpenness = ref(0)

  /** Whether the hand is currently in the "open" state (above hysteresis threshold). */
  const handIsOpen = ref(false)

  /** Timestamp of the last successful message trigger (for cooldown enforcement). */
  const lastTriggerMs = ref(0)

  // --- Actions ---

  /** Pick a random message from the pool and set it as pending. */
  function _pickAndSetMessage(): boolean {
    const pool = messagePool.value
    if (!pool.length)
      return false
    const idx = Math.floor(Math.random() * pool.length)
    lastUsedMessageIndex.value = idx
    pendingMessage.value = pool[idx]
    lastTriggerMs.value = Date.now()
    return true
  }

  /** Check common guards: messageEnabled, not chatActive, no pending message, cooldown elapsed. */
  function _canTrigger(now: number): boolean {
    if (!messageEnabled.value)
      return false
    if (chatActive.value)
      return false
    if (pendingMessage.value !== null)
      return false
    if (now - lastTriggerMs.value < messageCooldownMs.value)
      return false
    return true
  }

  /**
   * Called by HandGazeFeature.vue every frame when an arm raise is detected.
   * Only updates detection state and initializes the raise timestamp.
   * Message triggering is handled by tryTriggerByDuration() and tryTriggerByGesture().
   */
  function onHandRaised() {
    handDetected.value = true
    if (armRaisedSinceMs.value === 0) {
      armRaisedSinceMs.value = Date.now()
    }
  }

  /** Called by HandGazeFeature.vue when the arm is no longer raised. */
  function onHandLost() {
    handDetected.value = false
    armRaisedSinceMs.value = 0
    durationFired.value = false
  }

  /**
   * Attempt to trigger a message based on arm raise duration.
   * Called each frame by HandGazeFeature.vue while the arm is raised.
   */
  function tryTriggerByDuration(now: number): boolean {
    if (durationFired.value)
      return false
    if (!_canTrigger(now))
      return false
    if (armRaisedSinceMs.value === 0)
      return false
    if (now - armRaisedSinceMs.value < messageDurationThresholdMs.value)
      return false
    durationFired.value = true
    return _pickAndSetMessage()
  }

  /**
   * Attempt to trigger a message based on an open→close hand gesture.
   * Called by the gesture state machine callback in HandGazeFeature.vue.
   */
  function tryTriggerByGesture(): boolean {
    if (!messageGestureEnabled.value)
      return false
    if (!handDetected.value)
      return false
    if (!_canTrigger(Date.now()))
      return false
    return _pickAndSetMessage()
  }

  /** Called by App.vue after consuming the pending message. Records cooldown timestamp. */
  function clearPendingMessage() {
    pendingMessage.value = null
  }

  /** Set the chat-active guard. Called by App.vue watcher. */
  function setChatActive(active: boolean) {
    chatActive.value = active
  }

  /**
   * Replace the last-used hand message with a freshly AI-generated one.
   * Called by App.vue after sending the message if messageAiRegenEnabled is true.
   */
  function applyRegenMessage(newMessage: string) {
    const idx = lastUsedMessageIndex.value
    if (idx < 0 || idx >= messagePool.value.length)
      return
    const updated = [...messagePool.value]
    updated[idx] = newMessage
    messagePool.value = updated
    lastUsedMessageIndex.value = -1
  }

  return {
    // Settings
    gazeEnabled,
    messageEnabled,
    messagePool,
    messageActionTag,
    messageAiRegenEnabled,
    requireArmRaised,
    messageDurationThresholdMs,
    messageGestureEnabled,
    autoAsrAfterMessage,
    messageCooldownMs,
    gazeAmplitude,
    gazeInvertX,
    gazeInvertY,
    headTrackingEnabled,
    headTrackingStrength,

    // Runtime
    cameraStatus,
    cameraError,
    handDetected,
    lastFaceCount,
    pendingMessage,
    lastUsedMessageIndex,
    armRaisedSinceMs,
    durationFired,
    chatActive,
    pendingAutoAsr,
    lastTriggerMs,
    handOpenness,
    handIsOpen,

    // Actions
    onHandRaised,
    onHandLost,
    tryTriggerByDuration,
    tryTriggerByGesture,
    clearPendingMessage,
    setChatActive,
    applyRegenMessage,
  }
})
