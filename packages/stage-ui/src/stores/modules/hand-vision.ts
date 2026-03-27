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
   * When set, Stage.vue should send this as a chat message then call clearPendingMessage().
   * Arm raise only populates this once per raise (cleared on lower + re-raise).
   */
  const pendingMessage = ref<string | null>(null)

  /** Index of the message that was most recently used (for AI regen replacement). */
  const lastUsedMessageIndex = ref<number>(-1)

  // --- Actions ---

  /**
   * Called by HandGazeFeature.vue when an arm raise is detected.
   * Fires at most once per raise — subsequent calls before a lower are no-ops for messages.
   */
  function onHandRaised() {
    handDetected.value = true
    if (messageEnabled.value && pendingMessage.value === null) {
      const pool = messagePool.value
      if (pool.length) {
        const idx = Math.floor(Math.random() * pool.length)
        lastUsedMessageIndex.value = idx
        pendingMessage.value = pool[idx]
      }
    }
  }

  /** Called by HandGazeFeature.vue when the arm is no longer raised. */
  function onHandLost() {
    handDetected.value = false
  }

  /** Called by Stage.vue after consuming the pending message. */
  function clearPendingMessage() {
    pendingMessage.value = null
  }

  /**
   * Replace the last-used hand message with a freshly AI-generated one.
   * Called by Stage.vue after sending the message if messageAiRegenEnabled is true.
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

    // Actions
    onHandRaised,
    onHandLost,
    clearPendingMessage,
    applyRegenMessage,
  }
})
