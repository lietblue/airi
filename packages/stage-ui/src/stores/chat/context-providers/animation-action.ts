import type { ContextMessage } from '../../../types/chat'

import { ContextUpdateStrategy } from '@proj-airi/server-sdk'
import { nanoid } from 'nanoid'

import { useAnimationActionsStore } from '../../modules/animation-actions'

const ANIMATION_ACTION_CONTEXT_ID = 'system:animation-action'

/**
 * Creates a context message describing the currently playing animation action.
 * Injected before each chat message so the AI knows what the character is doing.
 */
export function createAnimationActionContext(): ContextMessage {
  const store = useAnimationActionsStore()
  const action = store.currentAction
  const isIdle = store.isCurrentActionIdle

  let text: string
  if (!action || isIdle) {
    text = 'Current animation state: idle'
  }
  else {
    const parts = [`Current animation state: performing "${action.name}"`]
    if (action.description)
      parts.push(`(${action.description})`)
    if (action.durationMs)
      parts.push(`duration: ${(action.durationMs / 1000).toFixed(1)}s`)
    if (store.isCurrentActionLoop)
      parts.push('(looping)')
    text = parts.join(' ')
  }

  return {
    id: nanoid(),
    contextId: ANIMATION_ACTION_CONTEXT_ID,
    strategy: ContextUpdateStrategy.ReplaceSelf,
    text,
    createdAt: Date.now(),
    metadata: {
      source: {
        id: ANIMATION_ACTION_CONTEXT_ID,
        kind: 'plugin',
        plugin: {
          id: 'airi:system:animation-action',
        },
      },
    },
  }
}
