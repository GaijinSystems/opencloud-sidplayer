import { md5Hex } from '../sid/md5'
import { assembleMus, musHeader } from '../sid/mus'
import { musLength } from '../sid/musLength'

/**
 * What a Compute's tune's own file says about it, read when the tune is
 * selected. The collection documents none of it anywhere else.
 *
 * Only what the bytes say, so that a stored copy stays true: whether a `.str`
 * sits beside the file is the folder's business, and is asked of the listing
 * each time the details are shown.
 */
export interface MusDetails {
  /** Whether the file itself carries a second SID's three voices, appended. */
  stereo: boolean
  /** The file's credit lines: by convention title, author, then a release line. */
  title?: string
  author?: string
  released?: string
  /** Seconds, worked out from the score; null where it cannot be. */
  length: number | null
  /**
   * Of the whole file, as HVSC keys its tunes. Shown in the detail pane, and
   * what says whether a stored copy of these details still matches the file
   * where the server reports one to compare it with.
   */
  md5: string
}

/** The details with the format the pane shows, once the listing has had its say. */
export type ShownMusDetails = MusDetails & { format: 'MUS' | 'MUS+STR' }

/**
 * Reads the details out of a tune's bytes. Throws where the bytes are not
 * Sidplayer data, as the player would.
 */
export function musDetailsOf(bytes: Uint8Array): MusDetails {
  // The player's own reading of the credits, so the two never disagree.
  const header = musHeader(assembleMus(bytes))
  return {
    stereo: header.format === 'MUS+STR',
    title: header.name.trim() || undefined,
    author: header.author.trim() || undefined,
    released: header.released.trim() || undefined,
    // Nought is a score with no timed notes in it, which the player treats
    // as no length at all; "0:00" would be a claim.
    length: musLength(bytes) || null,
    md5: md5Hex(bytes)
  }
}
