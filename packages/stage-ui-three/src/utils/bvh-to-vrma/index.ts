/**
 * BVH → VRMA converter.
 *
 * Takes a BVH file (parsed by Three.js BVHLoader), maps the skeleton to VRM humanoid
 * bones via heuristics, and exports a .vrma GLB using GLTFExporter with the
 * VRMC_vrm_animation extension.
 *
 * NOTICE: Ported and adapted from vrm-c/bvh2vrma (MIT).
 * https://github.com/vrm-c/bvh2vrma
 */

import type { BVH } from 'three/examples/jsm/loaders/BVHLoader.js'

import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'

import { getRootBone } from './get-root-bone'
import { mapSkeletonToVRM } from './map-skeleton-to-vrm'
import { VRMAnimationExporterPlugin } from './vrm-animation-exporter-plugin'

export { getRootBone } from './get-root-bone'
export { mapSkeletonToVRM } from './map-skeleton-to-vrm'
export { pickByProbability } from './pick-by-probability'
export { VRMAnimationExporterPlugin } from './vrm-animation-exporter-plugin'
export { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js'

const BONE_NAME_RE = /\.bones\[(.*)\]/

/**
 * Detect if a position track uses a mixed format where the first frame stores
 * absolute position but subsequent frames store small deltas (relative offsets).
 *
 * NOTICE: Some BVH exporters produce this non-standard layout — frame 1 has
 * the absolute hips position (≈ OFFSET) while frame 2+ drops to near-zero
 * because they represent incremental movement. We detect this by checking if
 * the Y value between frame 0 and frame 1 drops by more than 50% of frame 0's
 * magnitude, and frame 1's Y is close to zero.
 */
function detectDeltaFrames(values: Float32Array): boolean {
  if (values.length < 6)
    return false
  const y0 = values[1]
  const y1 = values[4]
  // First frame has significant Y (standing height), second frame is near zero
  return Math.abs(y0) > 1 && Math.abs(y1) < Math.abs(y0) * 0.1
}

/**
 * Convert a delta-frame position track to absolute positions by accumulating
 * deltas on top of the first frame's absolute position.
 */
function accumulateDeltaFrames(values: Float32Array): void {
  // Frame 0 is already absolute; accumulate from frame 1 onward
  for (let i = 3; i < values.length; i += 3) {
    values[i] = values[i - 3] + values[i]
    values[i + 1] = values[i - 2] + values[i + 1]
    values[i + 2] = values[i - 1] + values[i + 2]
  }
}

/**
 * Controls how the hips position (root motion) is handled during conversion.
 * - `'keep'`    — Preserve full hips position track (all axes). Use for animations with
 *                 intentional root movement (walks, jumps).
 * - `'y-only'`  — Strip horizontal (X/Z) motion, keep only vertical (Y). The character
 *                 stays in place but retains vertical bob/crouch. **Default.**
 * - `'strip'`   — Remove hips position entirely — rotation only. Most stable for
 *                 idle/gesture animations with no meaningful root motion.
 */
export type RootMotionMode = 'keep' | 'y-only' | 'strip'

export interface ConvertBVHToVRMAOptions {
  /** Scale factor applied to bone positions. BVH is usually in cm, VRM expects ~meters. Default `0.01`. */
  scale?: number
  /** How to handle the hips position track (root motion). Default `'y-only'`. */
  rootMotion?: RootMotionMode
}

/**
 * Convert a parsed BVH to a VRMA GLB ArrayBuffer.
 */
export async function convertBVHToVRMA(
  bvh: BVH,
  options?: ConvertBVHToVRMAOptions,
): Promise<ArrayBuffer> {
  const scale = options?.scale ?? 0.01
  const rootMotion = options?.rootMotion ?? 'y-only'

  const skeleton = bvh.skeleton.clone()
  const clip = bvh.clip.clone()

  const rootBone = getRootBone(skeleton)

  // Scale skeleton to meters
  rootBone.traverse((bone) => {
    bone.position.multiplyScalar(scale)
  })
  rootBone.updateWorldMatrix(false, true)

  // Map BVH bones → VRM humanoid bones
  const vrmBoneMap = mapSkeletonToVRM(rootBone)
  rootBone.userData.vrmBoneMap = vrmBoneMap

  const hipsBone = vrmBoneMap.get('hips')!
  const hipsBoneName = hipsBone.name

  // Filter tracks: keep quaternion rotations + hips position only
  const filteredTracks: typeof clip.tracks = []

  for (const origTrack of bvh.clip.tracks) {
    const track = origTrack.clone()
    track.name = track.name.replace(BONE_NAME_RE, '$1')

    if (track.name.endsWith('.quaternion')) {
      filteredTracks.push(track)
    }

    if (track.name === `${hipsBoneName}.position` && rootMotion !== 'strip') {
      const scaled = track.clone()
      scaled.values = Float32Array.from(track.values, v => v * scale)

      // NOTICE: Some BVH exporters write frame 0 as absolute position and
      // frame 1+ as incremental deltas. Detect and fix by accumulating.
      if (detectDeltaFrames(scaled.values))
        accumulateDeltaFrames(scaled.values)

      // Subtract hips rest-pose offset so values become relative to rest.
      // NOTICE: This matches the original vrm-c/bvh2vrma approach. The playback
      // pipeline (reAnchorRootPositionTrack) re-anchors these relative values
      // to the target VRM model's hips position.
      const offset = hipsBone.position.toArray()
      for (let j = 0; j < scaled.values.length; j++)
        scaled.values[j] -= offset[j % 3]

      // Apply root motion mode on the already-relative values
      if (rootMotion === 'y-only') {
        // Lock X and Z to 0 (rest), keep only relative Y bob
        for (let i = 0; i < scaled.values.length; i += 3) {
          scaled.values[i] = 0
          scaled.values[i + 2] = 0
        }
      }

      filteredTracks.push(scaled)
    }
  }

  clip.tracks = filteredTracks

  // Export GLB with VRMC_vrm_animation extension
  const exporter = new GLTFExporter()
  exporter.register(writer => new VRMAnimationExporterPlugin(writer))

  const gltf = await exporter.parseAsync(rootBone, {
    animations: [clip],
    binary: true,
  })

  return gltf as ArrayBuffer
}
