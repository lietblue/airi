import type { VRMHumanBoneName } from '@pixiv/three-vrm'
import type { Object3D } from 'three'

/**
 * GLTFExporter plugin that injects the VRMC_vrm_animation extension into the
 * exported glTF, mapping skeleton nodes to VRM humanoid bone names.
 *
 * NOTICE: Ported from vrm-c/bvh2vrma (MIT). Original:
 * https://github.com/vrm-c/bvh2vrma/blob/main/src/lib/bvh-converter/VRMAnimationExporterPlugin.ts
 *
 * Uses `(writer as any)` to access internal GLTFWriter properties (`nodeMap`, `json`)
 * because Three.js does not expose a public API for these.
 */

const EXTENSION_NAME = 'VRMC_vrm_animation'

export class VRMAnimationExporterPlugin {
  public readonly writer: any
  public readonly name = EXTENSION_NAME

  constructor(writer: any) {
    this.writer = writer
  }

  public afterParse(input: Object3D | Object3D[]): void {
    if (!Array.isArray(input))
      return

    const root = input[0]
    const vrmBoneMap: Map<VRMHumanBoneName, Object3D> | undefined = root.userData?.vrmBoneMap
    if (vrmBoneMap == null)
      return

    const humanBones: Record<string, { node: number }> = {}
    for (const [boneName, bone] of vrmBoneMap) {
      const node = this.writer.nodeMap.get(bone)
      if (node != null)
        humanBones[boneName] = { node }
    }

    const gltfDef = this.writer.json
    gltfDef.extensionsUsed ??= []
    gltfDef.extensionsUsed.push(EXTENSION_NAME)
    gltfDef.extensions ??= {}
    gltfDef.extensions[EXTENSION_NAME] = {
      specVersion: '1.0',
      humanoid: { humanBones },
    }
  }
}
