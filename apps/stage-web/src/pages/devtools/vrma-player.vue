<script setup lang="ts">
import type { DisplayModel } from '@proj-airi/stage-ui/stores/display-models'
import type { ActionEntry } from '@proj-airi/stage-ui/stores/modules/animation-actions'

import { ThreeScene } from '@proj-airi/stage-ui-three'
import { VrmaBatchEditDialog } from '@proj-airi/stage-ui/components/scenarios/dialogs/batch-import-edit'
import { DisplayModelFormat, useDisplayModelsStore } from '@proj-airi/stage-ui/stores/display-models'
import { useAnimationActionsStore } from '@proj-airi/stage-ui/stores/modules/animation-actions'
import { useSettings } from '@proj-airi/stage-ui/stores/settings'
import { Button } from '@proj-airi/ui'
import { useFileDialog } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, onMounted, reactive, ref } from 'vue'

const VRMA_EXT_RE = /\.vrma$/i

const animationActionsStore = useAnimationActionsStore()
const { actions } = storeToRefs(animationActionsStore)

const selectedAnimationId = ref<string>('idle_loop')
const selectedAnimation = computed(() =>
  actions.value.find(a => a.id === selectedAnimationId.value),
)

// VRM model state
const settingsStore = useSettings()
const { stageModelRenderer, stageModelSelected, stageModelSelectedUrl } = storeToRefs(settingsStore)

const displayModelsStore = useDisplayModelsStore()
const { displayModels } = storeToRefs(displayModelsStore)

const vrmModels = computed(() =>
  displayModels.value.filter(m => m.format === DisplayModelFormat.VRM),
)

function selectModel(model: DisplayModel) {
  stageModelSelected.value = model.id
  settingsStore.updateStageModel()
}

// Upload .vrma file
const pendingVrmaActions = ref<ActionEntry[]>([])
const showVrmaBatchEdit = ref(false)

const vrmaDialog = useFileDialog({ accept: '.vrma', multiple: true, reset: true })
vrmaDialog.onChange(async (files) => {
  if (!files || files.length === 0)
    return
  const entries = await Promise.all(
    Array.from(files)
      .filter(f => f.name.endsWith('.vrma'))
      .map(f => animationActionsStore.addCustomAction(f, f.name.replace(VRMA_EXT_RE, ''), '')),
  )
  if (entries.length > 0) {
    pendingVrmaActions.value = entries
    showVrmaBatchEdit.value = true
    selectedAnimationId.value = entries.at(-1)!.id
  }
})

// Upload .vrm model
const vrmDialog = useFileDialog({ accept: '.vrm', multiple: false, reset: true })
vrmDialog.onChange((files) => {
  if (!files || files.length === 0)
    return
  const file = files[0]
  if (!file.name.endsWith('.vrm'))
    return
  displayModelsStore.addDisplayModel(DisplayModelFormat.VRM, file).then(() => {
    const added = displayModels.value.find(m => m.name === file.name)
    if (added)
      selectModel(added)
  })
})

function removeUserAnimation(id: string) {
  animationActionsStore.removeCustomAction(id)
  if (selectedAnimationId.value === id)
    selectedAnimationId.value = 'idle_loop'
}

// ---- Batch select/delete ----
const batchSelectMode = ref(false)
const batchSelectedIds = reactive(new Set<string>())

const customActions = computed(() => actions.value.filter(a => !a.isBuiltin))

function toggleBatchSelect(id: string) {
  if (batchSelectedIds.has(id))
    batchSelectedIds.delete(id)
  else
    batchSelectedIds.add(id)
}

function toggleSelectAll() {
  if (batchSelectedIds.size === customActions.value.length) {
    batchSelectedIds.clear()
  }
  else {
    for (const a of customActions.value)
      batchSelectedIds.add(a.id)
  }
}

async function batchRemove() {
  for (const id of batchSelectedIds) {
    await animationActionsStore.removeCustomAction(id)
    if (selectedAnimationId.value === id)
      selectedAnimationId.value = 'idle_loop'
  }
  batchSelectedIds.clear()
  batchSelectMode.value = false
}

function exitBatchMode() {
  batchSelectMode.value = false
  batchSelectedIds.clear()
}

