/** The web client's types are only ever imported as types; this is all that is left at run time. */
export const urlJoin = (...parts: string[]): string => parts.join('/').replace(/(?<!:)\/{2,}/g, '/')
