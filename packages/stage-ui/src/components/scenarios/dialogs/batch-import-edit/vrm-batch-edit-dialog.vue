<script setup lang="ts">
import type { DisplayModelFile } from '../../../../stores/display-models'

import { useMediaQuery, useResizeObserver, useScreenSafeArea } from '@vueuse/core'
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle, VisuallyHidden } from 'reka-ui'
import { DrawerContent, DrawerHandle, DrawerOverlay, DrawerPortal, DrawerRoot } from 'vaul-vue'
import { onMounted, reactive, watch } from 'vue'

import { useDisplayModelsStore } from '../../../../stores/display-models'

const props = defineProps<{
  models: DisplayModelFile[]
}>()

const show = defineModel('show', { type: Boolean, default: false })

const VRM_EXT_RE = /\.vrm$/i

const displayModelStore = useDisplayModelsStore()
const isDesktop = useMediaQuery('(min-width: 768px)')
const screenSafeArea = useScreenSafeArea()

useResizeObserver(document.documentElement, () => screenSafeArea.update())
onMounted(() => screenSafeArea.update())

// Local editable state — one entry per model
const editNames = reactive<Record<string, string>>({})

watch(
  () => props.models,
  (models) => {
    for (const m of models) {
      editNames[m.id] = m.name.replace(VRM_EXT_RE, '')
    }
  },
  { immediate: true },
)

async function handleSave() {
  await Promise.all(
    props.models.map(m => displayModelStore.renameDisplayModel(m.id, editNames[m.id] || m.name)),
  )
  show.value = false
}

function handleCancel() {
  show.value = false
}
</script>

<template>
  <DialogRoot v-if="isDesktop" :open="show" @update:open="value => show = value">
    <DialogPortal v-if="show">
      <DialogOverlay class="fixed inset-0 z-[9999] bg-black/50 backdrop-blur-sm data-[state=closed]:animate-fadeOut data-[state=open]:animate-fadeIn" />
      <DialogContent class="fixed left-1/2 top-1/2 z-[9999] max-h-[80dvh] max-w-2xl w-[92dvw] flex flex-col transform overflow-hidden rounded-2xl bg-white shadow-xl outline-none -translate-x-1/2 -translate-y-1/2 data-[state=closed]:animate-contentHide data-[state=open]:animate-contentShow dark:bg-neutral-900">
        <VisuallyHidden>
          <DialogTitle>Edit Imported VRM Models</DialogTitle>
        </VisuallyHidden>
        <div :class="['flex-1 overflow-y-auto p-6 scrollbar-none']">
          <div :class="['mb-5']">
            <div :class="['text-lg font-600']">
              Edit Imported Models
            </div>
            <div :class="['mt-1 text-sm text-neutral-500']">
              {{ models.length }} model{{ models.length !== 1 ? 's' : '' }} imported — rename before saving.
            </div>
          </div>

          <div :class="['space-y-3']">
            <div
              v-for="model in models"
              :key="model.id"
              :class="['flex items-center gap-3 rounded-xl border border-neutral-200 p-3 dark:border-neutral-700']"
            >
              <!-- Preview thumbnail -->
              <div :class="['h-16 w-12 shrink-0 overflow-hidden rounded-lg bg-neutral-100 dark:bg-neutral-800']">
                <img
                  v-if="model.previewImage"
                  :src="model.previewImage"
                  :class="['h-full w-full object-cover']"
                >
                <div
                  v-else
                  :class="['h-full w-full flex items-center justify-center text-neutral-400']"
                >
                  <div :class="['i-solar:ghost-bold-duotone text-2xl']" />
                </div>
              </div>

              <!-- Name input -->
              <div :class="['flex-1']">
                <div :class="['mb-1 text-xs text-neutral-500']">
                  Name
                </div>
                <input
                  v-model="editNames[model.id]"
                  type="text"
                  :class="[
                    'w-full rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm outline-none',
                    'focus:border-primary-400 focus:ring-2 focus:ring-primary-400/20',
                    'dark:border-neutral-600 dark:bg-neutral-800 dark:text-white',
                    'transition-colors duration-150',
                  ]"
                  placeholder="Model name..."
                >
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
        class="fixed bottom-0 left-0 right-0 z-1000 mt-20 max-h-[85%] flex flex-col rounded-t-2xl bg-neutral-50 outline-none dark:bg-neutral-900"
        :style="{ paddingBottom: `${Math.max(Number.parseFloat(screenSafeArea.bottom.value.replace('px', '')), 24)}px` }"
      >
        <DrawerHandle />
        <div :class="['flex-1 overflow-y-auto px-4 pb-2 pt-4 scrollbar-none']">
          <div :class="['mb-5']">
            <div :class="['text-lg font-600']">
              Edit Imported Models
            </div>
            <div :class="['mt-1 text-sm text-neutral-500']">
              {{ models.length }} model{{ models.length !== 1 ? 's' : '' }} imported — rename before saving.
            </div>
          </div>

          <div :class="['space-y-3']">
            <div
              v-for="model in models"
              :key="model.id"
              :class="['flex items-center gap-3 rounded-xl border border-neutral-200 p-3 dark:border-neutral-700']"
            >
              <div :class="['h-16 w-12 shrink-0 overflow-hidden rounded-lg bg-neutral-100 dark:bg-neutral-800']">
                <img
                  v-if="model.previewImage"
                  :src="model.previewImage"
                  :class="['h-full w-full object-cover']"
                >
                <div
                  v-else
                  :class="['h-full w-full flex items-center justify-center text-neutral-400']"
                >
                  <div :class="['i-solar:ghost-bold-duotone text-2xl']" />
                </div>
              </div>
              <div :class="['flex-1']">
                <div :class="['mb-1 text-xs text-neutral-500']">
                  Name
                </div>
                <input
                  v-model="editNames[model.id]"
                  type="text"
                  :class="[
                    'w-full rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm outline-none',
                    'focus:border-primary-400 focus:ring-2 focus:ring-primary-400/20',
                    'dark:border-neutral-600 dark:bg-neutral-800 dark:text-white',
                    'transition-colors duration-150',
                  ]"
                  placeholder="Model name..."
                >
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