onMounted(async () => {
  await displayModelsStore.loadDisplayModelsFromIndexedDB()
  if (!stageModelSelectedUrl.value || stageModelRenderer.value !== 'vrm') {
    stageModelSelected.value = 'preset-vrm-1'
    await settingsStore.updateStageModel()
  }
})
</script>

<template>
  <div class="flex flex-col gap-4 p-4">
    <div>
      <div class="text-lg font-600">
        VRMA Animation Player
      </div>
      <div class="text-sm text-neutral-500">
        Test VRM animations — select a model and pick an action to preview
      </div>
    </div>

    <div class="grid gap-4 lg:grid-cols-2">
      <!-- Left: Controls -->
      <div class="flex flex-col gap-4">
        <!-- Model Selection -->
        <div class="border border-neutral-300/40 rounded-2xl p-3 space-y-3 dark:border-neutral-700/40">
          <div class="flex items-center justify-between">
            <div class="font-600">
              VRM Model
            </div>
            <Button size="sm" icon="i-solar:add-circle-bold" label="Upload VRM" @click="vrmDialog.open()" />
          </div>

          <div v-if="vrmModels.length === 0" class="py-2 text-sm text-neutral-400">
            No VRM models found.
          </div>
          <div v-else class="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <button
              v-for="model in vrmModels"
              :key="model.id"
              class="overflow-hidden border-2 rounded-xl transition-all duration-150"
              :class="[
                stageModelSelected === model.id
                  ? 'border-primary-400 ring-2 ring-primary-400/40'
                  : 'border-transparent hover:border-neutral-400/40',
              ]"
              @click="selectModel(model)"
            >
              <img
                v-if="model.previewImage"
                :src="model.previewImage"
                class="aspect-[3/4] w-full object-cover"
              >
              <div
                v-else
                class="aspect-[3/4] w-full flex items-center justify-center bg-neutral-100 text-neutral-400 dark:bg-neutral-800"
              >
                <div class="i-solar:ghost-bold-duotone text-3xl" />
              </div>
              <div
                class="truncate bg-neutral-50 px-2 py-1 text-center text-xs dark:bg-neutral-900"
                :class="stageModelSelected === model.id ? 'text-primary-400 font-600' : 'text-neutral-600 dark:text-neutral-400'"
              >
                {{ model.name }}
              </div>
            </button>
          </div>
        </div>

        <!-- Animation List -->
        <div class="border border-neutral-300/40 rounded-2xl p-3 space-y-3 dark:border-neutral-700/40">
          <div class="flex items-center justify-between gap-2">
            <div class="font-600">
              Animations
            </div>
            <div class="flex items-center gap-2">
              <template v-if="batchSelectMode">
                <button
                  :class="['rounded-lg px-2 py-1 text-xs transition-colors', 'bg-neutral-100 hover:bg-neutral-200 dark:bg-neutral-800 dark:hover:bg-neutral-700']"
                  @click="toggleSelectAll"
                >
                  {{ batchSelectedIds.size === customActions.length ? 'Deselect All' : 'Select All' }}
                </button>
                <button
                  :class="[
                    'flex items-center gap-1 rounded-lg px-2 py-1 text-xs transition-colors',
                    batchSelectedIds.size > 0
                      ? 'bg-red-500/20 text-red-500 hover:bg-red-500/40'
                      : 'bg-neutral-100 text-neutral-400 cursor-not-allowed dark:bg-neutral-800',
                  ]"
                  :disabled="batchSelectedIds.size === 0"
                  @click="batchRemove"
                >
                  <div class="i-solar:trash-bin-trash-bold" />
                  Delete ({{ batchSelectedIds.size }})
                </button>
                <button
                  :class="['rounded-lg px-2 py-1 text-xs transition-colors', 'bg-neutral-100 hover:bg-neutral-200 dark:bg-neutral-800 dark:hover:bg-neutral-700']"
                  @click="exitBatchMode"
                >
                  Cancel
                </button>
              </template>
              <template v-else>
                <Button size="sm" icon="i-solar:check-square-bold" label="Select" @click="batchSelectMode = true" />
                <Button size="sm" icon="i-solar:add-circle-bold" label="Upload .vrma" @click="vrmaDialog.open()" />
              </template>
            </div>
          </div>

          <div class="overflow-x-auto border border-neutral-200 rounded-lg dark:border-neutral-700">
            <table class="w-full text-left text-sm">
              <thead class="bg-neutral-100 dark:bg-neutral-800">
                <tr>
                  <th v-if="batchSelectMode" class="w-10 px-2 py-2" />
                  <th class="px-4 py-2 font-medium">
                    Name
                  </th>
                  <th class="px-4 py-2 font-medium">
                    Type
                  </th>
                  <th class="px-4 py-2 font-medium">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="anim in actions"
                  :key="anim.id"
                  class="cursor-pointer border-t border-neutral-200 transition-colors duration-100 dark:border-neutral-700"
                  :class="[
                    selectedAnimationId === anim.id
                      ? 'bg-primary-50 dark:bg-primary-900/20'
                      : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/50',
                  ]"
                  @click="batchSelectMode && !anim.isBuiltin ? toggleBatchSelect(anim.id) : (selectedAnimationId = anim.id)"
                >
                  <td v-if="batchSelectMode" class="w-10 px-2 py-2">
                    <div
                      :class="[
                        'h-4 w-4 flex items-center justify-center rounded transition-colors',
                        !anim.isBuiltin
                          ? batchSelectedIds.has(anim.id)
                            ? 'bg-primary-500 text-white'
                            : 'bg-neutral-200 dark:bg-neutral-700'
                          : 'bg-neutral-100 dark:bg-neutral-800 cursor-not-allowed',
                      ]"
                    >
                      <div v-if="batchSelectedIds.has(anim.id)" class="i-solar:check-read-bold text-xs" />
                    </div>
                  </td>
                  <td class="px-4 py-2">
                    <div class="flex items-center gap-2">
                      <div
                        :class="[
                          selectedAnimationId === anim.id
                            ? 'i-solar:play-circle-bold text-primary-400'
                            : 'i-solar:play-circle-linear text-neutral-400',
                        ]"
                      />
                      <span :class="selectedAnimationId === anim.id ? 'text-primary-500 dark:text-primary-300 font-600' : ''">
                        {{ anim.name }}
                      </span>
                    </div>
                  </td>
                  <td class="px-4 py-2">
                    <span
                      class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                      :class="anim.isBuiltin
                        ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300'
                        : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300'"
                    >
                      {{ anim.isBuiltin ? 'Built-in' : 'Uploaded' }}
                    </span>
                  </td>
                  <td class="px-4 py-2">
                    <Button
                      v-if="!anim.isBuiltin"
                      variant="danger"
                      size="sm"
                      icon="i-solar:trash-bin-trash-bold"
                      @click.stop="removeUserAnimation(anim.id)"
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="text-xs text-neutral-400">
            Click a row to play. Upload custom <code>.vrma</code> files from VRoid Hub or BOOTH.
          </div>
        </div>
      </div>

      <!-- Right: Preview -->
      <div class="relative overflow-hidden border border-neutral-300/40 rounded-2xl dark:border-neutral-700/40">
        <!-- Now Playing badge -->
        <div class="absolute left-3 top-3 z-10 rounded-lg bg-black/50 px-2 py-1 text-xs text-white backdrop-blur">
          <div class="flex items-center gap-1">
            <div class="i-solar:play-bold text-primary-300" />
            <span>{{ selectedAnimation?.name ?? 'None' }}</span>
          </div>
        </div>

        <div class="h-full min-h-80 lg:min-h-120">
          <ThreeScene
            v-if="stageModelRenderer === 'vrm'"
            :model-src="stageModelSelectedUrl"
            :idle-animation="selectedAnimation?.vrmaUrl"
            :paused="false"
            @error="console.error"
          />
          <div v-else class="p-4 text-sm text-red-500">
            Please select a VRM model.
          </div>
        </div>
      </div>
    </div>
  </div>

  <VrmaBatchEditDialog v-model:show="showVrmaBatchEdit" :actions="pendingVrmaActions" />
</template>

<route lang="yaml">
meta:
  layout: plain
</route>
