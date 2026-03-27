<script setup lang="ts">
import type { ActionEntry } from '@proj-airi/stage-ui/stores/modules/animation-actions'

import { useAnimationActionsStore } from '@proj-airi/stage-ui/stores/modules/animation-actions'
import { Button, FieldInput } from '@proj-airi/ui'
import { useFileDialog } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

const { t } = useI18n()
const router = useRouter()
const store = useAnimationActionsStore()
const { actions, currentActionId, thinkingUseSpeakingActions } = storeToRefs(store)

function toggleThinkingMode() {
  thinkingUseSpeakingActions.value = !thinkingUseSpeakingActions.value
  store.saveSpeakingSettings()
}

// ---- Edit state ----
const editingId = ref<string | null>(null)
const editName = ref('')
const editDescription = ref('')
// pending files for the current edit session (null = clear, undefined = unchanged)
const editIsIdle = ref(false)
const editLoop = ref(false)
const editIsSpeakingAction = ref(false)
const editBgMusicFile = ref<File | null | undefined>(undefined)
const editBgVideoFile = ref<File | null | undefined>(undefined)
const editFgVideoFile = ref<File | null | undefined>(undefined)
// display names shown in the edit form
const editBgMusicName = ref('')
const editBgVideoName = ref('')
const editFgVideoName = ref('')

function startEdit(action: ActionEntry) {
  editingId.value = action.id
  editName.value = action.name
  editDescription.value = action.description
  editIsIdle.value = action.isIdle
  editLoop.value = action.loop
  editIsSpeakingAction.value = action.isSpeakingAction
  editBgMusicFile.value = undefined
  editBgVideoFile.value = undefined
  editFgVideoFile.value = undefined
  // Show existing file labels
  editBgMusicName.value = action.bgMusicUrl ? t('settings.pages.actions.media.existing-file') : ''
  editBgVideoName.value = action.bgVideoUrl ? t('settings.pages.actions.media.existing-file') : ''
  editFgVideoName.value = action.fgVideoUrl ? t('settings.pages.actions.media.existing-file') : ''
}

// file dialogs for edit form media uploads
const bgMusicDialog = useFileDialog({ accept: 'audio/*', multiple: false, reset: true })
bgMusicDialog.onChange((files) => {
  if (!files?.length)
    return
  editBgMusicFile.value = files[0]
  editBgMusicName.value = files[0].name
})

const bgVideoDialog = useFileDialog({ accept: 'video/*', multiple: false, reset: true })
bgVideoDialog.onChange((files) => {
  if (!files?.length)
    return
  editBgVideoFile.value = files[0]
  editBgVideoName.value = files[0].name
})

const fgVideoDialog = useFileDialog({ accept: 'video/*', multiple: false, reset: true })
fgVideoDialog.onChange((files) => {
  if (!files?.length)
    return
  editFgVideoFile.value = files[0]
  editFgVideoName.value = files[0].name
})

function clearBgMusic() {
  editBgMusicFile.value = null
  editBgMusicName.value = ''
}
function clearBgVideo() {
  editBgVideoFile.value = null
  editBgVideoName.value = ''
}
function clearFgVideo() {
  editFgVideoFile.value = null
  editFgVideoName.value = ''
}

async function saveEdit() {
  if (!editingId.value)
    return
  const patch: Parameters<typeof store.updateAction>[1] = {
    name: editName.value,
    description: editDescription.value,
    isIdle: editIsIdle.value,
    loop: editLoop.value,
    isSpeakingAction: editIsSpeakingAction.value,
  }
  if (editBgMusicFile.value !== undefined)
    patch.bgMusicFile = editBgMusicFile.value
  if (editBgVideoFile.value !== undefined)
    patch.bgVideoFile = editBgVideoFile.value
  if (editFgVideoFile.value !== undefined)
    patch.fgVideoFile = editFgVideoFile.value
  await store.updateAction(editingId.value, patch)
  editingId.value = null
}

function cancelEdit() {
  editingId.value = null
}

async function toggleEnabled(action: ActionEntry) {
  await store.updateAction(action.id, { enabled: !action.enabled })
}

async function toggleSpeakingAction(action: ActionEntry) {
  await store.updateAction(action.id, { isSpeakingAction: !action.isSpeakingAction })
}

// ---- Import .vrma ----
const importName = ref('')
const importDescription = ref('')
const pendingFile = ref<File | null>(null)
const showImportForm = ref(false)

const vrmaDialog = useFileDialog({ accept: '.vrma', multiple: false, reset: true })
vrmaDialog.onChange((files) => {
  if (!files?.length || !files[0].name.endsWith('.vrma'))
    return
  pendingFile.value = files[0]
  importName.value = files[0].name.replace('.vrma', '')
  importDescription.value = ''
  showImportForm.value = true
})

