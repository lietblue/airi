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

      if (rootMotion === 'y-only') {
        // NOTICE: Use the hips rest-pose position as the base, then add only
        // relative Y delta from the first BVH frame. This ensures the first
        // frame exactly matches the skeleton rest pose, which is what
        // createVRMAnimationClip and reAnchorRootPositionTrack both expect.
        // Absolute BVH Y values would mismatch the VRM model and cause falling.
        const restX = hipsBone.position.x
        const restY = hipsBone.position.y
        const restZ = hipsBone.position.z
        const firstY = scaled.values[1]
        for (let i = 0; i < scaled.values.length; i += 3) {
          const relativeY = scaled.values[i + 1] - firstY
          scaled.values[i] = restX
          scaled.values[i + 1] = restY + relativeY
          scaled.values[i + 2] = restZ
        }
      }

      filteredTracks.push(scaled)
    }
  }

  clip.tracks = filteredTracks

  // NOTICE: Do NOT subtract the hips rest-pose offset from the position track.
  // The playback pipeline (reAnchorRootPositionTrack) expects absolute position
  // values and re-anchors them to the target VRM model. Subtracting the rest
  // offset here would double-correct and cause the character to drop to y=0.

  // Export GLB with VRMC_vrm_animation extension
  const exporter = new GLTFExporter()
  exporter.register(writer => new VRMAnimationExporterPlugin(writer))

  const gltf = await exporter.parseAsync(rootBone, {
    animations: [clip],
    binary: true,
  })

  return gltf as ArrayBuffer
}
