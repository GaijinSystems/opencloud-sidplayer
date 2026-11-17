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

const here = new URL('./', document.baseURI)

// What the shell does for every app: its theme on the page, and its icons.
const dark = matchMedia('(prefers-color-scheme: dark)')
let applied: string[] = []
const shellTheme = (): void => {
  applied = applyThemeTo(document.documentElement, pickTheme(themes, dark.matches ? 'dark' : 'light') ?? null, applied)
}
shellTheme()
dark.addEventListener('change', shellTheme)
setIconUrlPrefix(here.href)
setAssetBaseUrl(here.href)

loadDemoSpace()

const config = readConfig({
  // The version the library shows under its name, as the app's own build stamps it.
  version: __APP_VERSION__,
  // The mirror route, for the one thing the library asks of it here - which
  // release is current - answered by a file beside the page, wherever the
  // page is served from.
  hvscMirrorPath: new URL('hvsc-mirror', here).pathname
})
initSession(config, { webdav: demoWebdav as never, themes: () => themes })

createApp(DemoRoot)
  .use(createGettext({ translations: {}, silent: true }))
  .component('OcButton', OcButton)
  .component('OcIcon', OcIcon)
  .component('OcSpinner', OcSpinner)
  .mount('#app')
