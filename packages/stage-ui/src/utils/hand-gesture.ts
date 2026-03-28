/**
 * Shared hand gesture detection utilities.
 *
 * Extracted from the hand-tracker devtools page so both the production
 * HandGazeFeature and the devtools page use the same logic.
 */

/** Minimum number of MediaPipe hand landmarks required for gesture detection. */
const MIN_LANDMARKS = 21

/** Hysteresis thresholds — avoids flickering near the boundary. */
const OPEN_THRESH = 0.75 // at least 3 of 4 fingers extended
const CLOSE_THRESH = 0.25 // at most 1 finger extended

/**
 * Compute hand openness from MediaPipe hand landmarks.
 *
 * In image coordinates y increases downward; a finger is extended when its
 * tip sits higher (smaller y) than its proximal-intermediate joint (PIP).
 *
 * @returns 0 (fist) to 1 (fully open). Returns 0 if fewer than 21 landmarks.
 */
export function computeOpenness(landmarks: { x: number, y: number }[]): number {
  if (landmarks.length < MIN_LANDMARKS)
    return 0
  // [fingertip index, PIP index] for the four main fingers (excluding thumb)
  const fingers: [number, number][] = [[8, 6], [12, 10], [16, 14], [20, 18]]
  const extended = fingers.filter(([tip, pip]) => landmarks[tip].y < landmarks[pip].y).length
  return extended / 4
}

export interface GestureStateMachineCallbacks {
  /** Fired when the hand transitions from closed to open. */
  onOpen?: () => void
  /** Fired when the hand transitions from open to closed (a "clap"). */
  onClose?: () => void
  /** Fired when a full open→close cycle completes (intentional gesture). */
  onOpenClose?: () => void
}

export interface GestureStateMachine {
  /** Feed the current openness value (0–1) each frame. */
  process: (openness: number) => void
  /** Reset internal state (call when hand tracking is lost). */
  reset: () => void
}

/**
 * Create a gesture state machine with hysteresis.
 *
 * Tracks open/close transitions and fires callbacks accordingly.
 * The `onOpenClose` callback fires when the hand opens then closes — an
 * intentional gesture that is more robust against false positives than
 * reacting to a single transition.
 */
export function createGestureStateMachine(callbacks: GestureStateMachineCallbacks): GestureStateMachine {
  let isOpen = false
  let hasOpenedThisCycle = false

  function process(openness: number) {
    if (!isOpen && openness >= OPEN_THRESH) {
      isOpen = true
      hasOpenedThisCycle = true
      callbacks.onOpen?.()
    }
    else if (isOpen && openness <= CLOSE_THRESH) {
      isOpen = false
      callbacks.onClose?.()
      if (hasOpenedThisCycle) {
        callbacks.onOpenClose?.()
        hasOpenedThisCycle = false
      }
    }
  }

  function reset() {
    isOpen = false
    hasOpenedThisCycle = false
  }

  return { process, reset }
}
