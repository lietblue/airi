import { tool } from '@xsai/tool'
import { z } from 'zod'

import { useAnimationActionsStore } from '../stores/modules/animation-actions'

const tools = [
  tool({
    name: 'airi_list_actions',
    description: 'List all available animation actions that AIRI can perform. Returns name, description, duration, and id for each enabled action.',
    execute: async () => {
      const store = useAnimationActionsStore()
      return store.actions
        .filter(a => a.enabled)
        .map(a => ({
          id: a.id,
          name: a.name,
          description: a.description,
          durationMs: a.durationMs,
          isBuiltin: a.isBuiltin,
        }))
    },
    parameters: z.object({}).strict(),
  }),

  tool({
    name: 'airi_perform_action',
    description: 'Perform an animation action. Use airi_list_actions first to get the available action IDs. The animation will play once (or loop for idle) and then return to idle automatically.',
    execute: async ({ id }) => {
      const store = useAnimationActionsStore()
      const action = store.actions.find(a => a.id === id)
      if (!action)
        return { success: false, error: `Action "${id}" not found. Use airi_list_actions to see available actions.` }
      if (!action.enabled)
        return { success: false, error: `Action "${id}" is disabled.` }

      store.playAction(id, 'tool')
      return {
        success: true,
        action: {
          id: action.id,
          name: action.name,
          description: action.description,
          durationMs: action.durationMs,
        },
      }
    },
    parameters: z.object({
      id: z.string().describe('The action ID to perform (from airi_list_actions)'),
    }).strict(),
  }),

  tool({
    name: 'airi_get_current_action',
    description: 'Get information about the currently playing animation action.',
    execute: async () => {
      const store = useAnimationActionsStore()
      const action = store.currentAction
      if (!action || store.isCurrentActionIdle)
        return { state: 'idle', action: action ? { id: action.id, name: action.name } : null }

      return {
        state: 'performing',
        action: {
          id: action.id,
          name: action.name,
          description: action.description,
          durationMs: action.durationMs,
        },
      }
    },
    parameters: z.object({}).strict(),
  }),
]

export const animationActions = async () => Promise.all(tools)
