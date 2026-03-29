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
  /** Whether the animation loops continuously (LoopRepeat) or plays once (LoopOnce). */
  loop: boolean
  /**
   * User-defined tag names for pool binding. Actions can belong to multiple pools;
   * pool roles (idle, speaking, etc.) are configured via tag group names in settings.
   * e.g. tags: ['idle'] means this action participates in the idle pool.
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
  loop?: boolean
  tags?: string[]
  bgMusicFile?: File
  bgVideoFile?: File
  fgVideoFile?: File
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
  /** Whether the animation loops continuously. */
  loop?: boolean
  tags?: string[]
  // Legacy fields — migrated on load, then removed from storage
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
        // Merge legacy into existing, converting old boolean fields
        const merged: BuiltinOverrides = { ...existing }
        for (const [id, override] of Object.entries(legacyOverrides)) {
          const o = override as Record<string, unknown>
          const tags = [...((merged[id]?.tags ?? (o.tags as string[] | undefined)) ?? [])].filter(t => t !== 'loop')
          if (o.isIdle && !tags.includes(idlePoolTag.value))
            tags.push(idlePoolTag.value)
          if (o.isSpeakingAction && !tags.includes(speakingPoolTag.value))
            tags.push(speakingPoolTag.value)
          const loop = !!(o.loop || merged[id]?.loop)
          merged[id] = {
            ...merged[id],
            ...(o.enabled !== undefined ? { enabled: o.enabled as boolean } : {}),
            loop,
            tags,
          }
        }
        await localforage.setItem<BuiltinOverrides>(BUILTIN_OVERRIDES_KEY, merged)
        await localforage.removeItem(BUILTIN_OVERRIDES_KEY_LEGACY)
      }

      const speakingSettings = await localforage.getItem<SpeakingSettings>(SPEAKING_SETTINGS_KEY)
      if (speakingSettings)
        thinkingUseSpeakingActions.value = speakingSettings.thinkingUseSpeakingActions

      // Migrate builtin overrides: convert old boolean fields and strip 'loop' from tags
      const rawBuiltinOverrides = await localforage.getItem<Record<string, Record<string, unknown>>>(BUILTIN_OVERRIDES_KEY) ?? {}
      let builtinOverridesDirty = false
      const builtinOverrides: BuiltinOverrides = {}
      for (const [id, o] of Object.entries(rawBuiltinOverrides)) {
        const rawTags = (o.tags as string[] | undefined) ?? []
        const hadLoopTag = rawTags.includes('loop')
        const tags = rawTags.filter(t => t !== 'loop')
        let migrated = hadLoopTag
        if (o.isIdle && !tags.includes(idlePoolTag.value)) {
          tags.push(idlePoolTag.value)
          migrated = true
        }
        if (o.isSpeakingAction && !tags.includes(speakingPoolTag.value)) {
          tags.push(speakingPoolTag.value)
          migrated = true
        }
        // Derive loop from the old boolean field or from the presence of the 'loop' tag
        const loop = !!(o.loop || hadLoopTag)
        builtinOverrides[id] = {
          ...(o.enabled !== undefined ? { enabled: o.enabled as boolean } : {}),
          loop,
          tags,
        }
        if (migrated)
          builtinOverridesDirty = true
      }
      if (builtinOverridesDirty)
        await localforage.setItem<BuiltinOverrides>(BUILTIN_OVERRIDES_KEY, builtinOverrides)
      // Clean up orphaned localStorage key from the old loopTag setting
      localStorage.removeItem('settings/actions/loop-tag')

      const customEntries: ActionEntry[] = []
      // NOTICE: localforage.iterate stops early if the callback returns a non-undefined value.
      // An async callback always returns a Promise (non-undefined), so it would break after the
      // first item. We use a synchronous callback and collect migration tasks to run afterward.
      const pendingMigrations: Array<{ key: string, data: StoredCustomAction }> = []

      await localforage.iterate<StoredCustomAction, void>((val, key) => {
        if (!key.startsWith(LOCALFORAGE_KEY_PREFIX))
          return
        // Guard: skip any entry that isn't a valid StoredCustomAction (e.g. leftover legacy keys)
        if (!(val.file instanceof File))
          return

        // Migrate legacy boolean fields to tags, and extract loop as a direct property
        const rawTags = [...(val.tags ?? [])]
        const hadLoopTag = rawTags.includes('loop')
        const tags = rawTags.filter(t => t !== 'loop')
        const loop = !!(val.loop || hadLoopTag)
        let needsMigration = hadLoopTag
        if (val.isIdle && !tags.includes(idlePoolTag.value)) {
          tags.push(idlePoolTag.value)
          needsMigration = true
        }
        if (val.isSpeakingAction && !tags.includes(speakingPoolTag.value)) {
          tags.push(speakingPoolTag.value)
          needsMigration = true
        }
        if (needsMigration || val.loop !== undefined) {
          const { isIdle: _isIdle, isSpeakingAction: _isSpeakingAction, ...rest } = val
          pendingMigrations.push({ key, data: { ...rest, loop, tags } })
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
          loop,
          tags,
        })
      })

      // Run deferred migrations outside the iterate callback
      await Promise.all(
        pendingMigrations.map(({ key, data }) =>
          localforage.setItem(key, data)
            .catch(err => console.error('[animation-actions] failed to migrate legacy fields for', data.id, err)),
        ),
      )

      // Merge: built-ins first (with any persisted overrides applied), then custom sorted by import time (newest first)
      actions.value = [
        ...builtinActions.map((a) => {
          const override = builtinOverrides[a.id]
          if (!override)
            return a
          return {
            ...a,
            ...(override.enabled !== undefined ? { enabled: override.enabled } : {}),
            loop: override.loop ?? a.loop,
            // When user has explicitly saved tags, use them as the final value (replacement)
            // so that removing a builtin's default tag actually takes effect.
            tags: override.tags !== undefined ? override.tags : a.tags,
            // Restore persisted media blob URLs for builtins
            ...(override.bgMusicFile ? { bgMusicUrl: URL.createObjectURL(override.bgMusicFile) } : {}),
            ...(override.bgVideoFile ? { bgVideoUrl: URL.createObjectURL(override.bgVideoFile) } : {}),
            ...(override.fgVideoFile ? { fgVideoUrl: URL.createObjectURL(override.fgVideoFile) } : {}),
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
      loop: false,
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
      loop: false,
      tags: [],
    }

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

    // Persist: custom actions go to their own record; builtin overrides go to a shared map
    if (existing.isBuiltin) {
      const overrides = await localforage.getItem<BuiltinOverrides>(BUILTIN_OVERRIDES_KEY) ?? {}
      overrides[id] = {
        ...overrides[id],
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.loop !== undefined ? { loop: patch.loop } : {}),
        ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
        // Persist media files for builtins so they survive page reloads
        ...('bgMusicFile' in patch ? { bgMusicFile: patch.bgMusicFile ?? undefined } : {}),
        ...('bgVideoFile' in patch ? { bgVideoFile: patch.bgVideoFile ?? undefined } : {}),
        ...('fgVideoFile' in patch ? { fgVideoFile: patch.fgVideoFile ?? undefined } : {}),
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
        loop: patch.loop ?? stored.loop,
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
