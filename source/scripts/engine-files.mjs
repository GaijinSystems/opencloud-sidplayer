/**
 * Which files of public/vendor/sid-engine/ go out with a build: the ones the
 * page fetches by name, the notices that have to travel with them, and
 * whatever engine.json itself names. The app's build keeps exactly these,
 * and so does anything else that serves the engine - the demo site.
 *
 * Importing this does nothing.
 */

/** The names to ship, given engine.json as parsed. */
export const engineFiles = (manifest) => [
  // Fetched by name rather than through the manifest: the worklet, the
  // adapter it imports, and the manifest itself.
  'sid-processor.js',
  'engine.js',
  'engine.json',
  // Obligations and the note that explains the layout. A few kB in total.
  'LICENSE-libsidplayfp.txt',
  'README.txt',
  ...(manifest.files ?? []),
  ...(manifest.optional ?? [])
]
