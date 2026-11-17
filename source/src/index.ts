import { computed } from 'vue'
import {
  AppWrapperRoute,
  defineWebApplication,
  useClientService,
  useThemeStore,
  type ActionExtension,
  type AppMenuItemExtension,
  type ApplicationInformation,
  type FileAction,
  type ApplicationSetupOptions,
  type Extension
} from '@opencloud-eu/web-pkg'
import { urlJoin } from '@opencloud-eu/web-client'
import type { Router } from 'vue-router'

import Sidplay from './App.vue'
import LibraryView from './library/LibraryView.vue'
import { readConfig } from './config'
import { setAssetBaseUrl, setBuildTag } from './helpers/assetUrl'
import { initSession, isPlayable } from './player/session'
import { mountDock } from './dock/mount'
import { FILE_TYPES } from './sid/detect'

/**
 * The route name MUST equal the app id. The runtime namespaces every other
 * route name (`media` in app `preview` becomes `preview-media`) and the file
 * action is gated on `router.hasRoute(routeName)`; get it wrong and there is
 * no error, the file simply downloads instead of opening.
 */
const appId = 'sidplayer'
const routeName = 'sidplayer'

export default defineWebApplication({
  setup({ applicationConfig }: ApplicationSetupOptions) {
    const config = readConfig(applicationConfig as Record<string, unknown>)
    setAssetBaseUrl(config.assetBaseUrl)
    setBuildTag(config.buildTag)

    // One player for the page, created here because this runs exactly once
    // and inside the shell's app context, where the stores are reachable.
    const clientService = useClientService()
    const themeStore = useThemeStore()
    const session = initSession(config, {
      webdav: clientService.webdav,
      themes: () => themeStore.availableThemes
    })

    const routes = [
      /*
       * The library, reached from the application menu. Declared before the
       * file route although Vue Router ranks a static segment above a
       * parameter anyway, so `/library` cannot be swallowed by the catch-all
       * below. The name is namespaced by the host into `sidplayer-library`.
       */
      {
        path: '/library',
        name: 'library',
        component: LibraryView,
        meta: { authContext: 'user', title: 'SID Library' }
      },
      {
        path: '/:driveAliasAndItem(.*)?',
        name: routeName,
        component: AppWrapperRoute(Sidplay, {
          applicationId: appId
          // No urlForResourceOptions: the session reads the bytes itself over
          // WebDAV, so App.vue declares neither `url` nor `currentContent`.
        }),
        meta: {
          // 'hybrid' so public links open the player too, not just sessions.
          authContext: 'hybrid',
          title: 'SID Player',
          patchCleanPath: true
        }
      }
    ]

    /**
     * Routing is by extension: servers rarely have a mime mapping for SID
     * files. `audio/prs.sid` is the IANA-registered type and is declared so
     * icons and "open with" read correctly.
     *
     * Priority decides what a left-click does. The shell gathers these
     * routed "editor" actions and the primary context actions below, keeps
     * the visible ones and sorts by `hasPriority`; the first wins. With
     * `clickPlaysInPlace` the Play action takes priority and this route is
     * offered under "Open with" and in the context menu as the full view.
     */
    const fileExtensions = FILE_TYPES.map(({ extension, mimeType }) => ({
      extension,
      mimeType,
      routeName,
      label: () => 'Open in SID Player',
      hasPriority: config.registerAsDefault && !config.clickPlaysInPlace
    }))

    const appInfo: ApplicationInformation = {
      name: 'SID Player',
      id: appId,
      icon: 'music-2',
      color: '#7b5ea7',
      defaultExtension: 'sid',
      extensions: fileExtensions
    }

    /**
     * "Play": starts the tune in the dock without leaving the Files list.
     * A primary context action with priority is what makes it the left-click
     * default; without `clickPlaysInPlace` it stays in the menu only.
     */
    const play: FileAction = {
      name: 'sidplayer-play',
      icon: 'play',
      category: 'primary',
      hasPriority: config.registerAsDefault && config.clickPlaysInPlace,
      label: () => 'Play',
      isVisible: (options) => {
        const target = options?.resources?.length === 1 ? options.resources[0] : undefined
        return isPlayable(target) && !!target?.canDownload?.()
      },
      handler: (options) => {
        const target = options?.resources?.[0]
        if (options?.space && target) void session.play(options.space, target)
      },
      class: 'oc-files-actions-sidplayer-play-trigger'
    }
    const playAction: ActionExtension = {
      id: `app.${appId}.play`,
      type: 'action',
      extensionPointIds: ['global.files.context-actions'],
      action: play
    }

    /**
     * The application-menu entry, which is what makes this a standalone app
     * as well as a file viewer. `ApplicationInformation` has no menu field;
     * an `appMenuItem` extension is how the built-in standalone apps do it,
     * and its path is inside the app's own route namespace.
     */
    const menuItem: AppMenuItemExtension = {
      id: `app.${appId}.menuItem`,
      type: 'appMenuItem',
      label: () => 'SID Library',
      color: appInfo.color,
      icon: 'music-2',
      priority: 30,
      path: urlJoin(appId, 'library')
    }

    return {
      appInfo,
      routes,
      extensions: computed<Extension[]>(() => [playAction, menuItem]),
      ready({ globalProperties }) {
        // The router arrives here rather than in setup; the dock needs it to
        // hide itself on the app's own route and to open the full view.
        session.router.value = (globalProperties as { $router?: Router }).$router ?? null
        mountDock(session)
      }
    }
  }
})
