<script setup lang="ts">
import { useAnimationActionsStore } from '@proj-airi/stage-ui/stores/modules/animation-actions'
import { useHandVisionStore } from '@proj-airi/stage-ui/stores/modules/hand-vision'
import { FieldCheckbox, FieldRange } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const store = useHandVisionStore()
const {
  gazeEnabled,
  requireArmRaised,
  gazeAmplitude,
  gazeInvertX,
  gazeInvertY,
  headTrackingEnabled,
  headTrackingStrength,
  messageEnabled,
  messagePool,
  messageActionTag,
  messageAiRegenEnabled,
  cameraStatus,
  cameraError,
  handDetected,
} = storeToRefs(store)

const animActionsStore = useAnimationActionsStore()
const { allTags } = storeToRefs(animActionsStore)

const newMessage = ref('')

function addMessage() {
  const msg = newMessage.value.trim()
  if (!msg)
    return
  messagePool.value = [...messagePool.value, msg]
  newMessage.value = ''
}

function removeMessage(idx: number) {
  messagePool.value = messagePool.value.filter((_, i) => i !== idx)
}
</script>

<template>
  <div :class="['flex', 'flex-col', 'gap-6']">
    <!-- Camera status badge (visible when feature is enabled) -->
    <div
      v-if="gazeEnabled || messageEnabled || headTrackingEnabled"
      :class="['flex', 'flex-col', 'gap-2', 'rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']"
    >
      <div :class="['flex', 'items-center', 'gap-3']">
        <div
          :class="[
            'h-3', 'w-3', 'rounded-full', 'shrink-0',
            cameraStatus === 'running' ? 'bg-emerald-400' : '',
            cameraStatus === 'starting' ? 'bg-amber-400 animate-pulse' : '',
            cameraStatus === 'error' ? 'bg-red-400' : '',
            cameraStatus === 'idle' ? 'bg-neutral-400' : '',
          ]"
        />
        <span :class="['text-sm', 'font-medium']">
          Camera:
          <span
            :class="[
              cameraStatus === 'running' ? 'text-emerald-500' : '',
              cameraStatus === 'starting' ? 'text-amber-500' : '',
              cameraStatus === 'error' ? 'text-red-500' : '',
              cameraStatus === 'idle' ? 'text-neutral-400' : '',
            ]"
          >{{ cameraStatus }}</span>
        </span>
        <span v-if="cameraStatus === 'error'" :class="['ml-2', 'text-xs', 'text-red-400', 'truncate']">
          {{ cameraError }}
        </span>
      </div>
      <div v-if="cameraStatus === 'running'" :class="['flex', 'items-center', 'gap-3']">
        <div
          :class="[
            'h-3', 'w-3', 'rounded-full', 'shrink-0',
            handDetected ? 'bg-blue-400' : 'bg-neutral-400',
          ]"
        />
        <span :class="['text-sm']">
          Hand: <span :class="['font-medium']">{{ handDetected ? 'raised' : 'not detected' }}</span>
        </span>
      </div>
    </div>

    <!-- Gaze Tracking -->
    <div :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
      <div :class="['flex', 'flex-col', 'gap-4']">
        <div>
          <h2 :class="['text-lg', 'md:text-2xl']">
            {{ t('settings.pages.vision.hand.gaze-enable') }}
          </h2>
        </div>
        <FieldCheckbox
          v-model="gazeEnabled"
          :label="t('settings.pages.vision.hand.gaze-enable')"
          :description="t('settings.pages.vision.hand.gaze-enable-description')"
        />

        <template v-if="gazeEnabled">
          <FieldRange
            v-model="gazeAmplitude"
            :label="t('settings.pages.vision.hand.gaze-amplitude')"
            :description="t('settings.pages.vision.hand.gaze-amplitude-description')"
            :min="0.2"
            :max="3.0"
            :step="0.1"
            :format-value="v => `${v.toFixed(1)}×`"
          />
        </template>
      </div>
    </div>

    <!-- Head Tracking -->
    <div :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
      <div :class="['flex', 'flex-col', 'gap-4']">
        <div>
          <h2 :class="['text-lg', 'md:text-2xl']">
            {{ t('settings.pages.vision.hand.head-tracking-enable') }}
          </h2>
        </div>
        <FieldCheckbox
          v-model="headTrackingEnabled"
          :label="t('settings.pages.vision.hand.head-tracking-enable')"
          :description="t('settings.pages.vision.hand.head-tracking-enable-description')"
        />
        <template v-if="headTrackingEnabled">
          <FieldRange
            v-model="headTrackingStrength"
            :label="t('settings.pages.vision.hand.head-tracking-strength')"
            :description="t('settings.pages.vision.hand.head-tracking-strength-description')"
            :min="0.05"
            :max="1.0"
            :step="0.05"
            :format-value="v => `${(v * 100).toFixed(0)}%`"
          />
        </template>
      </div>
    </div>

    <!-- Shared options (apply to both gaze and head tracking) -->
    <div v-if="gazeEnabled || headTrackingEnabled" :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
      <div :class="['flex', 'flex-col', 'gap-4']">
        <FieldCheckbox
          v-model="requireArmRaised"
          :label="t('settings.pages.vision.hand.require-arm-raised')"
          :description="t('settings.pages.vision.hand.require-arm-raised-description')"
        />
        <div :class="['flex', 'flex-wrap', 'gap-4']">
          <FieldCheckbox
            v-model="gazeInvertX"
            :label="t('settings.pages.vision.hand.gaze-invert-x')"
            :description="t('settings.pages.vision.hand.gaze-invert-x-description')"
          />
          <FieldCheckbox
            v-model="gazeInvertY"
            :label="t('settings.pages.vision.hand.gaze-invert-y')"
            :description="t('settings.pages.vision.hand.gaze-invert-y-description')"
          />
        </div>
      </div>
    </div>

    <!-- Hand-raise message -->
    <div :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
      <div :class="['flex', 'flex-col', 'gap-4']">
        <div>
          <h2 :class="['text-lg', 'md:text-2xl']">
            {{ t('settings.pages.vision.hand.message-enable') }}
          </h2>
        </div>
        <FieldCheckbox
          v-model="messageEnabled"
          :label="t('settings.pages.vision.hand.message-enable')"
          :description="t('settings.pages.vision.hand.message-enable-description')"
        />

        <template v-if="messageEnabled">
          <!-- Message pool -->
          <div :class="['flex', 'flex-col', 'gap-2']">
            <div :class="['text-sm', 'font-medium']">
              {{ t('settings.pages.vision.hand.messages') }}
            </div>
            <div :class="['text-xs', 'text-neutral-400']">
              {{ t('settings.pages.vision.hand.messages-description') }}
            </div>
            <ul :class="['flex', 'flex-col', 'gap-1']">
              <li
                v-for="(msg, idx) in messagePool"
                :key="idx"
                :class="['flex', 'items-center', 'gap-2', 'rounded', 'bg-white', 'px-3', 'py-2', 'dark:bg-neutral-900']"
              >
                <span :class="['flex-1', 'text-sm']">{{ msg }}</span>
                <button
                  type="button"
                  :class="['text-neutral-400', 'hover:text-red-400', 'transition-colors']"
                  @click="removeMessage(idx)"
                >
                  <div :class="['i-solar:trash-bin-trash-bold-duotone', 'text-base']" />
                </button>
              </li>
            </ul>
            <div :class="['flex', 'gap-2']">
              <input
                v-model="newMessage"
                type="text"
                :placeholder="t('settings.pages.vision.hand.messages-placeholder')"
                :class="[
                  'flex-1', 'rounded', 'border', 'border-neutral-300', 'bg-white', 'px-3', 'py-2', 'text-sm',
                  'dark:border-neutral-700', 'dark:bg-neutral-900',
                ]"
                @keydown.enter="addMessage"
              >
              <button
                type="button"
                :class="[
                  'rounded', 'bg-primary-500', 'px-3', 'py-2', 'text-sm', 'text-white',
                  'hover:bg-primary-600', 'transition-colors',
                ]"
                @click="addMessage"
              >
                {{ t('settings.pages.vision.hand.messages-add') }}
              </button>
            </div>
          </div>

          <!-- Action tag -->
          <div :class="['flex', 'flex-col', 'gap-1']">
            <div :class="['text-sm', 'font-medium']">
              {{ t('settings.pages.vision.hand.action-tag') }}
            </div>
            <div :class="['text-xs', 'text-neutral-400']">
              {{ t('settings.pages.vision.hand.action-tag-description') }}
            </div>
            <select
              v-model="messageActionTag"
              :class="[
                'rounded', 'border', 'border-neutral-300', 'bg-white', 'px-3', 'py-2', 'text-sm',
                'dark:border-neutral-700', 'dark:bg-neutral-900',
              ]"
            >
              <option value="">
                — None —
              </option>
              <option v-for="tag in allTags" :key="tag" :value="tag">
                {{ tag }}
              </option>
            </select>
          </div>

          <FieldCheckbox
            v-model="messageAiRegenEnabled"
            :label="t('settings.pages.vision.hand.ai-regen')"
            :description="t('settings.pages.vision.hand.ai-regen-description')"
          />
        </template>
      </div>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.vision.hand.title
  subtitleKey: settings.pages.vision.title
  stageTransition:
    name: slide
</route>
