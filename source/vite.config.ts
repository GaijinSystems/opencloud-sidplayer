import { defineConfig } from '@opencloud-eu/extension-sdk'

// The SDK wraps Vite with Module Federation and `base: './'`. `public/` is
// copied to the dist root and the entry chunk lands in `dist/js/`, which is
// why `helpers/assetUrl.ts` walks one level up from `import.meta.url` to find
// the worklet and engine files.
export default defineConfig({
  name: 'sidplayer',
  server: { port: 9211 }
})
