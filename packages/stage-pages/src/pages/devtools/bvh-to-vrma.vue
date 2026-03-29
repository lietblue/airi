<script setup lang="ts">
import type { RootMotionMode } from '@proj-airi/stage-ui-three/utils/bvh-to-vrma'

import { BVHLoader, convertBVHToVRMA as convertV1 } from '@proj-airi/stage-ui-three/utils/bvh-to-vrma'
import { convertBVHToVRMA as convertV2 } from '@proj-airi/stage-ui-three/utils/bvh-to-vrma-2'
import { useAnimationActionsStore } from '@proj-airi/stage-ui/stores/modules/animation-actions'
import { computed, ref } from 'vue'

type ConverterVersion = 'v1' | 'v2'

interface ConversionItem {
  name: string
  status: 'pending' | 'converting' | 'done' | 'error'
  error?: string
  blob?: Blob
  imported?: boolean
}

const animationActionsStore = useAnimationActionsStore()

const items = ref<ConversionItem[]>([])
const isDragging = ref(false)
const scale = ref(0.01)
const rootMotion = ref<RootMotionMode>('y-only')
const converterVersion = ref<ConverterVersion>('v1')
const importing = ref(false)

const bvhLoader = new BVHLoader()
const BVH_EXT_RE = /\.bvh$/i

function handleDragOver(e: DragEvent) {
  e.preventDefault()
  isDragging.value = true
}

function handleDragLeave() {
  isDragging.value = false
}

function handleDrop(e: DragEvent) {
  e.preventDefault()
  isDragging.value = false
  const files = Array.from(e.dataTransfer?.files ?? []).filter(f => f.name.endsWith('.bvh'))
  addFiles(files)
}

function handleFileInput(e: Event) {
  const target = e.target as HTMLInputElement
  const files = Array.from(target.files ?? []).filter(f => f.name.endsWith('.bvh'))
  addFiles(files)
  target.value = ''
}

function addFiles(files: File[]) {
  for (const file of files) {
    if (items.value.some(i => i.name === file.name))
      continue
    items.value.push({ name: file.name, status: 'pending' })
  }
  convertAll(files)
}

async function convertAll(files: File[]) {
  for (const file of files) {
    const item = items.value.find(i => i.name === file.name)
    if (!item || item.status !== 'pending')
      continue

    item.status = 'converting'
    try {
      const text = await file.text()
      const bvh = bvhLoader.parse(text)

      let buffer: ArrayBuffer
      if (converterVersion.value === 'v2') {
        buffer = await convertV2(bvh, { scale: scale.value })
      }
      else {
        buffer = await convertV1(bvh, { scale: scale.value, rootMotion: rootMotion.value })
      }

      item.blob = new Blob([buffer], { type: 'model/gltf-binary' })
      item.status = 'done'
    }
    catch (err) {
      item.status = 'error'
      item.error = err instanceof Error ? err.message : String(err)
    }
  }
}

function downloadSingle(item: ConversionItem) {
  if (!item.blob)
    return
  const url = URL.createObjectURL(item.blob)
  const a = document.createElement('a')
  a.href = url
  a.download = item.name.replace(BVH_EXT_RE, '.vrma')
  a.click()
  URL.revokeObjectURL(url)
}

