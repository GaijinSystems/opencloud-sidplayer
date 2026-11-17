/**
 * The handful of style objects the library's panes share.
 *
 * Small on purpose. The library is styled with inline objects rather than a
 * stylesheet, because it renders inside the OpenCloud shell and every rule
 * that escapes its own root is a rule that can collide with the host's - the
 * one place this app reaches outside itself is a single named stylesheet in
 * `LibraryView`, and that is deliberate and commented.
 *
 * What lives here is only what was already written out five times: the small
 * uppercase heading over a section, and the monospace run used for paths and
 * hashes. Everything a single pane uses stays in that pane, where it can be
 * read beside the markup it applies to.
 */

/** The small uppercase heading over a section. */
const SECTION_LABEL = {
  fontSize: '10px',
  fontWeight: 600,
  letterSpacing: '0.08em',
  textTransform: 'uppercase' as const,
  color: 'var(--oc-role-on-surface-variant)'
}

/**
 * A section heading, optionally with the spacing the pane wants under or
 * around it. `DetailPane` sets it apart with a margin, `TreePane` with
 * padding, because one is a flex column with a gap and the other is not.
 */
export const sectionLabel = (extra: Record<string, string> = {}) => ({ ...SECTION_LABEL, ...extra })

/**
 * A column heading in the tune table. Slightly tighter than a section
 * heading, because it sits in a 30px row beside numbers rather than over a
 * block of prose.
 */
export const columnHead = { ...SECTION_LABEL, letterSpacing: '0.07em' }

/** Paths, hashes and anything else that should not be read as prose. */
export const mono = (fontSize: string, breakAll = false) => ({
  fontFamily: 'monospace',
  fontSize,
  ...(breakAll ? { wordBreak: 'break-all' as const } : {})
})
