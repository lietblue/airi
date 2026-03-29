import type { Bone, Object3D, Skeleton } from 'three'

/**
 * Find the root bone of a skeleton — the bone whose parent is not in the skeleton.
 *
 * NOTICE: Ported from vrm-c/bvh2vrma (MIT). Original:
 * https://github.com/vrm-c/bvh2vrma/blob/main/src/lib/bvh-converter/getRootBone.ts
 */
export function getRootBone(skeleton: Skeleton): Bone {
  const boneSet = new Set<Object3D>(skeleton.bones)

  for (const bone of skeleton.bones) {
    if (bone.parent == null || !boneSet.has(bone.parent))
      return bone
  }

  throw new Error('Invalid skeleton — could not find root bone.')
}
