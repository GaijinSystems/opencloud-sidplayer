/**
 * Text handling for the collection's own documents.
 *
 * Two things bite here. HVSC's documents are ISO-8859-1, not UTF-8: decoding
 * `Musicians.txt` as UTF-8 turns "Orbán" into a replacement character and the
 * name stops matching anything. And the collection spells non-ASCII names the
 * way a 1990s DOS machine would - `Huelsbeck_Chris`, `Soerensen`, `Aake` -
 * while a person searching types the real spelling, so folding accents is not
 * enough on its own.
 */

/** HVSC's documents are Latin-1. Browsers can always decode it. */
export const decodeLatin1 = (bytes: ArrayBuffer | Uint8Array): string =>
  new TextDecoder('iso-8859-1').decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))

/**
 * Characters that HVSC transliterates rather than strips, mapped to what it
 * writes. Everything else goes through Unicode decomposition, which turns
 * "é" into "e" but leaves these alone (ß has no decomposition, ø and đ
 * decompose to themselves).
 */
const TRANSLITERATE: Record<string, string> = {
  ä: 'ae',
  ö: 'oe',
  ü: 'ue',
  ß: 'ss',
  ø: 'oe',
  æ: 'ae',
  å: 'aa',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ł: 'l',
  ñ: 'n'
}

/**
 * The form both stored text and queries are reduced to: lower case, accents
 * folded, German and Nordic letters spelled out as the collection spells
 * them, and anything that is not a letter or digit turned into a space. The
 * underscores in HVSC file names become word breaks, which is what makes
 * "monty run" find `Monty_on_the_Run.sid`.
 */
export function normalise(input: string): string {
  // Nearly every name in the collection is plain ASCII, which needs none of
  // the per-character work below: 61,157 rows times six fields of it, each
  // time the index is built.
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(input)) {
    return input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
  }
  let out = ''
  for (const ch of input.toLowerCase()) {
    out += TRANSLITERATE[ch] ?? ch
  }
  return out
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** `normalise`, split into tokens. */
export const tokenise = (input: string): string[] => {
  const n = normalise(input)
  return n ? n.split(' ') : []
}

/**
 * A second spelling for a token that carries a transliterated vowel, so that
 * "hulsbeck" finds `Huelsbeck` as well as "hülsbeck" does. Only the vowel
 * digraphs are collapsed, and only when the result still differs, so ordinary
 * words with "ue" in them ("blue", "queen") cost one harmless extra token.
 */
export const collapsedVariant = (token: string): string | null => {
  const collapsed = token.replace(/([aou])e/g, '$1').replace(/aa/g, 'a')
  return collapsed !== token && collapsed.length > 2 ? collapsed : null
}

/** Display form of an HVSC file name: `Monty_on_the_Run.sid` -> `Monty on the Run`. */
export const titleFromFileName = (name: string): string =>
  name
    .replace(/\.[^.]*$/, '')
    .replace(/_/g, ' ')
    .trim()