async function confirmImport() {
  if (!pendingFile.value)
    return
  await store.addCustomAction(
    pendingFile.value,
    importName.value || pendingFile.value.name.replace('.vrma', ''),
    importDescription.value,
  )
  pendingFile.value = null
  showImportForm.value = false
  importName.value = ''
  importDescription.value = ''
}

function cancelImport() {
  pendingFile.value = null
  showImportForm.value = false
}

// Media upload field configuration to avoid template repetition
const mediaFields = [
  {
    key: 'bgMusic' as const,
    icon: 'i-solar:music-note-bold',
    iconColor: 'text-purple-500',
    label: t('settings.pages.actions.media.bg-music'),
    dialog: bgMusicDialog,
    name: editBgMusicName,
    clear: clearBgMusic,
  },
  {
    key: 'bgVideo' as const,
    icon: 'i-solar:videocamera-record-bold',
    iconColor: 'text-orange-500',
    label: t('settings.pages.actions.media.bg-video'),
    dialog: bgVideoDialog,
    name: editBgVideoName,
    clear: clearBgVideo,
  },
  {
    key: 'fgVideo' as const,
    icon: 'i-solar:videocamera-add-bold',
    iconColor: 'text-blue-500',
    label: t('settings.pages.actions.media.fg-video'),
    dialog: fgVideoDialog,
    name: editFgVideoName,
    clear: clearFgVideo,
  },
]

function previewAction(action: ActionEntry) {
  store.playAction(action.id)
  router.push('/devtools/vrma-player')
}

function formatDuration(ms?: number) {
  if (ms === undefined)
    return '—'
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}
</script>

