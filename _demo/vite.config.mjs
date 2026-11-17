import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

const here = fileURLToPath(new URL('.', import.meta.url))
const app = process.env.APP_SOURCE
if (!app) throw new Error('set APP_SOURCE to the app source/ folder')

/** Jekyll leaves out names that start with `_` or `.`, so none may. */
const plain = (name) => name.replace(/^[_.]+/, '')

export default defineConfig({
  root: here,
  base: './',
  publicDir: resolve(here, 'generated'),
  plugins: [vue()],
  define: {
    __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync(resolve(app, 'package.json'), 'utf8')).version)
  },
  resolve: {
    alias: {
      '@app': resolve(app, 'src'),
      '@opencloud-eu/web-pkg': resolve(here, 'src/shims/web-pkg.ts'),
      '@opencloud-eu/web-client': resolve(here, 'src/shims/web-client.ts')
    },
    dedupe: ['vue']
  },
  build: {
    outDir: process.env.OUT ?? resolve(here, '../site'),
    emptyOutDir: false,
    target: 'es2022',
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        entryFileNames: (c) => `js/${plain(c.name)}-[hash].js`,
        chunkFileNames: (c) => `js/${plain(c.name)}-[hash].js`,
        assetFileNames: (a) => `assets/${plain(a.names?.[0]?.replace(/\.[^.]+$/, '') ?? 'asset')}-[hash][extname]`
      }
    }
  }
})
