<script setup lang="ts">
import { useVisionProcessingStore } from '@proj-airi/stage-ui/stores/modules/vision'
import { Callout, FieldCheckbox } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const visionProcessingStore = useVisionProcessingStore()
const { enabled } = storeToRefs(visionProcessingStore)
</script>

<template>
  <div :class="['flex', 'flex-col', 'gap-6']">
    <FieldCheckbox
      v-model="enabled"
      :label="t('settings.pages.vision.scene.enable')"
      :description="t('settings.pages.vision.scene.enable-description')"
    />
    <Callout
      label="In development, needs your help!"
      theme="orange"
    >
      <div>
        This functionality is still under development. If you have any suggestions or would like to contribute, please reach out to us on our <a underline decoration-dotted href="https://github.com/moeru-ai/airi/issues">GitHub issues page</a>.
        The source code of this page is located at <a underline decoration-dotted href="https://github.com/moeru-ai/airi/tree/main/apps/stage-web/src/pages/settings/scene/index.vue">here</a>.
      </div>
    </Callout>
  </div>
  <div
    v-motion
    text="neutral-200/50 dark:neutral-600/20" pointer-events-none
    fixed top="[calc(100dvh-15rem)]" bottom-0 right--5 z--1
    :initial="{ scale: 0.9, opacity: 0, y: 20 }"
    :enter="{ scale: 1, opacity: 1, y: 0 }"
    :duration="500"
    size-60
    flex items-center justify-center
  >
    <div text="60" i-solar:armchair-2-bold-duotone />
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.scene.title
  subtitleKey: settings.title
  descriptionKey: settings.pages.scene.description
  icon: i-solar:armchair-2-bold-duotone
  settingsEntry: true
  order: 3
  stageTransition:
    name: slide
    pageSpecificAvailable: true
</route>
