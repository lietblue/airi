<script setup lang="ts">
import type { ActionEntry } from '../../../../stores/modules/animation-actions'

import { useMediaQuery, useResizeObserver, useScreenSafeArea } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle, VisuallyHidden } from 'reka-ui'
import { DrawerContent, DrawerHandle, DrawerOverlay, DrawerPortal, DrawerRoot } from 'vaul-vue'
import { onMounted, reactive, watch } from 'vue'

import { useAnimationActionsStore } from '../../../../stores/modules/animation-actions'

const props = defineProps<{
  actions: ActionEntry[]
}>()

const show = defineModel('show', { type: Boolean, default: false })

const animationActionsStore = useAnimationActionsStore()
const { allTags } = storeToRefs(animationActionsStore)
const isDesktop = useMediaQuery('(min-width: 768px)')
const screenSafeArea = useScreenSafeArea()

useResizeObserver(document.documentElement, () => screenSafeArea.update())
onMounted(() => screenSafeArea.update())

interface EditState {
  name: string
  description: string
  loop: boolean
  tags: string[]
  newTag: string
}

const editStates = reactive<Record<string, EditState>>({})

watch(
  () => props.actions,
  (actions) => {
    for (const a of actions) {
      editStates[a.id] = {
        name: a.name,
        description: a.description,
        loop: a.loop,
        tags: [...a.tags],
        newTag: '',
      }
    }
  },
  { immediate: true },
)

function addTag(id: string) {
  const state = editStates[id]
  if (!state)
    return
  const tag = state.newTag.trim()
  if (tag && !state.tags.includes(tag)) {
    state.tags.push(tag)
  }
  state.newTag = ''
}

function removeTag(id: string, tag: string) {
  const state = editStates[id]
  if (!state)
    return
  state.tags = state.tags.filter(t => t !== tag)
}

async function handleSave() {
  await Promise.all(
    props.actions.map(a =>
      animationActionsStore.updateAction(a.id, {
        name: editStates[a.id]?.name || a.name,
        description: editStates[a.id]?.description ?? a.description,
        loop: editStates[a.id]?.loop ?? a.loop,
        tags: editStates[a.id]?.tags ?? a.tags,
      }),
    ),
  )
  show.value = false
}

function handleCancel() {
  show.value = false
}
</script>

