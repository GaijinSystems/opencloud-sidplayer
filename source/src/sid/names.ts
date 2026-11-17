/** A file name's extension, lower case, without the dot; empty where it has none. */
export const extensionOf = (fileName: string): string => fileName.match(/\.([^.]+)$/)?.[1]?.toLowerCase() ?? ''

/** The name without its extension: `Commando.sid` -> `Commando`. */
export const stripExtension = (fileName: string): string => fileName.replace(/\.[^.]+$/, '')
