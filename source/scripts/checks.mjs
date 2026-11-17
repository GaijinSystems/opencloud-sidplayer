/**
 * The pass/fail lines the verify scripts and the browser drivers print, and
 * the exit code that follows from them.
 *
 * Each of those scripts used to carry its own copy of this counter. They all
 * printed the same two prefixes and the same last line, which is what anything
 * reading their output - a person, or a shell's `&&` - relies on, so it is
 * said once here.
 *
 * Importing this does nothing: no output, no files, no exit.
 */

let failures = 0

/** Prints one line for one thing checked, and counts it if it failed. */
export const check = (ok, what) => {
  console.log(`${ok ? '  ok ' : ' FAIL'} ${what}`)
  if (!ok) failures++
}

export const failureCount = () => failures

/**
 * The last line, then the exit: 1 if anything failed, 0 otherwise. `hint` is
 * appended to the failure line only, for a script with somewhere to point.
 */
export const report = (hint = '') => {
  console.log(failures ? `\n${failures} check(s) FAILED${hint}` : '\nall checks passed')
  process.exit(failures ? 1 : 0)
}
