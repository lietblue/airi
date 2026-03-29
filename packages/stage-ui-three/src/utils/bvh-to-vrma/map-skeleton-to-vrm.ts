import type { VRMHumanBoneName } from '@pixiv/three-vrm'
import type { Bone } from 'three'

import { Vector3 } from 'three'

import { pickByProbability } from './pick-by-probability'

/**
 * Heuristic mapper: walks a BVH skeleton hierarchy and assigns VRM humanoid bone names
 * using bone names, world positions, and bone lengths as signals.
 *
 * NOTICE: Ported from vrm-c/bvh2vrma (MIT). Original:
 * https://github.com/vrm-c/bvh2vrma/blob/main/src/lib/bvh-converter/mapSkeletonToVRM.ts
 */

const _v3A = new Vector3()

// --- Traversal helpers ---

function objectBFS(root: Bone, fn: (obj: Bone) => boolean | void): Bone | null {
  const queue: Bone[] = [root]
  while (queue.length > 0) {
    const obj = queue.shift()!
    if (fn(obj))
      return obj
    queue.push(...obj.children as Bone[])
  }
  return null
}

function objectTraverseFilter(root: Bone, fn: (obj: Bone) => boolean | void): Bone[] {
  const result: Bone[] = []
  root.traverse((obj) => {
    if (fn(obj as Bone))
      result.push(obj as Bone)
  })
  return result
}

function objectSearchAncestors(root: Bone, fn: (obj: Bone) => boolean | void): Bone | null {
  let obj: Bone | null = root
  while (obj != null) {
    if (fn(obj))
      return obj
    obj = obj.parent as Bone | null
  }
  return null
}

// --- Evaluator helpers ---

function evaluatorEqual(obj: unknown, another: unknown): number {
  return obj === another ? 1 : 0
}

function evaluatorName(obj: Bone, substring: string): number {
  return obj.name.toLowerCase().includes(substring) ? 1 : 0
}

// --- Bone determination ---

function determineSpineBones(
  hips: Bone,
  chestCand: Bone,
): [spine: Bone, chest: Bone, upperChest: Bone | null] {
  const spineBones: Bone[] = []
  objectSearchAncestors(chestCand, (obj) => {
    spineBones.unshift(obj)
    return obj === hips
  })

  if (spineBones.length < 3)
    throw new Error('Not enough spine bones.')

  if (spineBones.length === 3)
    return [spineBones[1], spineBones[2], null]

  if (spineBones.length === 4)
    return [spineBones[1], spineBones[2], spineBones[3]]

  // Too many spine bones — pick evenly spaced ones
  const n = spineBones.length - 1
  return [
    spineBones[Math.floor(n / 3.0)],
    spineBones[Math.floor((n / 3.0) * 2.0)],
    spineBones[n],
  ]
}

function determineLegBones(
  legRoot: Bone,
): [upperLeg: Bone, lowerLeg: Bone, foot: Bone, toes: Bone | null] {
  const bones: { bone: Bone, len: number, depth: number }[] = []
  let current: Bone | undefined = legRoot
  let depth = 0

  while (current != null) {
    const child = current.children[0] as Bone | undefined
    bones.push({ bone: current, depth, len: child?.position.length() ?? 0.0 })
    current = child
    depth++
  }

  if (bones.length < 3)
    throw new Error('Not enough leg bones.')

  const [upperLeg, lowerLeg] = bones
    .concat()
    .sort((a, b) => b.len - a.len)
    .slice(0, 2)
    .sort((a, b) => a.depth - b.depth)

  const foot = bones[lowerLeg.depth + 1]
  if (foot == null)
    throw new Error('Could not find the foot bone.')

  const toes = bones[foot.depth + 1]
  return [upperLeg.bone, lowerLeg.bone, foot.bone, toes?.bone ?? null]
}

function determineArmBones(
  armRoot: Bone,
): [shoulder: Bone | null, upperArm: Bone, lowerArm: Bone, hand: Bone] {
  const bones: { bone: Bone, len: number, depth: number }[] = []
  let current: Bone | undefined = armRoot
  let depth = 0

  while (current != null) {
    const child = current.children[0] as Bone | undefined
    bones.push({ bone: current, depth, len: child?.position.length() ?? 0.0 })
    current = child
    depth++
  }

  if (bones.length < 3)
    throw new Error('Not enough arm bones.')

  const [upperArm, lowerArm] = bones
    .concat()
    .sort((a, b) => b.len - a.len)
    .slice(0, 2)
    .sort((a, b) => a.depth - b.depth)

  const hand = bones[lowerArm.depth + 1]
  if (hand == null)
    throw new Error('Could not find the hand bone.')

  const shoulder = upperArm.depth !== 0 ? bones[upperArm.depth - 1] : null
  return [shoulder?.bone ?? null, upperArm.bone, lowerArm.bone, hand.bone]
}

