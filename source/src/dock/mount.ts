import { createApp, type App } from 'vue'
import Dock from './Dock.vue'
import type { Session } from '../player/session'

const CONTAINER_ID = 'sidplayer-dock-root'

/**
 * Mounts the dock once, as its own Vue app in a container appended to the
 * document body.
 *
 * Why its own app rather than a component in the route tree: the route tree
 * is torn down whenever the user leaves the app's route, and the dock's whole
 * point is to outlive that. The shell offers no extension point at the bottom
 * of the page, so this is the honest alternative. It shares Vue itself with
 * the shell through module federation, so the session's refs are reactive
 * here as everywhere, and it reads the shell's theme through the same
 * `--oc-role-*` custom properties, which inherit from the document root.
 */
export function mountDock(session: Session): App | null {
  if (typeof document === 'undefined') return null
  if (document.getElementById(CONTAINER_ID)) return null
  const container = document.createElement('div')
  container.id = CONTAINER_ID
  document.body.appendChild(container)
  const app = createApp(Dock, { session })
  app.config.errorHandler = (err) => console.error('[sidplayer] dock error', err)
  app.mount(container)
  return app
}
