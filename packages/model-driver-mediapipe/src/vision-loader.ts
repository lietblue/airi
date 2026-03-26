import type { VisionTaskModule } from './types'

/**
 * Lazily imports `@mediapipe/tasks-vision` and returns it typed as
 * `VisionTaskModule`.  Expose this from consumers that do not list
 * `@mediapipe/tasks-vision` in their own `package.json` so they can
 * avoid adding a redundant direct dependency.
 */
export function importTasksVision(): Promise<VisionTaskModule> {
  return import('@mediapipe/tasks-vision') as Promise<VisionTaskModule>
}
