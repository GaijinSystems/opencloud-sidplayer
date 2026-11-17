import type { Resource, SpaceResource } from '@opencloud-eu/web-client'
import { findCompanions } from './companions'
import { detectFormat, extensionOf, SIDPLAYER_EXTENSIONS, stripExtension, unsupportedMessage } from './detect'
import { parseSidHeader } from './header'
import { assembleMus, musHeader } from './mus'
import { musLength } from './musLength'
import { decodePicture, PICTURE_EXTENSIONS, type Picture } from './picture'
import { readResourceBytes, type WebDav } from './source'
import { SidPlayerError, type SidHeader } from './types'
import { parseWords } from './words'

/** Everything the player and the UI need for one opened file. */
export interface OpenedTune {
  /** What the engine gets: the SID file, or MUS data with any STR appended. */
  bytes: Uint8Array
  header: SidHeader
  /** Lines from a Sidplayer .wds file, when one was found. */
  words: string[]
  /** The picture that came with the tune, when one was found and decoded. */
  picture: Picture | null
  /**
   * Playing time worked out from a Sidplayer score, in seconds, for tunes
   * whose length is nowhere else. Null for PSID and RSID, which have
   * `Songlengths.md5` for this.
   */
  scoreLength: number | null
  /** The file the bytes came from: the clicked file, or the .mus behind a .str or .wds. */
  source: Resource
}

export interface OpenTuneOptions {
  space: SpaceResource
  resource: Resource
  webdav: WebDav
  maxBytes: number
}

/**
 * Turns the clicked file into something playable.
 *
 * PSID and RSID need only themselves. Compute!'s Sidplayer files come as a
 * family sharing a base name: `.mus` (the tune), `.str` (three more voices
 * for a second SID) and `.wds` (words). Clicking any of them opens the tune,
 * with the stereo part appended for the engine and the words kept for
 * display. A picture may be there too, if the collection's separate add-on
 * has been merged into the music's folders. The folder is listed once to
 * find all of them.
 */
export async function openTune({ space, resource, webdav, maxBytes }: OpenTuneOptions): Promise<OpenedTune> {
  const fileName = resource.name ?? ''
  const ext = extensionOf(fileName)
  const read = (r: Resource) => readResourceBytes(webdav, space, r, maxBytes)
  const bytes = await read(resource)
  const format = detectFormat(bytes)

  if (format === 'psid' || format === 'rsid') {
    return {
      bytes,
      header: parseSidHeader(bytes),
      words: [],
      picture: null,
      scoreLength: null,
      source: resource
    }
  }

  if (format === 'mus' || SIDPLAYER_EXTENSIONS.has(ext) || PICTURE_EXTENSIONS.has(ext)) {
    const siblings = await findCompanions(webdav, space, resource)

    // Which role does the clicked file play? Its extension decides, since a
    // .str is MUS-shaped data too. A .mus named file that is not MUS data is
    // reported as such rather than guessed around.
    let mus: Uint8Array | null = null
    let str: Uint8Array | null = null
    let wds: Uint8Array | null = null
    let picture: Uint8Array | null = null
    let source: Resource = resource
    if (ext === 'str') str = bytes
    else if (ext === 'wds') wds = bytes
    else if (PICTURE_EXTENSIONS.has(ext)) picture = bytes
    else mus = bytes

    if (!mus) {
      if (!siblings.mus) {
        throw new SidPlayerError('unsupported-format', unsupportedMessage(bytes, fileName))
      }
      source = siblings.mus
    }

    /*
     * Everything still to read, at once. Each of these is a WebDAV round
     * trip, and one after another they add up to three of them between the
     * click and the first note for a tune that has a stereo part, words and
     * a picture. A companion that cannot be read is dropped rather than
     * failing the open: they are extras, and the tune plays without them.
     */
    // Promise.all takes plain values beside promises, so bytes in hand go in as they are.
    const optional = (r?: Resource) => (r ? read(r).catch(() => null) : null)
    const [musBytes, strBytes, wdsBytes, pictureBytes] = await Promise.all([
      mus ?? read(source),
      str ?? optional(siblings.str),
      wds ?? optional(siblings.wds),
      picture ?? optional(siblings.picture)
    ])

    const tune = assembleMus(musBytes, strBytes)
    const header = musHeader(tune)
    if (!header.name) header.name = stripExtension(source.name ?? fileName)
    return {
      bytes: tune.bytes,
      header,
      words: wdsBytes ? parseWords(wdsBytes) : [],
      picture: pictureBytes ? decodePicture(pictureBytes) : null,
      // From the .mus alone: a .str carries the same score for three more
      // voices and cannot make the tune longer than its own three do.
      scoreLength: musLength(musBytes),
      source
    }
  }

  throw new SidPlayerError('unsupported-format', unsupportedMessage(bytes, fileName))
}
