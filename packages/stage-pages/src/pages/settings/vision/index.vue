<script setup lang="ts">
import { IconItem, RippleGrid } from '@proj-airi/stage-ui/components'
import { useRippleGridState } from '@proj-airi/stage-ui/composables/use-ripple-grid-state'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const { lastClickedIndex, setLastClickedIndex } = useRippleGridState()

const visionSections = [
  {
    title: () => t('settings.pages.vision.presence.title'),
    description: () => t('settings.pages.vision.presence.description'),
    icon: 'i-solar:user-scan-rounded-bold-duotone',
    to: '/settings/vision/presence',
  },
  {
    title: () => t('settings.pages.vision.hand.title'),
    description: () => t('settings.pages.vision.hand.description'),
    icon: 'i-solar:hand-shake-bold-duotone',
    to: '/settings/vision/hand',
  },
  {
    title: () => t('settings.pages.vision.scene.title'),
    description: () => t('settings.pages.vision.scene.description'),
    icon: 'i-solar:camera-bold-duotone',
    to: '/settings/modules/vision',
  },
  {
    title: () => t('settings.pages.vision.debug.title'),
    description: () => t('settings.pages.vision.debug.description'),
    icon: 'i-solar:bug-bold-duotone',
    to: '/settings/vision/debug',
  },
]
</script>

<template>
  <div flex="~ col gap-4" font-normal>
    <div pb-12>
      <RippleGrid
        :items="visionSections"
        :get-key="item => item.to"
        :columns="1"
        :origin-index="lastClickedIndex"
        @item-click="({ globalIndex }) => setLastClickedIndex(globalIndex)"
      >
        <template #item="{ item }">
          <IconItem
            :title="item.title()"
            :description="item.description()"
            :icon="item.icon"
            :to="item.to"
          />
        </template>
      </RippleGrid>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.vision.title
  subtitleKey: settings.title
  descriptionKey: settings.pages.vision.description
  icon: i-solar:eye-bold-duotone
  settingsEntry: true
  order: 3
  stageTransition:
    name: slide
    pageSpecificAvailable: true
</route>
