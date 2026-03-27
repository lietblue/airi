import localforage from 'localforage'

import { detectVrmaDurationMs } from '@proj-airi/stage-ui-three'
import { animations } from '@proj-airi/stage-ui-three/assets/vrm'
import { until, useLocalStorage } from '@vueuse/core'
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
  /** Optional background audio URL (blob or external) */
  bgMusicUrl?: string
  /** Optional background video URL (shown behind Three.js canvas) */
  bgVideoUrl?: string
  /** Optional foreground video URL (shown in front of Three.js canvas, pointer-events-none) */
  fgVideoUrl?: string
  enabled: boolean
  importedAt: number
  /**
   * User-defined tag names for pool binding. Actions can belong to multiple pools;
   * pool roles (idle, speaking, loop, etc.) are configured via tag group names in settings.
   * e.g. tags: ['idle', 'loop'] means this action participates in the idle and loop pools.
   */
  tags: string[]
}

// NOTICE: localforage key prefix for custom animation actions
const LOCALFORAGE_KEY_PREFIX = 'animation-action-'

// NOTICE: Builtin action field overrides (enabled, tags, etc.) are stored separately because
// builtins have no StoredCustomAction record in IndexedDB.
// NOTICE: This key must NOT start with LOCALFORAGE_KEY_PREFIX ('animation-action-') or
// localforage.iterate will pick it up and try to parse it as a StoredCustomAction, causing
// URL.createObjectURL(undefined) to throw and silently breaking the entire load.
const BUILTIN_OVERRIDES_KEY = 'airi-builtin-action-overrides'
// NOTICE: Legacy key that was accidentally prefixed with LOCALFORAGE_KEY_PREFIX.
// Kept for one-time migration only; data is moved to BUILTIN_OVERRIDES_KEY then deleted.
const BUILTIN_OVERRIDES_KEY_LEGACY = 'animation-action-builtin-overrides'
// Global speaking behavior settings (not per-action).
const SPEAKING_SETTINGS_KEY = 'airi-speaking-settings'

interface SpeakingSettings {
  /**
   * When true, the thinking phase (before first token) also picks from the
   * speaking actions pool instead of always playing the built-in 'thinking' action.
   */
  thinkingUseSpeakingActions: boolean
}

type BuiltinOverrides = Record<string, {
  enabled?: boolean
  tags?: string[]
}>

/**
 * Who triggered the current action. Used to determine whether the speaking pipeline
 * should stop the action when speech ends, or leave it running to completion.
 * - `'idle-rotation'`  — automatic idle cycling
 * - `'speaking-cycle'` — speaking pipeline (thinking / speaking animations)
 * - `'tool'`           — triggered by an AI tool call or external system
 * - `'user'`           — direct user interaction
 */
export type ActionSource = 'idle-rotation' | 'speaking-cycle' | 'tool' | 'user'

interface StoredCustomAction {
  id: string
  name: string
  description: string
  file: File
  durationMs?: number
  bgMusicFile?: File
  bgVideoFile?: File
  fgVideoFile?: File
  bgMusicUrl?: string
  bgVideoUrl?: string
  fgVideoUrl?: string
  enabled: boolean
  importedAt: number
  tags?: string[]
  // Legacy fields — migrated to tags on load, then removed from storage
  isIdle?: boolean
  loop?: boolean
  isSpeakingAction?: boolean
}

// Built-in action definitions — each entry only specifies what differs from defaults.
const BUILTIN_DEFAULTS = {
  isBuiltin: true as const,
  durationMs: undefined as number | undefined,
  enabled: true,
  importedAt: 0,
  tags: [] as string[],
}

