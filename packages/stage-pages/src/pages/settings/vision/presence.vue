<script setup lang="ts">
import { useAnimationActionsStore } from '@proj-airi/stage-ui/stores/modules/animation-actions'
import { usePresenceStore } from '@proj-airi/stage-ui/stores/modules/presence'
import { FieldCheckbox, FieldRange } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const presenceStore = usePresenceStore()
const {
  enabled,
  idleTimeoutMs,
  welcomeEnabled,
  welcomeMessages,
  welcomeActionTag,
  welcomeAiRegenEnabled,
  cameraStatus,
  cameraError,
  state,
  lastSeenAt,
} = storeToRefs(presenceStore)

const animActionsStore = useAnimationActionsStore()
const { allTags } = storeToRefs(animActionsStore)

const newMessage = ref('')

function addMessage() {
  const msg = newMessage.value.trim()
  if (!msg)
    return
  welcomeMessages.value = [...welcomeMessages.value, msg]
  newMessage.value = ''
}

function removeMessage(idx: number) {
  welcomeMessages.value = welcomeMessages.value.filter((_, i) => i !== idx)
}

const idleTimeoutMinutes = computed({
  get: () => idleTimeoutMs.value / 60000,
  set: (v: number) => { idleTimeoutMs.value = v * 60000 },
})

const lastSeenFormatted = computed(() => {
  if (!lastSeenAt.value)
    return 'Never'
  const diff = Math.floor((Date.now() - lastSeenAt.value) / 1000)
  if (diff < 60)
    return `${diff}s ago`
  return `${Math.floor(diff / 60)}m ago`
})
</script>

<template>
  <div :class="['flex', 'flex-col', 'gap-6']">
    <!-- Camera + presence state badges -->
    <div :class="['flex', 'flex-col', 'gap-2', 'rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
      <!-- Camera status row -->
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
      <!-- Presence state row (only shown when camera is running) -->
      <div v-if="cameraStatus === 'running'" :class="['flex', 'items-center', 'gap-3']">
        <div
          :class="[
            'h-3', 'w-3', 'rounded-full', 'shrink-0',
            state === 'active' ? 'bg-emerald-400' : 'bg-neutral-400',
          ]"
        />
        <span :class="['text-sm', 'font-medium']">
          Presence: <span :class="['capitalize']">{{ state }}</span>
        </span>
        <span v-if="lastSeenAt" :class="['ml-auto', 'text-sm', 'text-neutral-400']">
          Last seen: {{ lastSeenFormatted }}
        </span>
      </div>
    </div>

    <!-- Enable -->
    <div :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
      <div :class="['flex', 'flex-col', 'gap-4']">
        <div>
          <h2 :class="['text-lg', 'md:text-2xl']">
            {{ t('settings.pages.vision.presence.title') }}
          </h2>
        </div>
        <FieldCheckbox
          v-model="enabled"
          :label="t('settings.pages.vision.presence.enable')"
          :description="t('settings.pages.vision.presence.enable-description')"
        />
        <FieldRange
          v-if="enabled"
          v-model="idleTimeoutMinutes"
          :label="t('settings.pages.vision.presence.idle-timeout')"
          :description="t('settings.pages.vision.presence.idle-timeout-description')"
          :min="1"
          :max="30"
          :step="1"
          :format-value="v => `${v}m`"
        />
      </div>
    </div>

    <!-- Welcome -->
    <div :class="['rounded-xl', 'bg-neutral-50', 'p-4', 'dark:bg-[rgba(0,0,0,0.3)]']">
      <div :class="['flex', 'flex-col', 'gap-4']">
        <div>
          <h2 :class="['text-lg', 'md:text-2xl']">
            {{ t('settings.pages.vision.presence.welcome.title') }}
          </h2>
        </div>
        <FieldCheckbox
          v-model="welcomeEnabled"
          :label="t('settings.pages.vision.presence.welcome.enable')"
          :description="t('settings.pages.vision.presence.welcome.enable-description')"
        />

        <template v-if="welcomeEnabled">
          <!-- Message pool -->
          <div :class="['flex', 'flex-col', 'gap-2']">
            <div :class="['text-sm', 'font-medium']">
              {{ t('settings.pages.vision.presence.welcome.messages') }}
            </div>
            <div :class="['text-xs', 'text-neutral-400']">
              {{ t('settings.pages.vision.presence.welcome.messages-description') }}
            </div>
            <ul :class="['flex', 'flex-col', 'gap-1']">
              <li
                v-for="(msg, idx) in welcomeMessages"
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
                :placeholder="t('settings.pages.vision.presence.welcome.messages-placeholder')"
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
                {{ t('settings.pages.vision.presence.welcome.messages-add') }}
              </button>
            </div>
          </div>

          <!-- Action tag -->
          <div :class="['flex', 'flex-col', 'gap-1']">
            <div :class="['text-sm', 'font-medium']">
              {{ t('settings.pages.vision.presence.welcome.action-tag') }}
            </div>
            <div :class="['text-xs', 'text-neutral-400']">
              {{ t('settings.pages.vision.presence.welcome.action-tag-description') }}
            </div>
            <select
              v-model="welcomeActionTag"
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
            v-model="welcomeAiRegenEnabled"
            :label="t('settings.pages.vision.presence.welcome.ai-regen')"
            :description="t('settings.pages.vision.presence.welcome.ai-regen-description')"
          />
        </template>
      </div>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.vision.presence.title
  subtitleKey: settings.pages.vision.title
  stageTransition:
    name: slide
</route>