function determineFingerBones(result: Map<VRMHumanBoneName, Bone>): void {
  const sides = ['left', 'right'] as const
  const handBones = {
    left: result.get('leftHand')!,
    right: result.get('rightHand')!,
  }

  const fingerNames = ['thumb', 'index', 'middle', 'ring', 'little'] as const
  const boneNames = {
    left: {
      thumb: ['leftThumbMetacarpal', 'leftThumbProximal', 'leftThumbDistal'] as const,
      index: ['leftIndexProximal', 'leftIndexIntermediate', 'leftIndexDistal'] as const,
      middle: ['leftMiddleProximal', 'leftMiddleIntermediate', 'leftMiddleDistal'] as const,
      ring: ['leftRingProximal', 'leftRingIntermediate', 'leftRingDistal'] as const,
      little: ['leftLittleProximal', 'leftLittleIntermediate', 'leftLittleDistal'] as const,
    },
    right: {
      thumb: ['rightThumbMetacarpal', 'rightThumbProximal', 'rightThumbDistal'] as const,
      index: ['rightIndexProximal', 'rightIndexIntermediate', 'rightIndexDistal'] as const,
      middle: ['rightMiddleProximal', 'rightMiddleIntermediate', 'rightMiddleDistal'] as const,
      ring: ['rightRingProximal', 'rightRingIntermediate', 'rightRingDistal'] as const,
      little: ['rightLittleProximal', 'rightLittleIntermediate', 'rightLittleDistal'] as const,
    },
  }

  for (const side of sides) {
    const handBone = handBones[side]
    const fingerRoots = handBone.children.concat()

    for (const finger of fingerNames) {
      const names = boneNames[side][finger]

      const fingerRoot = pickByProbability(fingerRoots, [
        { func: obj => evaluatorName(obj as Bone, finger), weight: 10.0 },
        { func: obj => (obj as Bone).getWorldPosition(_v3A).z, weight: 1.0 },
      ]) as Bone | null

      if (fingerRoot != null) {
        fingerRoots.splice(fingerRoots.indexOf(fingerRoot), 1)
        result.set(names[0], fingerRoot)

        const child1 = fingerRoot.children[0] as Bone | undefined
        if (child1 != null) {
          result.set(names[1], child1)
          const child2 = child1.children[0] as Bone | undefined
          if (child2 != null)
            result.set(names[2], child2)
        }
      }
    }
  }
}

function determineHeadBones(
  headRoot: Bone,
): [neck: Bone | null, head: Bone, leftEye: Bone | null, rightEye: Bone | null] {
  let head = headRoot

  // Neck may have multiple bones; walk until we find a branch
  while (head.children.length === 1)
    head = head.children[0] as Bone

  const neck = headRoot === head ? null : headRoot

  let leftEye: Bone | null = null
  let rightEye: Bone | null = null

  if (head.children.length > 0) {
    leftEye = pickByProbability(head.children as Bone[], [
      { func: obj => evaluatorName(obj, 'lefteye'), weight: 10.0 },
      { func: obj => evaluatorName(obj, 'l_faceeye'), weight: 10.0 },
      { func: obj => evaluatorName(obj, 'eye'), weight: 1.0 },
      { func: obj => obj.getWorldPosition(_v3A).x, weight: 1.0 },
    ])

    rightEye = pickByProbability(head.children as Bone[], [
      { func: obj => evaluatorEqual(obj, leftEye), weight: -100.0 },
      { func: obj => evaluatorName(obj, 'righteye'), weight: 10.0 },
      { func: obj => evaluatorName(obj, 'r_faceeye'), weight: 10.0 },
      { func: obj => evaluatorName(obj, 'eye'), weight: 1.0 },
      { func: obj => -obj.getWorldPosition(_v3A).x, weight: 1.0 },
    ])
  }

  return [neck, head, leftEye, rightEye]
}

// --- Main mapper ---

