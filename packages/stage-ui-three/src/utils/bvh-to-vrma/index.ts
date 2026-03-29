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

import { Box3, Vector3 } from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'

import { getRootBone } from './get-root-bone'
import { mapSkeletonToVRM } from './map-skeleton-to-vrm'
import { VRMAnimationExporterPlugin } from './vrm-animation-exporter-plugin'

export { getRootBone } from './get-root-bone'
export { mapSkeletonToVRM } from './map-skeleton-to-vrm'
export { pickByProbability } from './pick-by-probability'
export { VRMAnimationExporterPlugin } from './vrm-animation-exporter-plugin'

const _v3A = new Vector3()
const BONE_NAME_RE = /\.bones\[(.*)\]/

function createSkeletonBoundingBox(bones: readonly { getWorldPosition: (v: Vector3) => Vector3 }[]): Box3 {
  const box = new Box3()
  for (const bone of bones)
    box.expandByPoint(bone.getWorldPosition(_v3A))
  return box
}

export interface ConvertBVHToVRMAOptions {
  /** Scale factor applied to bone positions. BVH is usually in cm, VRM expects ~meters. Default `0.01`. */
  scale?: number
}

/**
 * Convert a parsed BVH to a VRMA GLB ArrayBuffer.
 */
export async function convertBVHToVRMA(
  bvh: BVH,
  options?: ConvertBVHToVRMAOptions,
): Promise<ArrayBuffer> {
  const scale = options?.scale ?? 0.01

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
  let hipsPositionTrack: (typeof clip.tracks)[number] | null = null

  for (const origTrack of bvh.clip.tracks) {
    const track = origTrack.clone()
    track.name = track.name.replace(BONE_NAME_RE, '$1')

    if (track.name.endsWith('.quaternion')) {
      filteredTracks.push(track)
    }

    if (track.name === `${hipsBoneName}.position`) {
      const scaled = track.clone()
      scaled.values = Float32Array.from(track.values, v => v * scale)
      hipsPositionTrack = scaled
      filteredTracks.push(scaled)
    }
  }

  clip.tracks = filteredTracks

  // Remove rest-pose offset from hips position track
  if (hipsPositionTrack != null) {
    const offset = hipsBone.position.toArray()
    for (let i = 0; i < hipsPositionTrack.values.length; i++)
      hipsPositionTrack.values[i] -= offset[i % 3]
  }

  // Ground the skeleton if it dips below y=0
  const boundingBox = createSkeletonBoundingBox(skeleton.bones)
  if (boundingBox.min.y < 0)
    rootBone.position.y -= boundingBox.min.y

  // Export GLB with VRMC_vrm_animation extension
  const exporter = new GLTFExporter()
  exporter.register(writer => new VRMAnimationExporterPlugin(writer))

  const gltf = await exporter.parseAsync(rootBone, {
    animations: [clip],
    binary: true,
  })

  return gltf as ArrayBuffer
}