async function downloadAll() {
  const doneItems = items.value.filter(i => i.status === 'done' && i.blob)
  if (doneItems.length === 0)
    return

  if (doneItems.length === 1) {
    downloadSingle(doneItems[0])
    return
  }

  // Dynamic import JSZip for batch download
  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()

  for (const item of doneItems) {
    const name = item.name.replace(BVH_EXT_RE, '.vrma')
    zip.file(name, item.blob!)
  }

  const blob = await zip.generateAsync({ type: 'blob' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'vrma-animations.zip'
  a.click()
  URL.revokeObjectURL(url)
}

function removeItem(index: number) {
  items.value.splice(index, 1)
}

function clearAll() {
  items.value = []
}

async function importSingle(item: ConversionItem) {
  if (!item.blob || item.imported)
    return
  const vrmaName = item.name.replace(BVH_EXT_RE, '.vrma')
  const file = new File([item.blob], vrmaName, { type: 'model/gltf-binary' })
  const baseName = item.name.replace(BVH_EXT_RE, '')
  await animationActionsStore.addCustomAction(file, baseName, `Imported from BVH: ${item.name}`)
  item.imported = true
}

async function importAll() {
  const importable = items.value.filter(i => i.status === 'done' && i.blob && !i.imported)
  if (importable.length === 0)
    return
  importing.value = true
  for (const item of importable)
    await importSingle(item)
  importing.value = false
}

const doneCount = computed(() => items.value.filter(i => i.status === 'done').length)
const importableCount = computed(() => items.value.filter(i => i.status === 'done' && i.blob && !i.imported).length)
const errorCount = computed(() => items.value.filter(i => i.status === 'error').length)
</script>

<template>
  <div :class="['flex flex-col gap-4', 'p-4']">
    <!-- Options -->
    <div :class="['flex flex-wrap items-center gap-4', 'text-sm']">
      <div :class="['flex items-center gap-2']">
        <label for="bvh-converter">Converter</label>
        <select
          id="bvh-converter"
          v-model="converterVersion"
          :class="[
            'rounded border px-2 py-1',
            'border-neutral-300 dark:border-neutral-600',
            'bg-white dark:bg-neutral-800',
          ]"
        >
          <option value="v1">
            v1 (custom fixes)
          </option>
          <option value="v2">
            v2 (SystemAnimatorOnline)
          </option>
        </select>
      </div>
      <div :class="['flex items-center gap-2']">
        <label for="bvh-scale">Scale</label>
        <input
          id="bvh-scale"
          v-model.number="scale"
          type="number"
          step="0.001"
          min="0.001"
          :class="[
            'w-24 rounded border px-2 py-1',
            'border-neutral-300 dark:border-neutral-600',
            'bg-white dark:bg-neutral-800',
          ]"
        >
        <span :class="['text-neutral-500']">cm -> 0.01, m -> 1.0</span>
      </div>
      <div
        v-if="converterVersion === 'v1'"
        :class="['flex items-center gap-2']"
      >
        <label for="bvh-root-motion">Root Motion</label>
        <select
          id="bvh-root-motion"
          v-model="rootMotion"
          :class="[
            'rounded border px-2 py-1',
            'border-neutral-300 dark:border-neutral-600',
            'bg-white dark:bg-neutral-800',
          ]"
        >
          <option value="y-only">
            Y only (strip XZ drift)
          </option>
          <option value="strip">
            Strip all (rotation only)
          </option>
          <option value="keep">
            Keep full motion
          </option>
        </select>
      </div>
    </div>

    <!-- Converter description -->
    <div :class="['text-xs text-neutral-500']">
      <template v-if="converterVersion === 'v1'">
        v1: Outlier frame detection + root motion modes + rest-offset subtraction.
      </template>
      <template v-else>
        v2: Faithful SystemAnimatorOnline/bvh2vrma port. Grounding fix, no root motion stripping.
      </template>
    </div>

    <!-- Drop zone -->
    <label
      :class="[
        'flex flex-col items-center justify-center',
        'cursor-pointer rounded-lg border-2 border-dashed p-8',
        'transition-colors duration-200',
        isDragging
          ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
          : 'border-neutral-300 dark:border-neutral-600',
        'hover:border-blue-400 hover:bg-blue-50/50 dark:hover:bg-blue-900/10',
      ]"
      @dragover="handleDragOver"
      @dragleave="handleDragLeave"
      @drop="handleDrop"
    >
      <input
        type="file"
        accept=".bvh"
        multiple
        hidden
        @change="handleFileInput"
      >
      <div :class="['i-solar:upload-minimalistic-bold-duotone', 'text-3xl text-neutral-400']" />
      <span :class="['mt-2 text-sm text-neutral-500']">
        Drop .bvh files here or click to browse
      </span>
    </label>

    <!-- Summary bar -->
    <div
      v-if="items.length > 0"
      :class="['flex items-center justify-between', 'text-sm']"
    >
      <span>
        {{ items.length }} file(s)
        <template v-if="doneCount > 0">
          · <span :class="['text-green-600 dark:text-green-400']">{{ doneCount }} done</span>
        </template>
        <template v-if="errorCount > 0">
          · <span :class="['text-red-600 dark:text-red-400']">{{ errorCount }} failed</span>
        </template>
      </span>
      <div :class="['flex gap-2']">
        <button
          :class="[
            'rounded px-3 py-1 text-sm',
            'bg-green-500 text-white',
            'hover:bg-green-600',
            'disabled:opacity-40 disabled:cursor-not-allowed',
          ]"
          :disabled="importableCount === 0 || importing"
          @click="importAll"
        >
          {{ importing ? 'Importing...' : `Import All (${importableCount})` }}
        </button>
        <button
          :class="[
            'rounded px-3 py-1 text-sm',
            'bg-blue-500 text-white',
            'hover:bg-blue-600',
            'disabled:opacity-40 disabled:cursor-not-allowed',
          ]"
          :disabled="doneCount === 0"
          @click="downloadAll"
        >
          {{ doneCount > 1 ? 'Download All (.zip)' : 'Download' }}
        </button>
        <button
          :class="[
            'rounded px-3 py-1 text-sm',
            'bg-neutral-200 dark:bg-neutral-700',
            'hover:bg-neutral-300 dark:hover:bg-neutral-600',
          ]"
          @click="clearAll"
        >
          Clear
        </button>
      </div>
    </div>

    <!-- File list -->
    <div
      v-if="items.length > 0"
      :class="['flex flex-col gap-1']"
    >
      <div
        v-for="(item, index) in items"
        :key="item.name"
        :class="[
          'flex items-center gap-3 rounded px-3 py-2',
          'bg-neutral-50 dark:bg-neutral-800/50',
        ]"
      >
        <!-- Status icon -->
        <div
          :class="[
            item.status === 'pending' ? 'i-solar:clock-circle-line-duotone text-neutral-400' : '',
            item.status === 'converting' ? 'i-solar:refresh-bold-duotone text-blue-500 animate-spin' : '',
            item.status === 'done' ? 'i-solar:check-circle-bold-duotone text-green-500' : '',
            item.status === 'error' ? 'i-solar:close-circle-bold-duotone text-red-500' : '',
            'text-lg flex-shrink-0',
          ]"
        />

        <!-- File name -->
        <span :class="['flex-1 truncate text-sm']">{{ item.name }}</span>

        <!-- Error message -->
        <span
          v-if="item.error"
          :class="['text-xs text-red-500 truncate max-w-48']"
          :title="item.error"
        >
          {{ item.error }}
        </span>

        <!-- Actions -->
        <button
          v-if="item.status === 'done' && !item.imported"
          :class="[
            'rounded px-2 py-0.5 text-xs',
            'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
            'hover:bg-green-200 dark:hover:bg-green-900/50',
          ]"
          @click="importSingle(item)"
        >
          Import
        </button>
        <span
          v-if="item.imported"
          :class="['text-xs text-green-600 dark:text-green-400']"
        >
          Imported
        </span>
        <button
          v-if="item.status === 'done'"
          :class="[
            'rounded px-2 py-0.5 text-xs',
            'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
            'hover:bg-blue-200 dark:hover:bg-blue-900/50',
          ]"
          @click="downloadSingle(item)"
        >
          Download
        </button>
        <button
          :class="[
            'text-neutral-400 hover:text-red-500',
            'i-solar:trash-bin-minimalistic-line-duotone text-base',
          ]"
          @click="removeItem(index)"
        />
      </div>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: plain
</route>
