<template>
  <div
    :style="{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '16px',
      width: '100%',
      height: '100%',
      padding: '32px',
      textAlign: 'center'
    }"
  >
    <oc-icon :name="icon" size-class="size-12" :color="iconColor" />
    <div>
      <p :style="{ fontSize: '18px', fontWeight: 500, margin: 0 }" v-text="headline" />
      <p :style="{ marginTop: '4px', maxWidth: '60ch', fontSize: '14px', opacity: 0.8 }" v-text="detail" />
    </div>

    <div
      :style="{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: '8px' }"
    >
      <!--
        A download button on every failure path. Whatever went wrong in the
        browser, the file itself is still there and a desktop player will
        almost certainly open it.
      -->
      <oc-button v-if="downloadUrl" type="a" appearance="filled" :href="downloadUrl" :download="fileName">
        <oc-icon name="download" fill-type="line" />
        Download file
      </oc-button>
      <oc-button v-if="retryable" appearance="outline" @click="$emit('retry')">
        <oc-icon name="refresh" fill-type="line" />
        Try again
      </oc-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { SidPlayerError } from '../sid/types'

const { error } = defineProps<{
  error: SidPlayerError
  fileName: string
  downloadUrl?: string | null
}>()

defineEmits<{ (e: 'retry'): void }>()

/** Only transient failures are worth offering a retry for. */
const retryable = computed(() => ['network', 'backend-unavailable', 'engine'].includes(error.code))

const icon = computed(() => {
  switch (error.code) {
    case 'too-large':
      return 'scales-3'
    case 'network':
      return 'cloud-off'
    case 'backend-unavailable':
    case 'engine':
      return 'cpu'
    default:
      return 'file-damage'
  }
})

const iconColor = computed(() =>
  error.code === 'network' ? 'var(--oc-role-on-surface-variant)' : 'var(--oc-role-error)'
)

const headline = computed(() => {
  switch (error.code) {
    case 'unsupported-format':
      return 'This is not a SID tune'
    case 'too-large':
      return 'This file is too large to be a SID tune'
    case 'network':
      return 'The file could not be fetched'
    case 'backend-unavailable':
      return 'The SID engine could not start'
    case 'engine':
      return 'The tune could not be played'
    default:
      return 'This file could not be opened'
  }
})

const detail = computed(() => {
  if (error.code === 'backend-unavailable') {
    // Names the likely causes. "Ask your administrator" without the specifics
    // just moves the guesswork one person along.
    return `${error.message} If the engine is a WebAssembly build, the server's content security policy must allow 'wasm-unsafe-eval' in script-src.`
  }
  return error.message
})
</script>
