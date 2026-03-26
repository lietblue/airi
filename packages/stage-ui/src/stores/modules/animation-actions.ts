import localforage from 'localforage'

import { detectVrmaDurationMs } from '@proj-airi/stage-ui-three'
import { animations } from '@proj-airi/stage-ui-three/assets/vrm'
import { until } from '@vueuse/core'
import { nanoid } from 'nanoid'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export interface ActionEntry {
  id: string
  name: string
  description: string
  /** URL to the .vrma file (built-in: asset URL; custom: blob URL created from stored File) */
  vrmaUrl: string
  isBuiltin: boolean
  /** Duration of the animation in milliseconds, detected on import */
  durationMs?: number
  /**
   * Idle actions loop continuously and are eligible for random idle rotation.
   * Non-idle actions are one-shot performances that return to idle when done.
   */
  isIdle: boolean
  /**
   * Whether to loop the animation. Defaults to true for idle actions, false for non-idle.
   * When false, the animation plays once then returns to a random idle action.
   */
  loop: boolean
  /** Optional background audio URL (blob or external) */
  bgMusicUrl?: string
  /** Optional background video URL (shown behind Three.js canvas) */
  bgVideoUrl?: string
  /** Optional foreground video URL (shown in front of Three.js canvas, pointer-events-none) */
  fgVideoUrl?: string
  enabled: boolean
  importedAt: number
}

// NOTICE: localforage key prefix for custom animation actions
const LOCALFORAGE_KEY_PREFIX = 'animation-action-'

interface StoredCustomAction {
  id: string
  name: string
  description: string
  file: File
  durationMs?: number
  isIdle: boolean
  loop: boolean
  bgMusicFile?: File
  bgVideoFile?: File
  fgVideoFile?: File
  bgMusicUrl?: string
  bgVideoUrl?: string
  fgVideoUrl?: string
  enabled: boolean
  importedAt: number
}

// Built-in action definitions — each entry only specifies what differs from defaults.
const BUILTIN_DEFAULTS = {
  isBuiltin: true as const,
  isIdle: false,
  loop: false,
  durationMs: undefined as number | undefined,
  enabled: true,
  importedAt: 0,
}

const builtinActionSources: Array<{
  id: string
  name: string
  description: string
  url: URL
  isIdle?: boolean
  loop?: boolean
}> = [
  { id: 'idle_loop', name: 'Idle', description: 'Idle standing animation, loops continuously', url: animations.idleLoop, isIdle: true, loop: true },
  { id: 'relax', name: 'Relax', description: 'Relaxed, casual resting pose', url: animations.relax },
  { id: 'thinking', name: 'Thinking', description: 'Thoughtful, pondering pose', url: animations.thinking },
  { id: 'clapping', name: 'Clapping', description: 'Clapping with both hands enthusiastically', url: animations.clapping },
  { id: 'goodbye', name: 'Goodbye', description: 'Farewell wave gesture', url: animations.goodbye },
  { id: 'blush', name: 'Blush', description: 'Bashful, blushing pose', url: animations.blush },
  { id: 'angry', name: 'Angry', description: 'Expresses anger with body language', url: animations.angry },
  { id: 'sad', name: 'Sad', description: 'Sad, downcast pose', url: animations.sad },
  { id: 'surprised', name: 'Surprised', description: 'Surprised, startled reaction', url: animations.surprised },
  { id: 'jump', name: 'Jump', description: 'Jumping animation', url: animations.jump },
  { id: 'lookAround', name: 'Look Around', description: 'Looking around curiously', url: animations.lookAround },
  { id: 'sleepy', name: 'Sleepy', description: 'Tired, sleepy animation', url: animations.sleepy },
]

const builtinActions: ActionEntry[] = builtinActionSources.map(({ url, ...src }) => ({
  ...BUILTIN_DEFAULTS,
  ...src,
  vrmaUrl: url.toString(),
}))

// Duration detection is delegated to stage-ui-three to keep three.js out of stage-ui deps

/** Track blob URLs created from custom action files so we can revoke them on cleanup */
const customActionBlobUrls = new Map<string, { vrmaUrl: string, bgMusicUrl?: string, bgVideoUrl?: string, fgVideoUrl?: string }>()

function revokeBlobUrls(entry: { vrmaUrl: string, bgMusicUrl?: string, bgVideoUrl?: string, fgVideoUrl?: string }) {
  if (entry.vrmaUrl.startsWith('blob:'))
    URL.revokeObjectURL(entry.vrmaUrl)
  if (entry.bgMusicUrl?.startsWith('blob:'))
    URL.revokeObjectURL(entry.bgMusicUrl)
  if (entry.bgVideoUrl?.startsWith('blob:'))
    URL.revokeObjectURL(entry.bgVideoUrl)
  if (entry.fgVideoUrl?.startsWith('blob:'))
    URL.revokeObjectURL(entry.fgVideoUrl)
}

