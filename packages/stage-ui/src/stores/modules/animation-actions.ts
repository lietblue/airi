import localforage from 'localforage'

import { detectVrmaDurationMs } from '@proj-airi/stage-ui-three'
import { animations } from '@proj-airi/stage-ui-three/assets/vrm'
import { useLocalStorage } from '@vueuse/core'
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
  /** Whether the animation loops continuously (LoopRepeat) or plays once (LoopOnce). */
  loop: boolean
  /**
   * User-defined tag names for pool binding. Actions can belong to multiple pools;
   * pool roles (idle, speaking, etc.) are configured via tag group names in settings.
   * e.g. tags: ['idle'] means this action participates in the idle pool.
   */
  tags: string[]
}

// NOTICE: localforage is ONLY used for File/Blob storage (animation .vrma files, background media).
// All metadata (tags, enabled, loop, name, etc.) is stored in localStorage via useLocalStorage
// because localforage.setItem can hang in certain environments, causing silent data loss.

// NOTICE: localforage key prefix for custom animation action FILE blobs
const LOCALFORAGE_KEY_PREFIX = 'animation-action-'
const ACTION_FILE_PREFIX = 'airi-action-file-'
const BUILTIN_MEDIA_PREFIX = 'airi-builtin-media-'

// Legacy localforage keys — used for one-time migration to localStorage, then deleted.
const BUILTIN_OVERRIDES_KEY = 'airi-builtin-action-overrides'
const BUILTIN_OVERRIDES_KEY_LEGACY = 'animation-action-builtin-overrides'
const SPEAKING_SETTINGS_KEY = 'airi-speaking-settings'

type MediaType = 'bgMusic' | 'bgVideo' | 'fgVideo'

function actionFileKey(actionId: string, type: 'vrma' | MediaType): string {
  return `${ACTION_FILE_PREFIX}${actionId}-${type}`
}

function builtinMediaKey(actionId: string, type: MediaType): string {
  return `${BUILTIN_MEDIA_PREFIX}${actionId}-${type}`
}

type BuiltinOverrides = Record<string, {
  enabled?: boolean
  loop?: boolean
  tags?: string[]
}>

/**
 * Who triggered the current action. Used to determine whether the speaking pipeline
 * should stop the action when speech ends, or leave it running to completion.
 * - `'idle-rotation'`  — automatic idle cycling
 * - `'speaking-cycle'` — speaking pipeline (thinking / speaking animations)
 * - `'tool'`           — triggered by an AI tool call or external system
 * - `'welcome'`        — presence welcome animation (not interrupted by speaking/thinking)
 * - `'user'`           — direct user interaction
 */
export type ActionSource = 'idle-rotation' | 'speaking-cycle' | 'tool' | 'welcome' | 'user'

interface StoredCustomActionMeta {
  id: string
  name: string
  description: string
  durationMs?: number
  bgMusicUrl?: string
  bgVideoUrl?: string
  fgVideoUrl?: string
  enabled: boolean
  importedAt: number
  loop: boolean
  tags: string[]
}

/**
 * Legacy format stored in localforage (IndexedDB). Used for one-time migration only.
 * New data goes to localStorage via useLocalStorage.
 */
interface LegacyStoredCustomAction {
  id: string
  name: string
  description: string
  file?: File
  durationMs?: number
  bgMusicFile?: File
  bgVideoFile?: File
  fgVideoFile?: File
  bgMusicUrl?: string
  bgVideoUrl?: string
  fgVideoUrl?: string
  enabled: boolean
  importedAt: number
  loop?: boolean
  tags?: string[]
  isIdle?: boolean
  isSpeakingAction?: boolean
}

// Built-in action definitions — each entry only specifies what differs from defaults.
const BUILTIN_DEFAULTS = {
  isBuiltin: true as const,
  durationMs: undefined as number | undefined,
  enabled: true,
  importedAt: 0,
  loop: false,
  tags: [] as string[],
}