const builtinActionSources: Array<{
  id: string
  name: string
  description: string
  url: URL
  tags?: string[]
}> = [
  { id: 'idle_loop', name: 'Idle', description: 'Idle standing animation, loops continuously', url: animations.idleLoop, tags: ['idle', 'loop'] },
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
  tags: src.tags ?? [],
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
  /** Tracks who triggered the currently playing action. */
  const currentActionSource = ref<ActionSource>('idle-rotation')
  const loading = ref(false)

  /** When true, the thinking phase picks from speaking actions instead of hardcoding 'thinking'. */
  const thinkingUseSpeakingActions = ref(false)

  /**
   * Tag name whose matching actions form the idle rotation pool.
   * Actions tagged with this name are eligible for random idle cycling.
   */
  const idlePoolTag = useLocalStorage('settings/actions/idle-tag', 'idle')
  /**
   * Tag name whose matching actions form the speaking pool.
   * Actions tagged with this name are cycled while AIRI is outputting text.
   */
  const speakingPoolTag = useLocalStorage('settings/actions/speaking-tag', 'speaking')
  /**
   * Tag name whose matching actions loop continuously.
   * Actions tagged with this name use Three.js LoopRepeat; others use LoopOnce.
   */
  const loopTag = useLocalStorage('settings/actions/loop-tag', 'loop')

  /** All unique tag names across all actions. */
  const allTags = computed(() => [...new Set(actions.value.flatMap(a => a.tags))])

  const currentAction = computed(() =>
    actions.value.find(a => a.id === currentActionId.value),
  )

  /** Whether the currently playing action should loop. Defaults true when no action is active. */
  const isCurrentActionLoop = computed(() =>
    currentAction.value?.tags.includes(loopTag.value) ?? true,
  )

  /** Whether the currently playing action is in the idle pool. */
  const isCurrentActionIdle = computed(() =>
    currentAction.value?.tags.includes(idlePoolTag.value) ?? false,
  )

  const currentActionUrl = computed(
    () => currentAction.value?.vrmaUrl ?? animations.idleLoop.toString(),
  )

  const currentBgMusicUrl = computed(() => currentAction.value?.bgMusicUrl)
  const currentBgVideoUrl = computed(() => currentAction.value?.bgVideoUrl)
  const currentFgVideoUrl = computed(() => currentAction.value?.fgVideoUrl)

  /** Get all enabled actions that include the given tag. */
  function getActionsForTag(tag: string): ActionEntry[] {
    return actions.value.filter(a => a.enabled && a.tags.includes(tag))
  }

  /**
   * Pick a random enabled action from the named tag pool, avoiding the currently playing action
   * when possible. Returns null if the tag pool is empty.
   */
  function pickRandomFromTag(tag: string): string | null {
    const pool = getActionsForTag(tag)
    if (!pool.length)
      return null
    const candidates = pool.length > 1
      ? pool.filter(a => a.id !== currentActionId.value)
      : pool
    return candidates[Math.floor(Math.random() * candidates.length)].id
  }

  /**
   * Pick a random enabled idle action from the idle pool tag.
   * Falls back to 'idle_loop' if the pool is empty.
   */
  function pickRandomIdle(): string {
    const id = pickRandomFromTag(idlePoolTag.value)
    return id ?? 'idle_loop'
  }

  /**
   * Pick a random action for speaking playback, avoiding the currently playing action when possible.
   * Falls back to all enabled non-idle-pool actions if the speaking pool is empty.
   * Returns null if nothing is available.
   */
  function pickRandomSpeakingAction(): string | null {
    const id = pickRandomFromTag(speakingPoolTag.value)
    if (id)
      return id
    // Fallback: any enabled action not in the idle pool
    const pool = actions.value.filter(a => a.enabled && !a.tags.includes(idlePoolTag.value))
    if (pool.length === 0)
      return null
    const candidates = pool.length > 1
      ? pool.filter(a => a.id !== currentActionId.value)
      : pool
    return candidates[Math.floor(Math.random() * candidates.length)].id
  }

  async function saveSpeakingSettings() {
    await localforage.setItem<SpeakingSettings>(SPEAKING_SETTINGS_KEY, {
      thinkingUseSpeakingActions: thinkingUseSpeakingActions.value,
    }).catch(err => console.error('[animation-actions] failed to save speaking settings:', err))
  }

  async function loadCustomActionsFromIndexedDB() {
    await until(loading).toBe(false)
    loading.value = true

    try {
      // Migrate legacy builtin overrides key if it exists
      const legacyOverrides = await localforage.getItem<Record<string, unknown>>(BUILTIN_OVERRIDES_KEY_LEGACY)
      if (legacyOverrides) {
        const existing = await localforage.getItem<BuiltinOverrides>(BUILTIN_OVERRIDES_KEY) ?? {}
        // Merge legacy into existing, converting old boolean fields to tags
        const merged: BuiltinOverrides = { ...existing }
        for (const [id, override] of Object.entries(legacyOverrides)) {
          const o = override as Record<string, unknown>
          const tags = [...((merged[id]?.tags ?? (o.tags as string[] | undefined)) ?? [])]
          if (o.isIdle && !tags.includes(idlePoolTag.value))
            tags.push(idlePoolTag.value)
          if (o.isSpeakingAction && !tags.includes(speakingPoolTag.value))
            tags.push(speakingPoolTag.value)
          if (o.loop && !tags.includes(loopTag.value))
            tags.push(loopTag.value)
          merged[id] = {
            ...merged[id],
            ...(o.enabled !== undefined ? { enabled: o.enabled as boolean } : {}),
            tags,
          }
        }
        await localforage.setItem<BuiltinOverrides>(BUILTIN_OVERRIDES_KEY, merged)
        await localforage.removeItem(BUILTIN_OVERRIDES_KEY_LEGACY)
      }

      const speakingSettings = await localforage.getItem<SpeakingSettings>(SPEAKING_SETTINGS_KEY)
      if (speakingSettings)
        thinkingUseSpeakingActions.value = speakingSettings.thinkingUseSpeakingActions

      // Migrate builtin overrides: convert old boolean fields to tags
      const rawBuiltinOverrides = await localforage.getItem<Record<string, Record<string, unknown>>>(BUILTIN_OVERRIDES_KEY) ?? {}
      let builtinOverridesDirty = false
      const builtinOverrides: BuiltinOverrides = {}
      for (const [id, o] of Object.entries(rawBuiltinOverrides)) {
        const tags = [...((o.tags as string[] | undefined) ?? [])]
        let migrated = false
        if (o.isIdle && !tags.includes(idlePoolTag.value)) {
          tags.push(idlePoolTag.value)
          migrated = true
        }
        if (o.isSpeakingAction && !tags.includes(speakingPoolTag.value)) {
          tags.push(speakingPoolTag.value)
          migrated = true
        }
        if (o.loop && !tags.includes(loopTag.value)) {
          tags.push(loopTag.value)
          migrated = true
        }
        builtinOverrides[id] = {
          ...(o.enabled !== undefined ? { enabled: o.enabled as boolean } : {}),
          tags,
        }
        if (migrated)
          builtinOverridesDirty = true
      }
      if (builtinOverridesDirty)
        await localforage.setItem<BuiltinOverrides>(BUILTIN_OVERRIDES_KEY, builtinOverrides)

      const customEntries: ActionEntry[] = []

      await localforage.iterate<StoredCustomAction, void>(async (val, key) => {
        if (!key.startsWith(LOCALFORAGE_KEY_PREFIX))
          return
        // Guard: skip any entry that isn't a valid StoredCustomAction (e.g. leftover legacy keys)
        if (!(val.file instanceof File))
          return

        // Migrate legacy boolean fields to tags
        const tags = [...(val.tags ?? [])]
        let needsMigration = false
        if (val.isIdle && !tags.includes(idlePoolTag.value)) {
          tags.push(idlePoolTag.value)
          needsMigration = true
        }
        if (val.isSpeakingAction && !tags.includes(speakingPoolTag.value)) {
          tags.push(speakingPoolTag.value)
          needsMigration = true
        }
        if (val.loop && !tags.includes(loopTag.value)) {
          tags.push(loopTag.value)
          needsMigration = true
        }
        if (needsMigration) {
          const { isIdle: _isIdle, isSpeakingAction: _isSpeakingAction, loop: _loop, ...rest } = val
          await localforage.setItem(key, { ...rest, tags })
            .catch(err => console.error('[animation-actions] failed to migrate legacy fields for', val.id, err))
        }

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
          bgMusicUrl,
          bgVideoUrl,
          fgVideoUrl,
          enabled: val.enabled,
          importedAt: val.importedAt,
          tags,
        })
      })

      // Merge: built-ins first (with any persisted overrides applied), then custom sorted by import time (newest first)
      actions.value = [
        ...builtinActions.map((a) => {
          const override = builtinOverrides[a.id]
          if (!override)
            return a
          return {
            ...a,
            ...(override.enabled !== undefined ? { enabled: override.enabled } : {}),
            // Merge override tags onto the builtin's default tags (union)
            tags: [...new Set([...a.tags, ...(override.tags ?? [])])],
          }
        }),
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
      enabled: true,
      importedAt,
      tags: [],
    }

    const stored: StoredCustomAction = {
      id,
      name,
      description,
      file,
      durationMs,
      enabled: true,
      importedAt,
      tags: [],
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
    tags?: string[]
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
      tags: patch.tags ?? existing.tags,
      bgMusicUrl,
      bgVideoUrl,
      fgVideoUrl,
    }

    // Persist: custom actions go to their own record; builtin overrides go to a shared map
    if (existing.isBuiltin) {
      const overrides = await localforage.getItem<BuiltinOverrides>(BUILTIN_OVERRIDES_KEY) ?? {}
      overrides[id] = {
        ...overrides[id],
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        // For builtins, store only the delta from the builtin's default tags
        ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      }
      await localforage.setItem<BuiltinOverrides>(BUILTIN_OVERRIDES_KEY, overrides)
        .catch(err => console.error('[animation-actions] failed to save builtin overrides:', err))
      return
    }

    const stored = await localforage.getItem<StoredCustomAction>(`${LOCALFORAGE_KEY_PREFIX}${id}`)
    // NOTICE: If the stored record is missing (e.g. IndexedDB was cleared externally),
    // we can't reconstruct the File object from memory — blob URLs are transient and the
    // original File is gone after reload. Skip the write rather than saving a broken record.
    if (stored) {
      await localforage.setItem<StoredCustomAction>(`${LOCALFORAGE_KEY_PREFIX}${id}`, {
        ...stored,
        name: patch.name ?? stored.name,
        description: patch.description ?? stored.description,
        enabled: patch.enabled ?? stored.enabled,
        tags: patch.tags ?? stored.tags,
        bgMusicFile: 'bgMusicFile' in patch ? (patch.bgMusicFile ?? undefined) : stored.bgMusicFile,
        bgVideoFile: 'bgVideoFile' in patch ? (patch.bgVideoFile ?? undefined) : stored.bgVideoFile,
        fgVideoFile: 'fgVideoFile' in patch ? (patch.fgVideoFile ?? undefined) : stored.fgVideoFile,
        // Clear the plain URL fields since we're storing files now
        bgMusicUrl: 'bgMusicFile' in patch ? undefined : stored.bgMusicUrl,
        bgVideoUrl: 'bgVideoFile' in patch ? undefined : stored.bgVideoUrl,
        fgVideoUrl: 'fgVideoFile' in patch ? undefined : stored.fgVideoUrl,
      }).catch(err => console.error('[animation-actions] failed to update custom action in IndexedDB:', err))
    }
  }

  /**
   * Play an action by id, optionally recording who triggered it.
   * The `source` is used downstream (e.g. Stage.vue) to decide whether the speaking
   * pipeline should stop the action when speech ends.
   */
  function playAction(id: string, source: ActionSource = 'user') {
    const action = actions.value.find(a => a.id === id)
    if (!action || !action.enabled) {
      console.warn(`[animation-actions] action "${id}" not found or disabled`)
      return
    }
    currentActionId.value = id
    currentActionSource.value = source
  }

  /** Stop the current action and return to a randomly selected idle action. */
  function stopAction() {
    currentActionId.value = pickRandomIdle()
    currentActionSource.value = 'idle-rotation'
  }

  // Auto-initialize: load persisted actions when the store is first created so
  // any component (settings page, devtools, etc.) sees the full action list without
  // needing an explicit call. The loading mutex prevents duplicate concurrent loads.
  loadCustomActionsFromIndexedDB()

  return {
    actions,
    currentActionId,
    currentActionSource,
    currentAction,
    currentActionUrl,
    currentBgMusicUrl,
    currentBgVideoUrl,
    currentFgVideoUrl,
    loading,
    thinkingUseSpeakingActions,
    idlePoolTag,
    speakingPoolTag,
    loopTag,
    allTags,
    isCurrentActionLoop,
    isCurrentActionIdle,

    loadCustomActionsFromIndexedDB,
    addCustomAction,
    removeCustomAction,
    updateAction,
    playAction,
    stopAction,
    pickRandomIdle,
    pickRandomSpeakingAction,
    getActionsForTag,
    pickRandomFromTag,
    saveSpeakingSettings,
  }
})
