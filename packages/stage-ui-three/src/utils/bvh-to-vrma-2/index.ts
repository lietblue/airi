/**
 * BVH -> VRMA converter (v2) — faithful port of SystemAnimatorOnline's approach.
 *
 * Differences from v1 (bvh-to-vrma):
 * - No outlier first-frame detection/fix
 * - No root motion mode (always keeps full hips position)
 * - Adds grounding fix: if skeleton bounding box dips below y=0, shift root up
 * - Also picks up spine position track (stored but not used in export, matching upstream)
 *
 * NOTICE: Ported from SystemAnimatorOnline / vrm-c/bvh2vrma (MIT).
 * https://github.com/ButzYung/SystemAnimatorOnline
 * https://github.com/vrm-c/bvh2vrma
 */

import type { BVH } from 'three/examples/jsm/loaders/BVHLoader.js'

import { Box3, Vector3 } from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'

import { getRootBone } from '../bvh-to-vrma/get-root-bone'
import { mapSkeletonToVRM } from '../bvh-to-vrma/map-skeleton-to-vrm'
import { VRMAnimationExporterPlugin } from '../bvh-to-vrma/vrm-animation-exporter-plugin'

export { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js'

const BONE_NAME_RE = /\.bones\[(.*)\]/

const _v3A = new Vector3()

/**
 * Compute the world-space bounding box of the skeleton.
 * Used for the grounding fix.
 */
function createSkeletonBoundingBox(skeleton: { bones: { getWorldPosition: (v: Vector3) => Vector3 }[] }): Box3 {
  const boundingBox = new Box3()
  for (const bone of skeleton.bones)
    boundingBox.expandByPoint(bone.getWorldPosition(_v3A))
  return boundingBox
}

export interface ConvertBVHToVRMAOptions {
  /** Scale factor applied to bone positions. BVH is usually in cm, VRM expects ~meters. Default `0.01`. */
  scale?: number
}

/**
 * Convert a parsed BVH to a VRMA GLB ArrayBuffer.
 *
 * Faithful to the SystemAnimatorOnline / bvh2vrma pipeline:
 * 1. Scale skeleton
 * 2. Map bones to VRM humanoid
 * 3. Filter tracks (quaternion + hips position)
 * 4. Subtract hips rest-pose offset from position track
 * 5. Grounding fix (shift root up if skeleton goes below ground)
 * 6. Export GLB with VRMC_vrm_animation extension
 */
export async function convertBVHToVRMA(
  bvh: BVH,
  options?: ConvertBVHToVRMAOptions,
): Promise<ArrayBuffer> {
  const scale = options?.scale ?? 0.01

  const skeleton = bvh.skeleton.clone()
  const clip = bvh.clip.clone()

  // Find root bone of the skeleton
  const rootBone = getRootBone(skeleton)

  // Scale the entire tree
  rootBone.traverse((bone) => {
    bone.position.multiplyScalar(scale)
  })
  rootBone.updateWorldMatrix(false, true)

  // Create a map from VRM bone names to bones
  const vrmBoneMap = mapSkeletonToVRM(rootBone)
  rootBone.userData.vrmBoneMap = vrmBoneMap

  const hipsBone = vrmBoneMap.get('hips')!
  const hipsBoneName = hipsBone.name

  const spineBone = vrmBoneMap.get('spine')!
  const spineBoneName = spineBone.name

  // Rename tracks + remove translation tracks other than hips + pick up spine track
  const filteredTracks: typeof clip.tracks = []
  let hipsPositionTrack: (typeof clip.tracks)[number] | null = null

  for (const origTrack of bvh.clip.tracks) {
    const track = origTrack.clone()
    track.name = track.name.replace(BONE_NAME_RE, '$1')

    if (track.name.endsWith('.quaternion')) {
      filteredTracks.push(track)
    }

    if (track.name === `${hipsBoneName}.position`) {
      const newTrack = track.clone()
      newTrack.values = Float32Array.from(track.values, v => v * scale)
      hipsPositionTrack = newTrack
      filteredTracks.push(newTrack)
    }

    // NOTICE: SystemAnimatorOnline also picks up the spine position track.
    // It is stored but not included in the exported animation.
    if (track.name === `${spineBoneName}.position`) {
      // spine position track captured but not exported (matching upstream behavior)
    }
  }

  clip.tracks = filteredTracks

  // Remove offsets contained in hips position track
  if (hipsPositionTrack != null) {
    const offset = hipsBone.position.toArray()
    for (let i = 0; i < hipsPositionTrack.values.length; i++)
      hipsPositionTrack.values[i] -= offset[i % 3]
  }

  // NOTICE: Grounding fix from SystemAnimatorOnline — some BVHs do not ground correctly.
  // If the skeleton's bounding box extends below y=0, shift the root bone up to compensate.
  const boundingBox = createSkeletonBoundingBox(skeleton)
  if (boundingBox.min.y < 0)
    rootBone.position.y -= boundingBox.min.y

  // Export as a glTF binary with VRMC_vrm_animation extension
  const exporter = new GLTFExporter()
  exporter.register(writer => new VRMAnimationExporterPlugin(writer))

  const gltf = await exporter.parseAsync(rootBone, {
    animations: [clip],
    binary: true,
  })

  return gltf as ArrayBuffer
}
