/**
 * The SID Library on a static site: the app's own components and player,
 * OpenCloud's own styles and components, and the demo's files standing in
 * for an OpenCloud space.
 */
import { createApp } from 'vue'
import { createGettext } from 'vue3-gettext'
import { OcButton, OcIcon, OcSpinner } from '@opencloud-eu/design-system/components'
import { setIconUrlPrefix } from '@opencloud-eu/design-system/helpers'
import '../vendor/opencloud/shell.css'
import { readConfig } from '@app/config'
import { setAssetBaseUrl } from '@app/helpers/assetUrl'
import { applyThemeTo, pickTheme } from '@app/helpers/theme'
import { initSession } from '@app/player/session'
import { demoWebdav, loadDemoSpace } from './demoSpace'
import themes from './themes.json'
import DemoRoot from './DemoRoot.vue'

declare const __APP_VERSION__: string

const here = new URL('./', document.baseURI).href

/*
 * The mirror route, for the one thing the library asks of it here: which
 * release is current. The answer is a file beside the page; anything else
 * is not, and fails as a mirror that does not have it.
 */
const realFetch = window.fetch.bind(window)
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const path = url.startsWith(location.origin) ? url.slice(location.origin.length) : url
  if (path.startsWith('/hvsc-mirror/')) return realFetch(new URL(path.slice(1), here), init)
  return realFetch(input, init)
}

// What the shell does for every app: its theme on the page, and its icons.
const dark = matchMedia('(prefers-color-scheme: dark)')
const shellTheme = () => applyThemeTo(document.documentElement, pickTheme(themes, dark.matches ? 'dark' : 'light') ?? null)
let applied = shellTheme()
dark.addEventListener('change', () => {
  applied = applyThemeTo(document.documentElement, pickTheme(themes, dark.matches ? 'dark' : 'light') ?? null, applied)
})
setIconUrlPrefix(here)
setAssetBaseUrl(here)

await loadDemoSpace()

// The version the library shows under its name, as the app's own build stamps it.
const config = readConfig({ version: __APP_VERSION__ })
initSession(config, { webdav: demoWebdav as never, themes: () => themes })

createApp(DemoRoot)
  .use(createGettext({ translations: {}, silent: true }))
  .component('OcButton', OcButton)
  .component('OcIcon', OcIcon)
  .component('OcSpinner', OcSpinner)
  .mount('#app')