export function mapSkeletonToVRM(root: Bone): Map<VRMHumanBoneName, Bone> {
  const result = new Map<VRMHumanBoneName, Bone>()

  // Hips = first descendant with ≥ 3 children
  const hips = objectBFS(root, obj => obj.children.length >= 3)
  if (hips == null)
    throw new Error('Cannot find hips.')
  result.set('hips', hips)

  // Chest candidate = descendant of hips with ≥ 3 children
  const chestCands = objectTraverseFilter(hips, obj => obj !== hips && obj.children.length >= 3)
  const chestCand = pickByProbability(chestCands, [
    { func: obj => evaluatorName(obj, 'upperchest'), weight: 1.0 },
    { func: obj => evaluatorName(obj, 'chest'), weight: 1.0 },
  ])
  if (chestCand == null)
    throw new Error('Cannot find chest.')

  const [spine, chest, upperChest] = determineSpineBones(hips, chestCand)
  result.set('spine', spine)
  result.set('chest', chest)
  if (upperChest != null)
    result.set('upperChest', upperChest)

  // Legs
  const leftLegRoot = pickByProbability(hips.children as Bone[], [
    { func: obj => evaluatorName(obj, 'leftupperleg'), weight: 10.0 },
    { func: obj => evaluatorName(obj, 'l_upperleg'), weight: 10.0 },
    { func: obj => evaluatorName(obj, 'leg'), weight: 1.0 },
    { func: obj => obj.getWorldPosition(_v3A).x, weight: 1.0 },
  ])!
  const rightLegRoot = pickByProbability(hips.children as Bone[], [
    { func: obj => evaluatorEqual(obj, leftLegRoot), weight: -100.0 },
    { func: obj => evaluatorName(obj, 'rightupperleg'), weight: 10.0 },
    { func: obj => evaluatorName(obj, 'r_upperleg'), weight: 10.0 },
    { func: obj => evaluatorName(obj, 'leg'), weight: 1.0 },
    { func: obj => -obj.getWorldPosition(_v3A).x, weight: 1.0 },
  ])!

  const [leftUpperLeg, leftLowerLeg, leftFoot, leftToes] = determineLegBones(leftLegRoot)
  result.set('leftUpperLeg', leftUpperLeg)
  result.set('leftLowerLeg', leftLowerLeg)
  result.set('leftFoot', leftFoot)
  if (leftToes != null)
    result.set('leftToes', leftToes)

  const [rightUpperLeg, rightLowerLeg, rightFoot, rightToes] = determineLegBones(rightLegRoot)
  result.set('rightUpperLeg', rightUpperLeg)
  result.set('rightLowerLeg', rightLowerLeg)
  result.set('rightFoot', rightFoot)
  if (rightToes != null)
    result.set('rightToes', rightToes)

  // Arms
  const leftArmRoot = pickByProbability(chestCand.children as Bone[], [
    { func: obj => evaluatorName(obj, 'leftshoulder'), weight: 10.0 },
    { func: obj => evaluatorName(obj, 'l_shoulder'), weight: 10.0 },
    { func: obj => evaluatorName(obj, 'leftupperarm'), weight: 10.0 },
    { func: obj => evaluatorName(obj, 'l_upperarm'), weight: 10.0 },
    { func: obj => evaluatorName(obj, 'shoulder'), weight: 1.0 },
    { func: obj => evaluatorName(obj, 'arm'), weight: 1.0 },
    { func: obj => obj.getWorldPosition(_v3A).x, weight: 1.0 },
  ])!
  const rightArmRoot = pickByProbability(chestCand.children as Bone[], [
    { func: obj => evaluatorEqual(obj, leftArmRoot), weight: -100.0 },
    { func: obj => evaluatorName(obj, 'rightshoulder'), weight: 10.0 },
    { func: obj => evaluatorName(obj, 'r_shoulder'), weight: 10.0 },
    { func: obj => evaluatorName(obj, 'rightupperarm'), weight: 10.0 },
    { func: obj => evaluatorName(obj, 'r_upperarm'), weight: 10.0 },
    { func: obj => evaluatorName(obj, 'shoulder'), weight: 1.0 },
    { func: obj => evaluatorName(obj, 'arm'), weight: 1.0 },
    { func: obj => -obj.getWorldPosition(_v3A).x, weight: 1.0 },
  ])!

  const headRoot = pickByProbability(chestCand.children as Bone[], [
    { func: obj => evaluatorEqual(obj, leftArmRoot), weight: -100.0 },
    { func: obj => evaluatorEqual(obj, rightArmRoot), weight: -100.0 },
    { func: obj => evaluatorName(obj, 'neck'), weight: 1.0 },
    { func: obj => evaluatorName(obj, 'head'), weight: 1.0 },
    { func: obj => Math.abs(obj.getWorldPosition(_v3A).x), weight: -1.0 },
  ])!

  const [leftShoulder, leftUpperArm, leftLowerArm, leftHand] = determineArmBones(leftArmRoot)
  if (leftShoulder != null)
    result.set('leftShoulder', leftShoulder)
  result.set('leftUpperArm', leftUpperArm)
  result.set('leftLowerArm', leftLowerArm)
  result.set('leftHand', leftHand)

  const [rightShoulder, rightUpperArm, rightLowerArm, rightHand] = determineArmBones(rightArmRoot)
  if (rightShoulder != null)
    result.set('rightShoulder', rightShoulder)
  result.set('rightUpperArm', rightUpperArm)
  result.set('rightLowerArm', rightLowerArm)
  result.set('rightHand', rightHand)

  // Fingers
  determineFingerBones(result)

  // Head
  const [neck, head, leftEye, rightEye] = determineHeadBones(headRoot)
  if (neck != null)
    result.set('neck', neck)
  result.set('head', head)
  if (leftEye != null)
    result.set('leftEye', leftEye)
  if (rightEye != null)
    result.set('rightEye', rightEye)

  return result
}
