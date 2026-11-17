/**
 * The app's own theme preference, applied the way the shell applies its own.
 *
 * The shell does not use a `data-theme` attribute. It writes each design token
 * of the current theme as an inline `--oc-role-<name>` custom property on
 * `:root`, camelCase turned to kebab-case, with `chrome` falling back to
 * `surfaceContainer` when a theme does not name one. Doing exactly that on the
 * app's own root element gives it a theme of its own: custom properties
 * inherit, so every design-system component inside picks it up, and nothing
 * outside is touched, so there is nothing to restore on leaving either.
 */
export interface ThemeLike {
  isDark: boolean
  label?: string
  designTokens?: { roles?: Record<string, string> }
}

export const kebab = (s: string): string => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)

/** The custom properties the shell would set for `theme`, name to value. */
export const themeVars = (theme: ThemeLike): Record<string, string> => {
  const roles = theme.designTokens?.roles ?? {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(roles)) {
    if (typeof value === 'string') out[`--oc-role-${kebab(key)}`] = value
  }
  if (!roles.chrome) {
    if (roles.surfaceContainer) out['--oc-role-chrome'] = roles.surfaceContainer
    if (roles.onSurface) out['--oc-role-on-chrome'] = roles.onSurface
  }
  // These go on the app root, one level below `:root`, where an omitted role
  // would inherit the OTHER theme's value. `background` and `onBackground`
  // decide the page itself, so they are filled from their surface equivalents.
  if (!roles.background && roles.surface) out['--oc-role-background'] = roles.surface
  if (!roles.onBackground && roles.onSurface) out['--oc-role-on-background'] = roles.onSurface
  return out
}

export const pickTheme = <T extends ThemeLike>(themes: readonly T[], mode: 'light' | 'dark'): T | undefined =>
  themes.find((t) => t.isDark === (mode === 'dark'))

/** Whether there is a choice to offer at all. */
export const canChooseTheme = (themes: readonly ThemeLike[]): boolean =>
  themes.some((t) => t.isDark) && themes.some((t) => !t.isDark)

/**
 * Put a theme on one element, taking off whatever the last call left. The
 * names now set are returned, for the caller to hand back next time; the
 * element is shared with the rest of the app and this must never clear a
 * property it did not write. `null` means "follow the shell".
 */
export const applyThemeTo = (
  el: HTMLElement,
  theme: ThemeLike | null,
  previous: readonly string[] = []
): string[] => {
  for (const name of previous) el.style.removeProperty(name)
  if (!theme) return []
  const vars = themeVars(theme)
  for (const [name, value] of Object.entries(vars)) el.style.setProperty(name, value)
  return Object.keys(vars)
}
