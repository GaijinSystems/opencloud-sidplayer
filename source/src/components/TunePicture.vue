<script setup lang="ts">
import { ref, watchEffect } from 'vue'
import type { Picture } from '../sid/picture'

/**
 * The picture some Sidplayer tunes were passed around with, drawn on a
 * canvas at its own 320x200 and stretched to 4:3, which is the shape a C64
 * put it on a television. `pixelated` keeps the pixels square-edged instead
 * of blurring them into each other.
 *
 * The full view and the library's detail pane each drew it with their own
 * copy of this.
 */
const { picture, maxWidth } = defineProps<{ picture: Picture; maxWidth?: string }>()

const canvas = ref<HTMLCanvasElement | null>(null)
// After the DOM, or the canvas is not there yet to paint on: `putImageData`
// on a canvas Vue has not attached paints nothing.
watchEffect(
  () => {
    canvas.value
      ?.getContext('2d')
      ?.putImageData(new ImageData(picture.pixels, picture.width, picture.height), 0, 0)
  },
  { flush: 'post' }
)
</script>

<template>
  <canvas
    ref="canvas"
    role="img"
    :width="picture.width"
    :height="picture.height"
    :aria-label="`Picture that came with this tune, ${picture.format === 'koala' ? 'multicolour' : 'high resolution'}`"
    :style="{
      display: 'block',
      width: '100%',
      maxWidth,
      aspectRatio: '4 / 3',
      imageRendering: 'pixelated',
      borderRadius: '6px',
      border: '1px solid var(--oc-role-outline-variant)'
    }"
  />
</template>
