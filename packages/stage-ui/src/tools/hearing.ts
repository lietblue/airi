import { tool } from '@xsai/tool'
import { z } from 'zod'

import { useHearingStore } from '../stores/modules/hearing'
import { useSettingsAudioDevice } from '../stores/settings/audio-device'

const tools = [
  tool({
    name: 'airi_enable_microphone',
    description: 'Enable the microphone to listen for the user\'s voice response. Call this when you want to hear the user speak next (e.g., after asking a question or finishing your reply). This enables the microphone and activates one-shot auto-send, which will automatically transcribe and send the user\'s first spoken message, then turn off.',
    execute: async ({ autoSend }) => {
      const audioDevice = useSettingsAudioDevice()
      const hearingStore = useHearingStore()

      // Enable the microphone if not already enabled
      if (!audioDevice.enabled) {
        audioDevice.enabled = true
      }

      // Enable one-shot auto-send by default
      if (autoSend !== false) {
        hearingStore.autoSendEnabled = true
        hearingStore.autoSendOnce = true
      }

      return {
        success: true,
        microphoneEnabled: true,
        autoSendOnce: autoSend !== false,
      }
    },
    parameters: z.object({
      autoSend: z.boolean().optional().describe('Whether to enable one-shot auto-send (default: true). When true, the user\'s first transcribed message will be automatically sent, then auto-send disables itself.'),
    }).strict(),
  }),
]

export const hearing = async () => Promise.all(tools)