<template>
  <div class="flex flex-col gap-6 pb-12">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <div class="text-sm text-neutral-500 dark:text-neutral-400">
        {{ t('settings.pages.actions.description') }}
      </div>
      <Button
        size="sm"
        icon="i-solar:add-circle-bold"
        :label="t('settings.pages.actions.import-vrma')"
        @click="vrmaDialog.open()"
      />
    </div>

    <!-- Global speaking behavior -->
    <div class="border border-neutral-200 rounded-2xl p-4 space-y-2 dark:border-neutral-700">
      <div class="text-xs text-neutral-500 font-600 tracking-wide uppercase dark:text-neutral-400">
        {{ t('settings.pages.actions.speaking-behavior.title') }}
      </div>
      <label class="flex cursor-pointer select-none items-center gap-3">
        <input
          :checked="thinkingUseSpeakingActions"
          type="checkbox"
          class="rounded accent-rose-500"
          @change="toggleThinkingMode"
        >
        <div>
          <div class="text-sm text-neutral-700 dark:text-neutral-300">
            {{ t('settings.pages.actions.speaking-behavior.thinking-use-speaking-actions') }}
          </div>
          <div class="text-xs text-neutral-400">
            {{ t('settings.pages.actions.speaking-behavior.thinking-use-speaking-actions-hint') }}
          </div>
        </div>
      </label>
    </div>

    <!-- Import form -->
    <div
      v-if="showImportForm"
      class="border border-primary-300/40 rounded-2xl bg-primary-50/50 p-4 space-y-3 dark:border-primary-700/40 dark:bg-primary-900/10"
    >
      <div class="text-sm font-600">
        {{ t('settings.pages.actions.import-title', { filename: pendingFile?.name }) }}
      </div>
      <FieldInput v-model="importName" :label="t('settings.pages.actions.form.name')" :placeholder="t('settings.pages.actions.form.name-placeholder')" />
      <FieldInput v-model="importDescription" :label="t('settings.pages.actions.form.description')" :placeholder="t('settings.pages.actions.form.description-placeholder')" />
      <div class="flex gap-2">
        <Button size="sm" variant="primary" :label="t('settings.pages.actions.import-btn')" @click="confirmImport" />
        <Button size="sm" :label="t('settings.pages.actions.cancel')" @click="cancelImport" />
      </div>
    </div>

    <!-- Actions list -->
    <div class="space-y-2">
      <div
        v-for="action in actions"
        :key="action.id"
        :class="[
          'rounded-2xl border p-3 transition-all duration-150',
          action.id === currentActionId
            ? 'border-primary-400/60 bg-primary-50/50 dark:bg-primary-900/10'
            : 'border-neutral-300/40 dark:border-neutral-700/40',
          !action.enabled && 'opacity-50',
        ]"
      >
        <!-- Collapsed row -->
        <template v-if="editingId !== action.id">
          <div class="flex items-center gap-3">
            <div
              :class="[
                'shrink-0 text-lg',
                action.id === currentActionId
                  ? 'i-solar:play-circle-bold text-primary-400'
                  : 'i-solar:play-circle-linear text-neutral-400',
              ]"
            />
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <span :class="['font-600 text-sm truncate', action.id === currentActionId ? 'text-primary-500 dark:text-primary-300' : '']">
                  {{ action.name }}
                </span>
                <span
                  :class="[
                    'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                    action.isBuiltin
                      ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300'
                      : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300',
                  ]"
                >
                  {{ action.isBuiltin ? t('settings.pages.actions.badges.builtin') : t('settings.pages.actions.badges.custom') }}
                </span>
                <span
                  v-if="action.durationMs"
                  class="inline-flex items-center rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"
                >
                  {{ formatDuration(action.durationMs) }}
                </span>
                <span
                  v-if="action.isIdle"
                  class="inline-flex items-center rounded-full bg-teal-100 px-2 py-0.5 text-xs text-teal-700 dark:bg-teal-900/50 dark:text-teal-300"
                >
                  {{ t('settings.pages.actions.badges.idle') }}
                </span>
                <span
                  v-if="action.loop && !action.isIdle"
                  class="inline-flex items-center rounded-full bg-indigo-100 px-2 py-0.5 text-xs text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300"
                >
                  {{ t('settings.pages.actions.badges.loop') }}
                </span>
                <span
                  v-if="action.bgMusicUrl"
                  class="inline-flex items-center gap-0.5 rounded-full bg-purple-100 px-2 py-0.5 text-xs text-purple-700 dark:bg-purple-900/50 dark:text-purple-300"
                >
                  <div class="i-solar:music-note-bold text-xs" />
                  {{ t('settings.pages.actions.badges.music') }}
                </span>
                <span
                  v-if="action.bgVideoUrl || action.fgVideoUrl"
                  class="inline-flex items-center gap-0.5 rounded-full bg-orange-100 px-2 py-0.5 text-xs text-orange-700 dark:bg-orange-900/50 dark:text-orange-300"
                >
                  <div class="i-solar:videocamera-record-bold text-xs" />
                  {{ t('settings.pages.actions.badges.video') }}
                </span>
                <span
                  v-if="action.isSpeakingAction"
                  class="inline-flex items-center gap-0.5 rounded-full bg-rose-100 px-2 py-0.5 text-xs text-rose-700 dark:bg-rose-900/50 dark:text-rose-300"
                >
                  <div class="i-solar:microphone-bold text-xs" />
                  {{ t('settings.pages.actions.badges.speaking') }}
                </span>
              </div>
              <div class="line-clamp-1 mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                {{ action.description }}
              </div>
            </div>

            <!-- Action buttons -->
            <div class="flex shrink-0 items-center gap-1">
              <button
                :class="[
                  'flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs transition-colors',
                  action.isSpeakingAction
                    ? 'text-rose-500 bg-rose-50 hover:bg-rose-100 dark:bg-rose-900/20 dark:hover:bg-rose-900/30'
                    : 'text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800',
                ]"
                :title="action.isSpeakingAction ? t('settings.pages.actions.tooltips.remove-speaking') : t('settings.pages.actions.tooltips.add-speaking')"
                @click="toggleSpeakingAction(action)"
              >
                <div :class="[action.isSpeakingAction ? 'i-solar:microphone-bold' : 'i-solar:microphone-slash-bold', 'text-sm']" />
                <span>{{ t('settings.pages.actions.tooltips.speaking-label') }}</span>
              </button>
              <button
                :class="[
                  'p-1.5 rounded-lg transition-colors',
                  action.enabled
                    ? 'text-primary-500 hover:bg-primary-100 dark:hover:bg-primary-900/30'
                    : 'text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800',
                ]"
                :title="action.enabled ? t('settings.pages.actions.tooltips.disable') : t('settings.pages.actions.tooltips.enable')"
                @click="toggleEnabled(action)"
              >
                <div :class="[action.enabled ? 'i-solar:check-circle-bold' : 'i-solar:close-circle-bold']" />
              </button>
              <button
                class="rounded-lg p-1.5 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800"
                :title="t('settings.pages.actions.tooltips.edit')"
                @click="startEdit(action)"
              >
                <div class="i-solar:pen-2-bold" />
              </button>
              <button
                class="rounded-lg p-1.5 text-neutral-500 transition-colors hover:bg-primary-50 hover:text-primary-500 dark:hover:bg-primary-900/20"
                :title="t('settings.pages.actions.tooltips.preview')"
                @click="previewAction(action)"
              >
                <div class="i-solar:eye-bold" />
              </button>
              <button
                v-if="!action.isBuiltin"
                class="rounded-lg p-1.5 text-neutral-500 transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-900/20"
                :title="t('settings.pages.actions.tooltips.delete')"
                @click="store.removeCustomAction(action.id)"
              >
                <div class="i-solar:trash-bin-trash-bold" />
              </button>
            </div>
          </div>
        </template>

        <!-- Edit form -->
        <template v-else>
          <div class="space-y-3">
            <div class="text-sm text-neutral-700 font-600 dark:text-neutral-300">
              {{ t('settings.pages.actions.edit.title', { name: action.name }) }}
            </div>
            <FieldInput v-model="editName" :label="t('settings.pages.actions.form.name')" :placeholder="t('settings.pages.actions.form.name-placeholder')" />
            <FieldInput v-model="editDescription" :label="t('settings.pages.actions.form.description')" :placeholder="t('settings.pages.actions.form.description-placeholder')" />

            <!-- Playback behavior toggles -->
            <div class="flex flex-wrap gap-4">
              <label class="flex cursor-pointer select-none items-center gap-2">
                <input
                  v-model="editIsIdle"
                  type="checkbox"
                  class="rounded accent-primary-500"
                >
                <span class="text-sm text-neutral-700 dark:text-neutral-300">{{ t('settings.pages.actions.edit.idle-action') }}</span>
                <span class="text-xs text-neutral-400">{{ t('settings.pages.actions.edit.idle-hint') }}</span>
              </label>
              <label class="flex cursor-pointer select-none items-center gap-2">
                <input
                  v-model="editLoop"
                  type="checkbox"
                  class="rounded accent-primary-500"
                >
                <span class="text-sm text-neutral-700 dark:text-neutral-300">{{ t('settings.pages.actions.edit.loop') }}</span>
                <span class="text-xs text-neutral-400">{{ t('settings.pages.actions.edit.loop-hint') }}</span>
              </label>
              <label class="flex cursor-pointer select-none items-center gap-2">
                <input
                  v-model="editIsSpeakingAction"
                  type="checkbox"
                  class="rounded accent-rose-500"
                >
                <span class="text-sm text-neutral-700 dark:text-neutral-300">{{ t('settings.pages.actions.edit.speaking-action') }}</span>
                <span class="text-xs text-neutral-400">{{ t('settings.pages.actions.edit.speaking-hint') }}</span>
              </label>
            </div>

            <!-- Background Media section -->
            <div class="border border-neutral-200 rounded-xl p-3 space-y-2 dark:border-neutral-700">
              <div class="text-xs text-neutral-500 font-600 tracking-wide uppercase dark:text-neutral-400">
                {{ t('settings.pages.actions.media.title') }}
              </div>

              <div
                v-for="field in mediaFields"
                :key="field.key"
                class="flex items-center gap-2"
              >
                <div :class="[field.icon, 'text-sm shrink-0', field.iconColor]" />
                <div class="min-w-0 flex-1">
                  <div class="mb-1 text-xs text-neutral-500">
                    {{ field.label }}
                  </div>
                  <div class="flex items-center gap-2">
                    <span :class="['text-xs truncate flex-1', field.name.value ? 'text-neutral-700 dark:text-neutral-300' : 'text-neutral-400']">
                      {{ field.name.value || t('settings.pages.actions.media.no-file') }}
                    </span>
                    <button
                      class="shrink-0 rounded-lg bg-neutral-100 px-2 py-1 text-xs text-neutral-600 transition-colors dark:bg-neutral-800 hover:bg-neutral-200 dark:text-neutral-400 dark:hover:bg-neutral-700"
                      @click="field.dialog.open()"
                    >
                      {{ field.name.value ? t('settings.pages.actions.media.change') : t('settings.pages.actions.media.upload') }}
                    </button>
                    <button
                      v-if="field.name.value"
                      class="rounded-lg p-1 text-neutral-400 transition-colors hover:text-red-400"
                      title="Clear"
                      @click="field.clear"
                    >
                      <div class="i-solar:close-circle-bold text-sm" />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div class="flex gap-2">
              <Button size="sm" variant="primary" :label="t('settings.pages.actions.save')" @click="saveEdit" />
              <Button size="sm" :label="t('settings.pages.actions.cancel')" @click="cancelEdit" />
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- Decorative background icon -->
    <div
      v-motion
      class="pointer-events-none fixed bottom-0 right--10 z--1 size-60 flex items-center justify-center text-neutral-200/50 dark:text-neutral-600/20"
      :style="{ top: 'calc(100dvh - 15rem)' }"
      :initial="{ scale: 0.9, opacity: 0, rotate: 30 }"
      :enter="{ scale: 1, opacity: 1, rotate: 0 }"
      :duration="500"
    >
      <div class="i-solar:running-2-bold-duotone text-60" />
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.actions.title
  subtitleKey: settings.title
  descriptionKey: settings.pages.actions.description
  icon: i-solar:running-2-bold-duotone
  settingsEntry: true
  order: 4
  stageTransition:
    name: slide
    pageSpecificAvailable: true
</route>