const builtinActionSources: Array<{
  id: string
  name: string
  description: string
  url: URL
  loop?: boolean
  tags?: string[]
}> = [
  { id: 'idle_loop', name: 'Idle', description: 'Idle standing animation, loops continuously', url: animations.idleLoop, loop: true, tags: ['idle'] },
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
  loop: src.loop ?? false,
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
  /**
   * When true, only 'user' and 'tool' sources can override the current action.
   * Set when a welcome action starts; cleared when the animation completes or stopAction is called.
   */
  const actionLocked = ref(false)
  /**
   * When set, overrides the action's own `loop` property for the current playback.
   * `null` means use the action's default. Set by `playAction` when a duration param is provided.
   */
  const currentActionLoopOverride = ref<boolean | null>(null)
  /** Handle for the auto-stop timer when playing with a positive duration. */
  let durationTimerHandle: ReturnType<typeof setTimeout> | null = null
  const loading = ref(false)

  /** When true, the thinking phase picks from speaking actions instead of hardcoding 'thinking'. */
  const thinkingUseSpeakingActions = useLocalStorage('settings/actions/thinking-use-speaking', false)

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
   * Builtin action overrides (tags, enabled, loop) stored in localStorage.
   * Persists instantly — no async localforage calls.
   */
  const builtinOverridesStorage = useLocalStorage<BuiltinOverrides>(
    'settings/actions/builtin-overrides',
    {},
  )

  /**
   * Custom action metadata stored in localStorage (keyed by action ID).
   * File blobs are stored separately in localforage/IndexedDB.
   */
  const customActionMetaStorage = useLocalStorage<Record<string, StoredCustomActionMeta>>(
    'settings/actions/custom-action-meta',
    {},
  )

  /** All unique tag names across all actions. */
  const allTags = computed(() => [...new Set(actions.value.flatMap(a => a.tags))])

  const currentAction = computed(() =>
    actions.value.find(a => a.id === currentActionId.value),
  )

  /** Whether the currently playing action should loop. Respects override from playAction duration param. */
  const isCurrentActionLoop = computed(() =>
    currentActionLoopOverride.value !== null
      ? currentActionLoopOverride.value
      : (currentAction.value?.loop ?? true),
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

  function saveSpeakingSettings() {
    // No-op: thinkingUseSpeakingActions uses useLocalStorage which auto-persists
  }

  async function loadCustomActionsFromIndexedDB() {
    loading.value = true

    try {
      // --- One-time migration from localforage to localStorage ---
      await migrateFromLocalforage()

      // --- Load custom actions: metadata from localStorage, files from localforage ---
      const customEntries: ActionEntry[] = []
      for (const [id, meta] of Object.entries(customActionMetaStorage.value)) {
        // Load .vrma file from localforage (the only thing stored there now)
        let vrmaFile: Blob | null = await localforage.getItem<Blob>(actionFileKey(id, 'vrma'))
        // Fallback: try legacy double-prefixed key
        if (!vrmaFile) {
          vrmaFile = await localforage.getItem(`${LOCALFORAGE_KEY_PREFIX}${id}`)
            .then((val) => {
              const legacy = val as LegacyStoredCustomAction | null
              return legacy?.file instanceof Blob ? legacy.file : null
            })
            .catch(() => null)
        }

        if (!vrmaFile)
          continue

        // Load media files from localforage
        const [bgMusicBlob, bgVideoBlob, fgVideoBlob] = await Promise.all([
          localforage.getItem<Blob>(actionFileKey(id, 'bgMusic')),
          localforage.getItem<Blob>(actionFileKey(id, 'bgVideo')),
          localforage.getItem<Blob>(actionFileKey(id, 'fgVideo')),
        ])

        const vrmaUrl = URL.createObjectURL(vrmaFile)
        const bgMusicUrl = bgMusicBlob ? URL.createObjectURL(bgMusicBlob) : meta.bgMusicUrl
        const bgVideoUrl = bgVideoBlob ? URL.createObjectURL(bgVideoBlob) : meta.bgVideoUrl
        const fgVideoUrl = fgVideoBlob ? URL.createObjectURL(fgVideoBlob) : meta.fgVideoUrl

        customActionBlobUrls.set(id, { vrmaUrl, bgMusicUrl, bgVideoUrl, fgVideoUrl })

        customEntries.push({
          id,
          name: meta.name,
          description: meta.description,
          vrmaUrl,
          isBuiltin: false,
          durationMs: meta.durationMs,
          bgMusicUrl,
          bgVideoUrl,
          fgVideoUrl,
          enabled: meta.enabled,
          importedAt: meta.importedAt,
          loop: meta.loop,
          tags: meta.tags,
        })
      }

      // Merge: built-ins first (with overrides from localStorage), then custom sorted by import time
      const builtinOverrides = builtinOverridesStorage.value
      const builtinEntries = await Promise.all(builtinActions.map(async (a) => {
        const override = builtinOverrides[a.id]
        if (!override)
          return a
        const base = {
          ...a,
          ...(override.enabled !== undefined ? { enabled: override.enabled } : {}),
          loop: override.loop ?? a.loop,
          tags: override.tags !== undefined ? override.tags : a.tags,
        }
        // Load media files from localforage
        const [bgMusicFile, bgVideoFile, fgVideoFile] = await Promise.all([
          localforage.getItem<Blob>(builtinMediaKey(a.id, 'bgMusic')),
          localforage.getItem<Blob>(builtinMediaKey(a.id, 'bgVideo')),
          localforage.getItem<Blob>(builtinMediaKey(a.id, 'fgVideo')),
        ])
        return {
          ...base,
          ...(bgMusicFile ? { bgMusicUrl: URL.createObjectURL(bgMusicFile) } : {}),
          ...(bgVideoFile ? { bgVideoUrl: URL.createObjectURL(bgVideoFile) } : {}),
          ...(fgVideoFile ? { fgVideoUrl: URL.createObjectURL(fgVideoFile) } : {}),
        }
      }))

      actions.value = [
        ...builtinEntries,
        ...customEntries.sort((a, b) => b.importedAt - a.importedAt),
      ]
    }
    catch (err) {
      console.error('[animation-actions] failed to load:', err)
    }
    finally {
      loading.value = false
    }
  }

  /**
   * One-time migration: move metadata from localforage (IndexedDB) to localStorage.
   * After migration, localforage only stores File blobs.
   */
  async function migrateFromLocalforage() {
    // Skip if already migrated (localStorage has data)
    if (Object.keys(customActionMetaStorage.value).length > 0 || Object.keys(builtinOverridesStorage.value).length > 0)
      return

    try {
      // Migrate legacy builtin overrides
      const legacyOverrides = await localforage.getItem<Record<string, unknown>>(BUILTIN_OVERRIDES_KEY_LEGACY)
      const rawOverrides = await localforage.getItem<Record<string, Record<string, unknown>>>(BUILTIN_OVERRIDES_KEY) ?? {}

      // Merge legacy into raw if it exists
      if (legacyOverrides) {
        for (const [id, override] of Object.entries(legacyOverrides)) {
          const o = override as Record<string, unknown>
          rawOverrides[id] = { ...rawOverrides[id], ...o }
        }
        await localforage.removeItem(BUILTIN_OVERRIDES_KEY_LEGACY)
      }

      // Process builtin overrides: convert legacy fields, extract to localStorage
      const migratedOverrides: BuiltinOverrides = {}
      for (const [id, o] of Object.entries(rawOverrides)) {
        const rawTags = (o.tags as string[] | undefined) ?? []
        const tags = rawTags.filter(t => t !== 'loop')
        if (o.isIdle && !tags.includes(idlePoolTag.value))
          tags.push(idlePoolTag.value)
        if (o.isSpeakingAction && !tags.includes(speakingPoolTag.value))
          tags.push(speakingPoolTag.value)
        const loop = !!(o.loop || rawTags.includes('loop'))
        migratedOverrides[id] = {
          ...(o.enabled !== undefined ? { enabled: o.enabled as boolean } : {}),
          loop,
          tags,
        }
        // Migrate embedded media files to separate localforage keys
        if (o.bgMusicFile instanceof Blob)
          await localforage.setItem(builtinMediaKey(id, 'bgMusic'), o.bgMusicFile).catch(() => {})
        if (o.bgVideoFile instanceof Blob)
          await localforage.setItem(builtinMediaKey(id, 'bgVideo'), o.bgVideoFile).catch(() => {})
        if (o.fgVideoFile instanceof Blob)
          await localforage.setItem(builtinMediaKey(id, 'fgVideo'), o.fgVideoFile).catch(() => {})
      }
      if (Object.keys(migratedOverrides).length > 0)
        builtinOverridesStorage.value = migratedOverrides

      // Migrate speaking settings
      const speakingSettings = await localforage.getItem<{ thinkingUseSpeakingActions: boolean }>(SPEAKING_SETTINGS_KEY)
      if (speakingSettings)
        thinkingUseSpeakingActions.value = speakingSettings.thinkingUseSpeakingActions

      // Migrate custom action metadata from localforage to localStorage
      const migratedMeta: Record<string, StoredCustomActionMeta> = {}
      await localforage.iterate<LegacyStoredCustomAction, void>((val, key) => {
        if (!key.startsWith(LOCALFORAGE_KEY_PREFIX))
          return
        if (typeof val?.id !== 'string' || typeof val?.name !== 'string')
          return
        // Convert legacy fields
        const rawTags = [...(val.tags ?? [])]
        const tags = rawTags.filter(t => t !== 'loop')
        if (val.isIdle && !tags.includes(idlePoolTag.value))
          tags.push(idlePoolTag.value)
        if (val.isSpeakingAction && !tags.includes(speakingPoolTag.value))
          tags.push(speakingPoolTag.value)
        const loop = !!(val.loop || rawTags.includes('loop'))

        migratedMeta[val.id] = {
          id: val.id,
          name: val.name,
          description: val.description,
          durationMs: val.durationMs,
          bgMusicUrl: val.bgMusicUrl,
          bgVideoUrl: val.bgVideoUrl,
          fgVideoUrl: val.fgVideoUrl,
          enabled: val.enabled,
          importedAt: val.importedAt,
          loop,
          tags,
        }
      })

      // Extract embedded files to separate localforage keys
      for (const [id] of Object.entries(migratedMeta)) {
        const legacyKey = `${LOCALFORAGE_KEY_PREFIX}${id}`
        const legacy = await localforage.getItem<LegacyStoredCustomAction>(legacyKey)
        if (!legacy)
          continue
        if (legacy.file instanceof Blob)
          await localforage.setItem(actionFileKey(id, 'vrma'), legacy.file).catch(() => {})
        if (legacy.bgMusicFile instanceof Blob)
          await localforage.setItem(actionFileKey(id, 'bgMusic'), legacy.bgMusicFile).catch(() => {})
        if (legacy.bgVideoFile instanceof Blob)
          await localforage.setItem(actionFileKey(id, 'bgVideo'), legacy.bgVideoFile).catch(() => {})
        if (legacy.fgVideoFile instanceof Blob)
          await localforage.setItem(actionFileKey(id, 'fgVideo'), legacy.fgVideoFile).catch(() => {})
      }

      if (Object.keys(migratedMeta).length > 0)
        customActionMetaStorage.value = migratedMeta

      // Clean up old localStorage key
      localStorage.removeItem('settings/actions/loop-tag')
    }
    catch (err) {
      console.error('[animation-actions] migration from localforage failed:', err)
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
      loop: false,
      tags: [],
    }

    // Save metadata to localStorage (instant, synchronous via useLocalStorage)
    customActionMetaStorage.value = {
      ...customActionMetaStorage.value,
      [id]: {
        id,
        name,
        description,
        durationMs,
        enabled: true,
        importedAt,
        loop: false,
        tags: [],
      },
    }

    // Save .vrma file to localforage (async, for File blob storage only)
    await localforage.setItem(actionFileKey(id, 'vrma'), file)
      .catch(err => console.error('[animation-actions] failed to save .vrma file to IndexedDB:', err))

    // Insert after builtins to keep consistent order with loadCustomActionsFromIndexedDB
    const firstCustomIdx = actions.value.findIndex(a => !a.isBuiltin)
    if (firstCustomIdx === -1) {
      actions.value = [...actions.value, entry]
    }
    else {
      const copy = [...actions.value]
      copy.splice(firstCustomIdx, 0, entry)
      actions.value = copy
    }

    return entry
  }

  async function removeCustomAction(id: string) {
    const blobUrls = customActionBlobUrls.get(id)
    if (blobUrls) {
      revokeBlobUrls(blobUrls)
      customActionBlobUrls.delete(id)
    }

    actions.value = actions.value.filter(a => a.id !== id)

    // Remove metadata from localStorage
    const { [id]: _, ...rest } = customActionMetaStorage.value
    customActionMetaStorage.value = rest

    // Remove file entries from localforage
    await Promise.all([
      localforage.removeItem(actionFileKey(id, 'vrma')),
      localforage.removeItem(actionFileKey(id, 'bgMusic')),
      localforage.removeItem(actionFileKey(id, 'bgVideo')),
      localforage.removeItem(actionFileKey(id, 'fgVideo')),
      // Also clean up legacy key if it exists
      localforage.removeItem(`${LOCALFORAGE_KEY_PREFIX}${id}`),
    ])

    // If we were playing this action, reset to idle
    if (currentActionId.value === id)
      stopAction()
  }

  async function updateAction(id: string, patch: {
    name?: string
    description?: string
    enabled?: boolean
    loop?: boolean
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
      loop: patch.loop ?? existing.loop,
      tags: patch.tags ?? existing.tags,
      bgMusicUrl,
      bgVideoUrl,
      fgVideoUrl,
    }

    // Persist metadata to localStorage (synchronous, never hangs)
    if (existing.isBuiltin) {
      const overrides = { ...builtinOverridesStorage.value }
      overrides[id] = {
        ...overrides[id],
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.loop !== undefined ? { loop: patch.loop } : {}),
        ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      }
      builtinOverridesStorage.value = overrides

      // Save media files to localforage (async, File blobs only)
      const fileSaves: Promise<unknown>[] = []
      if ('bgMusicFile' in patch) {
        fileSaves.push(patch.bgMusicFile
          ? localforage.setItem(builtinMediaKey(id, 'bgMusic'), patch.bgMusicFile)
          : localforage.removeItem(builtinMediaKey(id, 'bgMusic')))
      }
      if ('bgVideoFile' in patch) {
        fileSaves.push(patch.bgVideoFile
          ? localforage.setItem(builtinMediaKey(id, 'bgVideo'), patch.bgVideoFile)
          : localforage.removeItem(builtinMediaKey(id, 'bgVideo')))
      }
      if ('fgVideoFile' in patch) {
        fileSaves.push(patch.fgVideoFile
          ? localforage.setItem(builtinMediaKey(id, 'fgVideo'), patch.fgVideoFile)
          : localforage.removeItem(builtinMediaKey(id, 'fgVideo')))
      }
      if (fileSaves.length > 0)
        await Promise.all(fileSaves)
      return
    }

    // Custom action: update metadata in localStorage
    const meta = customActionMetaStorage.value[id]
    if (meta) {
      customActionMetaStorage.value = {
        ...customActionMetaStorage.value,
        [id]: {
          ...meta,
          name: patch.name ?? meta.name,
          description: patch.description ?? meta.description,
          enabled: patch.enabled ?? meta.enabled,
          loop: patch.loop ?? meta.loop,
          tags: patch.tags ?? meta.tags,
          bgMusicUrl: 'bgMusicFile' in patch ? undefined : meta.bgMusicUrl,
          bgVideoUrl: 'bgVideoFile' in patch ? undefined : meta.bgVideoUrl,
          fgVideoUrl: 'fgVideoFile' in patch ? undefined : meta.fgVideoUrl,
        },
      }
    }

    // Save media files to localforage (async, File blobs only)
    const fileSaves: Promise<unknown>[] = []
    if ('bgMusicFile' in patch) {
      fileSaves.push(patch.bgMusicFile
        ? localforage.setItem(actionFileKey(id, 'bgMusic'), patch.bgMusicFile)
        : localforage.removeItem(actionFileKey(id, 'bgMusic')))
    }
    if ('bgVideoFile' in patch) {
      fileSaves.push(patch.bgVideoFile
        ? localforage.setItem(actionFileKey(id, 'bgVideo'), patch.bgVideoFile)
        : localforage.removeItem(actionFileKey(id, 'bgVideo')))
    }
    if ('fgVideoFile' in patch) {
      fileSaves.push(patch.fgVideoFile
        ? localforage.setItem(actionFileKey(id, 'fgVideo'), patch.fgVideoFile)
        : localforage.removeItem(actionFileKey(id, 'fgVideo')))
    }
    if (fileSaves.length > 0)
      await Promise.all(fileSaves)
  }

  /**
   * Play an action by id, optionally recording who triggered it.
   * The `source` is used downstream (e.g. Stage.vue) to decide whether the speaking
   * pipeline should stop the action when speech ends.
   *
   * @param duration Controls playback duration:
   *   - `undefined` — use the action's own loop setting (default)
   *   - `0`  — play once to natural end, then return to idle (forces loop=false)
   *   - `-1` — loop indefinitely (forces loop=true)
   *   - `>0` — play for N milliseconds, then return to idle (forces loop=true so animation repeats until timer fires)
   */
  function playAction(id: string, source: ActionSource = 'user', duration?: number) {
    const action = actions.value.find(a => a.id === id)
    if (!action || !action.enabled) {
      console.warn(`[animation-actions] action "${id}" not found or disabled`)
      return
    }

    // NOTICE: When a welcome action is playing (actionLocked), only 'user' and 'tool'
    // sources can interrupt it. Speaking-cycle and idle-rotation are rejected so the
    // welcome animation plays to completion before the speaking pipeline takes over.
    if (actionLocked.value && source !== 'user' && source !== 'tool' && source !== 'welcome') {
      return
    }

    // Clear any previous duration timer
    if (durationTimerHandle !== null) {
      clearTimeout(durationTimerHandle)
      durationTimerHandle = null
    }

    currentActionId.value = id
    currentActionSource.value = source
    actionLocked.value = source === 'welcome'

    // Apply loop override based on duration
    if (duration === undefined) {
      currentActionLoopOverride.value = null
    }
    else if (duration === 0) {
      // Play once to natural end — animationComplete will fire and stopAction is called by Stage
      currentActionLoopOverride.value = false
    }
    else if (duration === -1) {
      // Loop indefinitely
      currentActionLoopOverride.value = true
    }
    else if (duration > 0) {
      // Play for N ms then auto-stop. Loop so the animation repeats until the timer fires.
      currentActionLoopOverride.value = true
      durationTimerHandle = setTimeout(() => {
        durationTimerHandle = null
        stopAction()
      }, duration)
    }
  }

  /**
   * Release the action lock set by welcome actions. Called when the locked animation
   * finishes (via handleAnimationComplete in Stage.vue) so the speaking pipeline can
   * take over afterward.
   */
  function unlockAction() {
    actionLocked.value = false
  }

  /** Stop the current action and return to a randomly selected idle action. */
  function stopAction() {
    // Clear duration timer and loop override from the previous playAction call
    if (durationTimerHandle !== null) {
      clearTimeout(durationTimerHandle)
      durationTimerHandle = null
    }
    currentActionLoopOverride.value = null
    actionLocked.value = false

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
    allTags,
    isCurrentActionLoop,
    isCurrentActionIdle,

    actionLocked,

    loadCustomActionsFromIndexedDB,
    addCustomAction,
    removeCustomAction,
    updateAction,
    playAction,
    unlockAction,
    stopAction,
    pickRandomIdle,
    pickRandomSpeakingAction,
    getActionsForTag,
    pickRandomFromTag,
    saveSpeakingSettings,
  }
})
