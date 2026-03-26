import type { GLTF } from 'three/addons/loaders/GLTFLoader.js'

import { VRMAnimationLoaderPlugin } from '@pixiv/three-vrm-animation'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

/**
 * Detect the total duration (in milliseconds) of a .vrma animation file.
 * Loads the GLTF and reads the first animation clip duration.
 * Returns undefined if detection fails.
 */
export async function detectVrmaDurationMs(file: File): Promise<number | undefined> {
  const url = URL.createObjectURL(file)
  try {
    const loader = new GLTFLoader()
    loader.register(parser => new VRMAnimationLoaderPlugin(parser))
    const gltf = await new Promise<GLTF>((resolve, reject) => {
      loader.load(url, resolve, undefined, reject)
    })
    const durationSec: number | undefined = gltf.animations?.[0]?.duration
    return durationSec !== undefined ? Math.round(durationSec * 1000) : undefined
  }
  catch (err) {
    console.warn('[detectVrmaDurationMs] failed:', err)
    return undefined
  }
  finally {
    URL.revokeObjectURL(url)
  }
}