export const useAnimationActionsStore = defineStore('animation-actions', () => {
  const actions = ref<ActionEntry[]>([...builtinActions])
  const currentActionId = ref<string>('idle_loop')
  const loading = ref(false)

  const currentAction = computed(() =>
    actions.value.find(a => a.id === currentActionId.value),
  )

  const currentActionUrl = computed(
    () => currentAction.value?.vrmaUrl ?? animations.idleLoop.toString(),
  )

  const currentBgMusicUrl = computed(() => currentAction.value?.bgMusicUrl)
  const currentBgVideoUrl = computed(() => currentAction.value?.bgVideoUrl)
  const currentFgVideoUrl = computed(() => currentAction.value?.fgVideoUrl)

  /** Pick a random enabled idle action. Falls back to idle_loop if none found. */
  function pickRandomIdle(): string {
    const idleActions = actions.value.filter(a => a.enabled && a.isIdle)
    if (idleActions.length === 0)
      return 'idle_loop'
    return idleActions[Math.floor(Math.random() * idleActions.length)].id
  }

  async function loadCustomActionsFromIndexedDB() {
    await until(loading).toBe(false)
    loading.value = true

    try {
      const customEntries: ActionEntry[] = []

      await localforage.iterate<StoredCustomAction, void>((val, key) => {
        if (!key.startsWith(LOCALFORAGE_KEY_PREFIX))
          return

        // Create blob URLs for the stored files
        const vrmaUrl = URL.createObjectURL(val.file)
        const bgMusicUrl = val.bgMusicFile
          ? URL.createObjectURL(val.bgMusicFile)
          : val.bgMusicUrl
        const bgVideoUrl = val.bgVideoFile
          ? URL.createObjectURL(val.bgVideoFile)
          : val.bgVideoUrl
        const fgVideoUrl = val.fgVideoFile
          ? URL.createObjectURL(val.fgVideoFile)
          : val.fgVideoUrl

        // Track blob URLs for cleanup
        customActionBlobUrls.set(val.id, { vrmaUrl, bgMusicUrl, bgVideoUrl, fgVideoUrl })

        customEntries.push({
          id: val.id,
          name: val.name,
          description: val.description,
          vrmaUrl,
          isBuiltin: false,
          durationMs: val.durationMs,
          // Stored actions before this field existed default to non-idle, no loop
          isIdle: val.isIdle ?? false,
          loop: val.loop ?? false,
          bgMusicUrl,
          bgVideoUrl,
          fgVideoUrl,
          enabled: val.enabled,
          importedAt: val.importedAt,
        })
      })

      // Merge: built-ins first, then custom sorted by import time (newest first)
      actions.value = [
        ...builtinActions,
        ...customEntries.sort((a, b) => b.importedAt - a.importedAt),
      ]
    }
    catch (err) {
      console.error('[animation-actions] failed to load from IndexedDB:', err)
    }
    finally {
      loading.value = false
    }
  }

  async function addCustomAction(file: File, name: string, description: string): Promise<ActionEntry> {
    const id = `animation-action-${nanoid()}`
    const importedAt = Date.now()

    const durationMs = await detectVrmaDurationMs(file)
    const vrmaUrl = URL.createObjectURL(file)

    customActionBlobUrls.set(id, { vrmaUrl })

    const entry: ActionEntry = {
      id,
      name,
      description,
      vrmaUrl,
      isBuiltin: false,
      durationMs,
      isIdle: false,
      loop: false,
      enabled: true,
      importedAt,
    }

    const stored: StoredCustomAction = {
      id,
      name,
      description,
      file,
      durationMs,
      isIdle: false,
      loop: false,
      enabled: true,
      importedAt,
    }

    actions.value = [entry, ...actions.value]
    await localforage.setItem<StoredCustomAction>(`${LOCALFORAGE_KEY_PREFIX}${id}`, stored)
      .catch(err => console.error('[animation-actions] failed to save to IndexedDB:', err))

    return entry
  }

  async function removeCustomAction(id: string) {
    const blobUrls = customActionBlobUrls.get(id)
    if (blobUrls) {
      revokeBlobUrls(blobUrls)
      customActionBlobUrls.delete(id)
    }

    actions.value = actions.value.filter(a => a.id !== id)
    await localforage.removeItem(`${LOCALFORAGE_KEY_PREFIX}${id}`)

    // If we were playing this action, reset to idle
    if (currentActionId.value === id)
      stopAction()
  }

  async function updateAction(id: string, patch: {
    name?: string
    description?: string
    enabled?: boolean
    isIdle?: boolean
    loop?: boolean
    /** Pass a File to upload; pass null to clear; omit to keep existing */
    bgMusicFile?: File | null
    bgVideoFile?: File | null
    fgVideoFile?: File | null
  }) {
    const idx = actions.value.findIndex(a => a.id === id)
    if (idx === -1)
      return

    const existing = actions.value[idx]
    const blobTracking = customActionBlobUrls.get(id) ?? { vrmaUrl: existing.vrmaUrl }

    // Build new blob URLs for any newly uploaded files
    let bgMusicUrl = existing.bgMusicUrl
    let bgVideoUrl = existing.bgVideoUrl
    let fgVideoUrl = existing.fgVideoUrl

    if ('bgMusicFile' in patch) {
      if (blobTracking.bgMusicUrl?.startsWith('blob:'))
        URL.revokeObjectURL(blobTracking.bgMusicUrl)
      bgMusicUrl = patch.bgMusicFile ? URL.createObjectURL(patch.bgMusicFile) : undefined
      blobTracking.bgMusicUrl = bgMusicUrl
    }
    if ('bgVideoFile' in patch) {
      if (blobTracking.bgVideoUrl?.startsWith('blob:'))
        URL.revokeObjectURL(blobTracking.bgVideoUrl)
      bgVideoUrl = patch.bgVideoFile ? URL.createObjectURL(patch.bgVideoFile) : undefined
      blobTracking.bgVideoUrl = bgVideoUrl
    }
    if ('fgVideoFile' in patch) {
      if (blobTracking.fgVideoUrl?.startsWith('blob:'))
        URL.revokeObjectURL(blobTracking.fgVideoUrl)
      fgVideoUrl = patch.fgVideoFile ? URL.createObjectURL(patch.fgVideoFile) : undefined
      blobTracking.fgVideoUrl = fgVideoUrl
    }

    customActionBlobUrls.set(id, blobTracking)
    actions.value[idx] = {
      ...existing,
      name: patch.name ?? existing.name,
      description: patch.description ?? existing.description,
      enabled: patch.enabled ?? existing.enabled,
      isIdle: patch.isIdle ?? existing.isIdle,
      loop: patch.loop ?? existing.loop,
      bgMusicUrl,
      bgVideoUrl,
      fgVideoUrl,
    }

    // Persist custom action updates to IndexedDB
    if (!existing.isBuiltin) {
      const stored = await localforage.getItem<StoredCustomAction>(`${LOCALFORAGE_KEY_PREFIX}${id}`)
      if (stored) {
        await localforage.setItem<StoredCustomAction>(`${LOCALFORAGE_KEY_PREFIX}${id}`, {
          ...stored,
          name: patch.name ?? stored.name,
          description: patch.description ?? stored.description,
          enabled: patch.enabled ?? stored.enabled,
          isIdle: patch.isIdle ?? stored.isIdle,
          loop: patch.loop ?? stored.loop,
          bgMusicFile: 'bgMusicFile' in patch ? (patch.bgMusicFile ?? undefined) : stored.bgMusicFile,
          bgVideoFile: 'bgVideoFile' in patch ? (patch.bgVideoFile ?? undefined) : stored.bgVideoFile,
          fgVideoFile: 'fgVideoFile' in patch ? (patch.fgVideoFile ?? undefined) : stored.fgVideoFile,
          // Clear the plain URL fields since we're storing files now
          bgMusicUrl: 'bgMusicFile' in patch ? undefined : stored.bgMusicUrl,
          bgVideoUrl: 'bgVideoFile' in patch ? undefined : stored.bgVideoUrl,
          fgVideoUrl: 'fgVideoFile' in patch ? undefined : stored.fgVideoUrl,
        })
      }
    }
  }

  function playAction(id: string) {
    const action = actions.value.find(a => a.id === id)
    if (!action || !action.enabled) {
      console.warn(`[animation-actions] action "${id}" not found or disabled`)
      return
    }
    currentActionId.value = id
  }

  /** Stop the current action and return to a randomly selected idle action. */
  function stopAction() {
    currentActionId.value = pickRandomIdle()
  }

  return {
    actions,
    currentActionId,
    currentAction,
    currentActionUrl,
    currentBgMusicUrl,
    currentBgVideoUrl,
    currentFgVideoUrl,
    loading,

    loadCustomActionsFromIndexedDB,
    addCustomAction,
    removeCustomAction,
    updateAction,
    playAction,
    stopAction,
    pickRandomIdle,
  }
})
