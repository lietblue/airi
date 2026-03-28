import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'

export const useSettingsGreenScreen = defineStore('settings-green-screen', () => {
  const enabled = useLocalStorageManualReset<boolean>('settings/green-screen/enabled', false)

  function toggle() {
    enabled.value = !enabled.value
  }

  function resetState() {
    enabled.reset()
  }

  return {
    enabled,
    toggle,
    resetState,
  }
})
