import type { PlayerState } from '../composables/useSidPlayer'

/**
 * The two rules the app's two transport bars must agree on.
 *
 * `PlayerBar` (the full view) and `Dock` (the bar across the shell) are
 * hand-written separately, because the dock runs as its own Vue app outside
 * the route tree and cannot use the components the shell registers globally.
 * They drifted anyway: the dock greyed its buttons out only while loading, so
 * in `failed` it offered an enabled Play button that did nothing. One rule,
 * here.
 */

/**
 * Whether the transport has nothing to act on. `idle` is before anything is
 * loaded and `failed` is after the engine gave up; in both, a Play button is
 * a promise the player cannot keep.
 */
export const isBusyState = (state: PlayerState): boolean =>
  state === 'loading' || state === 'idle' || state === 'failed'

/** How far through the subsong, from 0 to 1; 0 where the length is not known. */
export const progressOf = (position: number, length: number): number =>
  length > 0 ? Math.min(1, position / length) : 0
