import type {
  Category,
  FaceLandmarker,
  FaceLandmarkerResult,
  HandLandmarker,
  HandLandmarkerResult,
  Landmark,
  NormalizedLandmark,
  PoseLandmarker,
  PoseLandmarkerResult,
} from '@mediapipe/tasks-vision'

import type { MocapBackend, MocapConfig, MocapJob, PerceptionPartial, VisionTaskModule, VisionTaskWasmFileset } from '../types'

import { Semaphore } from 'es-toolkit'

import { visionTaskAssets, visionTaskWasmRoot } from '../../tasks/tasks'

export function createMediaPipeBackend(): MocapBackend {
  const semaphore = new Semaphore(1)
  let busy = false
  let config: MocapConfig | undefined
  let tasksVision: VisionTaskModule | undefined
  let vision: VisionTaskWasmFileset | undefined

  let poseLandmarker: PoseLandmarker | undefined
  let handLandmarker: HandLandmarker | undefined
  let faceLandmarker: FaceLandmarker | undefined

  async function init(nextConfig: MocapConfig) {
    config = nextConfig

    if (!tasksVision)
      tasksVision = await import('@mediapipe/tasks-vision')

    if (!vision) {
      const { FilesetResolver } = tasksVision
      vision = await FilesetResolver.forVisionTasks(visionTaskWasmRoot)
    }
  }

  function isBusy() {
    return busy
  }

  // Returns the configured delegate, defaulting to 'GPU' for best performance.
  // Callers that need CPU explicitly can pass delegate: 'CPU' in MocapConfig.
  function resolveDelegate(): 'GPU' | 'CPU' {
    return config?.delegate ?? 'GPU'
  }

  async function ensurePoseLandmarker() {
    if (poseLandmarker)
      return poseLandmarker

    const { PoseLandmarker } = tasksVision!
    const delegate = resolveDelegate()
    try {
      poseLandmarker = await PoseLandmarker.createFromOptions(vision!, {
        baseOptions: { modelAssetPath: visionTaskAssets.pose, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
      })
    }
    catch {
      // NOTICE: GPU delegate is unavailable on some devices/browsers (older Windows drivers,
      // Firefox without WebGL2, etc.). Fall back to CPU so inference still works.
      poseLandmarker = await PoseLandmarker.createFromOptions(vision!, {
        baseOptions: { modelAssetPath: visionTaskAssets.pose, delegate: 'CPU' },
        runningMode: 'VIDEO',
        numPoses: 1,
      })
    }

    return poseLandmarker
  }

  async function ensureHandLandmarker() {
    if (handLandmarker)
      return handLandmarker

    const { HandLandmarker } = tasksVision!
    const delegate = resolveDelegate()
    try {
      handLandmarker = await HandLandmarker.createFromOptions(vision!, {
        baseOptions: { modelAssetPath: visionTaskAssets.hands, delegate },
        runningMode: 'VIDEO',
        numHands: 2,
      })
    }
    catch {
      // NOTICE: GPU delegate fallback — see ensurePoseLandmarker for context.
      handLandmarker = await HandLandmarker.createFromOptions(vision!, {
        baseOptions: { modelAssetPath: visionTaskAssets.hands, delegate: 'CPU' },
        runningMode: 'VIDEO',
        numHands: 2,
      })
    }

    return handLandmarker
  }

  async function ensureFaceLandmarker() {
    if (faceLandmarker)
      return faceLandmarker

    const { FaceLandmarker } = tasksVision!
    const delegate = resolveDelegate()
    try {
      faceLandmarker = await FaceLandmarker.createFromOptions(vision!, {
        baseOptions: { modelAssetPath: visionTaskAssets.face, delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
      })
    }
    catch {
      // NOTICE: GPU delegate fallback — see ensurePoseLandmarker for context.
      faceLandmarker = await FaceLandmarker.createFromOptions(vision!, {
        baseOptions: { modelAssetPath: visionTaskAssets.face, delegate: 'CPU' },
        runningMode: 'VIDEO',
        numFaces: 1,
      })
    }

    return faceLandmarker
  }

  async function run(frame: TexImageSource, jobs: MocapJob[], nowMs: number): Promise<PerceptionPartial> {
    if (!config)
      throw new Error('MediaPipe backend not initialized (call init() first)')

    await semaphore.acquire()
    busy = true
    try {
      const partial: PerceptionPartial = {}

      for (const job of jobs) {
        if (!config.enabled[job])
          continue

        if (job === 'pose') {
          const landmarker = await ensurePoseLandmarker()
          const res: PoseLandmarkerResult = landmarker.detectForVideo(frame, nowMs)
          const firstPose: NormalizedLandmark[] = res.landmarks[0] ?? []
          const firstWorld: Landmark[] = res.worldLandmarks[0] ?? []
          partial.pose = {
            landmarks2d: firstPose,
            worldLandmarks: firstWorld.map(p => ({
              x: p.x,
              y: p.y,
              z: p.z,
              visibility: p.visibility,
            })),
          }
        }
        else if (job === 'hands') {
          const landmarker = await ensureHandLandmarker()
          const res: HandLandmarkerResult = landmarker.detectForVideo(frame, nowMs)
          const landmarks: NormalizedLandmark[][] = res.landmarks ?? []
          const handedness: Category[][] = res.handedness ?? []

          partial.hands = landmarks.map((lm, i) => {
            const mostLikelyCategory = handedness[i]?.[0]
            const categoryName = mostLikelyCategory?.categoryName
            const score = mostLikelyCategory?.score
            const handed = categoryName === 'Left' || categoryName === 'Right' ? categoryName : 'Right'
            return {
              handedness: handed,
              landmarks2d: lm,
              score,
            }
          })
        }
        else if (job === 'face') {
          const landmarker = await ensureFaceLandmarker()
          const res: FaceLandmarkerResult = landmarker.detectForVideo(frame, nowMs)
          const firstFace: NormalizedLandmark[] = res.faceLandmarks?.[0] ?? []
          partial.face = {
            hasFace: firstFace.length > 0,
            landmarks2d: firstFace,
          }
        }
      }

      return partial
    }
    finally {
      busy = false
      semaphore.release()
    }
  }

  return {
    init,
    isBusy,
    run,
  }
}
