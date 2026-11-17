import { isSidFile } from './header'
import { detectMus } from './mus'
import { PICTURE_EXTENSIONS } from './picture'
import { extensionOf } from './names'

export type DetectedFormat = 'psid' | 'rsid' | 'mus' | 'sidmon2' | 'unknown'

export { extensionOf, stripExtension } from './names'

/** The Sidplayer trio. `str` and `wds` are companions and never play alone. */
export const SIDPLAYER_EXTENSIONS = new Set(['mus', 'str', 'wds'])

/**
 * Every kind of file the app opens, and the type each is registered under.
 * The one list: what Files routes to the app and what the Play action
 * accepts are both read from it, so neither can gain an extension the other
 * has not.
 */
export const FILE_TYPES: ReadonlyArray<{ extension: string; mimeType: string }> = [
  { extension: 'sid', mimeType: 'audio/prs.sid' },
  { extension: 'psid', mimeType: 'audio/prs.sid' },
  { extension: 'rsid', mimeType: 'audio/prs.sid' },
  // Compute!'s Sidplayer: the tune, its stereo half, and its words. The
  // player opens the .mus whichever of the three is clicked.
  ...[...SIDPLAYER_EXTENSIONS].map((extension) => ({ extension, mimeType: 'audio/x-c64-sidplayer' }))
]

const SIDMON2_MAGIC = 'SIDMON II - THE MIDI VERSION'

function hasAscii(bytes: Uint8Array, text: string, within: number): boolean {
  const limit = Math.min(bytes.length - text.length, within)
  outer: for (let i = 0; i <= limit; i++) {
    for (let j = 0; j < text.length; j++) {
      if (bytes[i + j] !== text.charCodeAt(j)) continue outer
    }
    return true
  }
  return false
}

/**
 * What the bytes are, from their content rather than their name. The name
 * only breaks ties: a `.str` file is MUS-shaped data too, and the caller
 * decides from the extension which half it is.
 */
export function detectFormat(bytes: Uint8Array): DetectedFormat {
  if (isSidFile(bytes)) return bytes[0] === 0x52 ? 'rsid' : 'psid'
  if (detectMus(bytes) !== null) return 'mus'
  // An Amiga tracker, not a C64 file, but its modules are often named .sid.
  if (hasAscii(bytes, SIDMON2_MAGIC, 512)) return 'sidmon2'
  return 'unknown'
}

/**
 * The message for a file this player cannot open, as specific as the bytes
 * and the name allow. "Not a SID" is true but useless when the user can act
 * on the real reason.
 */
export function unsupportedMessage(bytes: Uint8Array, fileName: string): string {
  const ext = extensionOf(fileName)
  const format = detectFormat(bytes)
  if (format === 'sidmon2') {
    return 'This is an Amiga SidMon II module. Despite the name, that is a different format from C64 SID music, and this player does not emulate an Amiga.'
  }
  if (ext === 'str') {
    return 'This is the stereo half of a Sidplayer tune. Its .mus file with the same name must be in the same folder, and that is the file to open.'
  }
  if (ext === 'wds') {
    return 'This is a Sidplayer words file. The .mus tune with the same name must be in the same folder, and that is the file to open.'
  }
  if (PICTURE_EXTENSIONS.has(ext)) {
    return 'This is a picture that came with a Sidplayer tune. The .mus tune with the same name must be in the same folder, and that is the file to open; the picture is shown beside it.'
  }
  if (ext === 'mus') {
    return 'This is not a Sidplayer MUS file: the voice table or terminators are wrong.'
  }
  if (ext === 'sid') {
    return 'This file is not a PSID or RSID tune. If it came from an Amiga collection it may be a SidMon module, which is a different format with the same extension.'
  }
  return 'This file is not a PSID or RSID tune.'
}