<template>
  <!-- Unique datalist id per dialog instance to avoid collisions if multiple dialogs ever coexist -->
  <datalist id="vrma-batch-edit-tags-list">
    <option v-for="tag in allTags" :key="tag" :value="tag" />
  </datalist>

  <DialogRoot v-if="isDesktop" :open="show" @update:open="value => show = value">
    <DialogPortal v-if="show">
      <DialogOverlay class="fixed inset-0 z-[9999] bg-black/50 backdrop-blur-sm data-[state=closed]:animate-fadeOut data-[state=open]:animate-fadeIn" />
      <DialogContent class="fixed left-1/2 top-1/2 z-[9999] max-h-[85dvh] max-w-2xl w-[92dvw] flex flex-col transform overflow-hidden rounded-2xl bg-white shadow-xl outline-none -translate-x-1/2 -translate-y-1/2 data-[state=closed]:animate-contentHide data-[state=open]:animate-contentShow dark:bg-neutral-900">
        <VisuallyHidden>
          <DialogTitle>Edit Imported VRMA Animations</DialogTitle>
        </VisuallyHidden>
        <div :class="['flex-1 overflow-y-auto p-6 scrollbar-none']">
          <div :class="['mb-5']">
            <div :class="['text-lg font-600']">
              Edit Imported Animations
            </div>
            <div :class="['mt-1 text-sm text-neutral-500']">
              {{ actions.length }} animation{{ actions.length !== 1 ? 's' : '' }} imported — edit details before saving.
            </div>
          </div>

          <div :class="['space-y-4']">
            <div
              v-for="action in actions"
              :key="action.id"
              :class="['rounded-xl border border-neutral-200 p-4 space-y-3 dark:border-neutral-700']"
            >
              <!-- Name & description -->
              <div :class="['grid gap-3 sm:grid-cols-2']">
                <div>
                  <div :class="['mb-1 text-xs text-neutral-500']">
                    Name
                  </div>
                  <input
                    v-if="editStates[action.id]"
                    v-model="editStates[action.id].name"
                    type="text"
                    :class="[
                      'w-full rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm outline-none',
                      'focus:border-primary-400 focus:ring-2 focus:ring-primary-400/20',
                      'dark:border-neutral-600 dark:bg-neutral-800 dark:text-white',
                      'transition-colors duration-150',
                    ]"
                    placeholder="Animation name..."
                  >
                </div>
                <div>
                  <div :class="['mb-1 text-xs text-neutral-500']">
                    Description
                  </div>
                  <input
                    v-if="editStates[action.id]"
                    v-model="editStates[action.id].description"
                    type="text"
                    :class="[
                      'w-full rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm outline-none',
                      'focus:border-primary-400 focus:ring-2 focus:ring-primary-400/20',
                      'dark:border-neutral-600 dark:bg-neutral-800 dark:text-white',
                      'transition-colors duration-150',
                    ]"
                    placeholder="Optional description..."
                  >
                </div>
              </div>

              <!-- Loop toggle -->
              <label
                v-if="editStates[action.id]"
                :class="['flex cursor-pointer select-none items-center gap-2']"
              >
                <input
                  v-model="editStates[action.id].loop"
                  type="checkbox"
                  :class="['rounded accent-indigo-500']"
                >
                <span :class="['text-sm text-neutral-700 dark:text-neutral-300']">Loop animation</span>
              </label>

              <!-- Tags -->
              <div
                v-if="editStates[action.id]"
                :class="['rounded-lg border border-neutral-200 p-2.5 space-y-2 dark:border-neutral-700']"
              >
                <div :class="['text-xs text-neutral-500 font-600 uppercase tracking-wide']">
                  Tags
                </div>
                <div :class="['flex flex-wrap gap-1 min-h-5']">
                  <span
                    v-for="tag in editStates[action.id].tags"
                    :key="tag"
                    :class="['inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-xs text-violet-700 dark:bg-violet-900/50 dark:text-violet-300']"
                  >
                    {{ tag }}
                    <button
                      type="button"
                      :class="['leading-none transition-colors hover:text-red-500']"
                      @click="removeTag(action.id, tag)"
                    >
                      ×
                    </button>
                  </span>
                  <span
                    v-if="!editStates[action.id].tags.length"
                    :class="['text-xs text-neutral-400 italic']"
                  >
                    No tags
                  </span>
                </div>
                <div :class="['flex gap-2']">
                  <input
                    v-model="editStates[action.id].newTag"
                    list="vrma-batch-edit-tags-list"
                    type="text"
                    placeholder="Add tag..."
                    :class="[
                      'flex-1 rounded border border-neutral-300 bg-white px-2 py-1 text-xs',
                      'dark:border-neutral-700 dark:bg-neutral-900',
                    ]"
                    @keydown.enter.prevent="addTag(action.id)"
                  >
                  <button
                    type="button"
                    :class="[
                      'rounded bg-neutral-100 px-2 py-1 text-xs text-neutral-600 transition-colors',
                      'dark:bg-neutral-800 dark:text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-700',
                    ]"
                    @click="addTag(action.id)"
                  >
                    Add
                  </button>
                </div>
              </div>

              <!-- Duration (read-only) -->
              <div
                v-if="action.durationMs"
                :class="['text-xs text-neutral-400']"
              >
                Duration: {{ (action.durationMs / 1000).toFixed(2) }}s
              </div>
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div :class="['flex justify-end gap-2 border-t border-neutral-200 px-6 py-4 dark:border-neutral-700']">
          <button
            :class="[
              'rounded-lg px-4 py-1.5 text-sm transition-colors duration-150',
              'bg-neutral-100 text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700',
            ]"
            @click="handleCancel"
          >
            Cancel
          </button>
          <button
            :class="[
              'rounded-lg px-4 py-1.5 text-sm font-600 transition-colors duration-150',
              'bg-primary-500 text-white hover:bg-primary-600',
            ]"
            @click="handleSave"
          >
            Save
          </button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>

  <DrawerRoot v-else :open="show" should-scale-background @update:open="value => show = value">
    <DrawerPortal v-if="show">
      <DrawerOverlay class="fixed inset-0" />
      <DrawerContent
        class="fixed bottom-0 left-0 right-0 z-1000 mt-20 max-h-[90%] flex flex-col rounded-t-2xl bg-neutral-50 outline-none dark:bg-neutral-900"
        :style="{ paddingBottom: `${Math.max(Number.parseFloat(screenSafeArea.bottom.value.replace('px', '')), 24)}px` }"
      >
        <DrawerHandle />
        <div :class="['flex-1 overflow-y-auto px-4 pb-2 pt-4 scrollbar-none']">
          <div :class="['mb-5']">
            <div :class="['text-lg font-600']">
              Edit Imported Animations
            </div>
            <div :class="['mt-1 text-sm text-neutral-500']">
              {{ actions.length }} animation{{ actions.length !== 1 ? 's' : '' }} imported — edit details before saving.
            </div>
          </div>

          <div :class="['space-y-4']">
            <div
              v-for="action in actions"
              :key="action.id"
              :class="['rounded-xl border border-neutral-200 p-4 space-y-3 dark:border-neutral-700']"
            >
              <div>
                <div :class="['mb-1 text-xs text-neutral-500']">
                  Name
                </div>
                <input
                  v-if="editStates[action.id]"
                  v-model="editStates[action.id].name"
                  type="text"
                  :class="[
                    'w-full rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm outline-none',
                    'focus:border-primary-400 focus:ring-2 focus:ring-primary-400/20',
                    'dark:border-neutral-600 dark:bg-neutral-800 dark:text-white',
                    'transition-colors duration-150',
                  ]"
                  placeholder="Animation name..."
                >
              </div>
              <div>
                <div :class="['mb-1 text-xs text-neutral-500']">
                  Description
                </div>
                <input
                  v-if="editStates[action.id]"
                  v-model="editStates[action.id].description"
                  type="text"
                  :class="[
                    'w-full rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm outline-none',
                    'focus:border-primary-400 focus:ring-2 focus:ring-primary-400/20',
                    'dark:border-neutral-600 dark:bg-neutral-800 dark:text-white',
                    'transition-colors duration-150',
                  ]"
                  placeholder="Optional description..."
                >
              </div>
              <label
                v-if="editStates[action.id]"
                :class="['flex cursor-pointer select-none items-center gap-2']"
              >
                <input
                  v-model="editStates[action.id].loop"
                  type="checkbox"
                  :class="['rounded accent-indigo-500']"
                >
                <span :class="['text-sm text-neutral-700 dark:text-neutral-300']">Loop animation</span>
              </label>
              <div
                v-if="editStates[action.id]"
                :class="['rounded-lg border border-neutral-200 p-2.5 space-y-2 dark:border-neutral-700']"
              >
                <div :class="['text-xs text-neutral-500 font-600 uppercase tracking-wide']">
                  Tags
                </div>
                <div :class="['flex flex-wrap gap-1 min-h-5']">
                  <span
                    v-for="tag in editStates[action.id].tags"
                    :key="tag"
                    :class="['inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-xs text-violet-700 dark:bg-violet-900/50 dark:text-violet-300']"
                  >
                    {{ tag }}
                    <button
                      type="button"
                      :class="['leading-none transition-colors hover:text-red-500']"
                      @click="removeTag(action.id, tag)"
                    >
                      ×
                    </button>
                  </span>
                  <span
                    v-if="!editStates[action.id].tags.length"
                    :class="['text-xs text-neutral-400 italic']"
                  >
                    No tags
                  </span>
                </div>
                <div :class="['flex gap-2']">
                  <input
                    v-model="editStates[action.id].newTag"
                    list="vrma-batch-edit-tags-list"
                    type="text"
                    placeholder="Add tag..."
                    :class="[
                      'flex-1 rounded border border-neutral-300 bg-white px-2 py-1 text-xs',
                      'dark:border-neutral-700 dark:bg-neutral-900',
                    ]"
                    @keydown.enter.prevent="addTag(action.id)"
                  >
                  <button
                    type="button"
                    :class="[
                      'rounded bg-neutral-100 px-2 py-1 text-xs text-neutral-600 transition-colors',
                      'dark:bg-neutral-800 dark:text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-700',
                    ]"
                    @click="addTag(action.id)"
                  >
                    Add
                  </button>
                </div>
              </div>
              <div
                v-if="action.durationMs"
                :class="['text-xs text-neutral-400']"
              >
                Duration: {{ (action.durationMs / 1000).toFixed(2) }}s
              </div>
            </div>
          </div>
        </div>

        <div :class="['flex gap-2 px-4 py-3']">
          <button
            :class="[
              'flex-1 rounded-xl py-2.5 text-sm transition-colors duration-150',
              'bg-neutral-100 text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700',
            ]"
            @click="handleCancel"
          >
            Cancel
          </button>
          <button
            :class="[
              'flex-1 rounded-xl py-2.5 text-sm font-600 transition-colors duration-150',
              'bg-primary-500 text-white hover:bg-primary-600',
            ]"
            @click="handleSave"
          >
            Save
          </button>
        </div>
      </DrawerContent>
    </DrawerPortal>
  </DrawerRoot>
</template>
