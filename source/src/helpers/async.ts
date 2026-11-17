export class TimeoutError extends Error {
  constructor(
    public readonly ms: number,
    label: string
  ) {
    super(`${label} did not respond within ${ms}ms`)
    this.name = 'TimeoutError'
  }
}

/**
 * Rejects if a promise has not settled in time.
 *
 * A dead worklet or worker does not reject: if its runtime aborts mid-call
 * the promise simply never settles, and the UI sits on a spinner forever with
 * nothing in the console but the worklet's own message. That is exactly what
 * a CSP without `'wasm-unsafe-eval'` produces for a WebAssembly engine. Every
 * round trip to the audio thread therefore carries a budget.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(ms, label)), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

/**
 * Runs `concurrency` copies of a worker - each taking jobs from whatever
 * queue it closes over until there are none - and settles when all have.
 */
export function runWorkers(concurrency: number, worker: () => Promise<void>): Promise<void> {
  return Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker)).then(() => undefined)
}

/**
 * Calls `fn` at most once per `ms`, with the latest arguments, and once more
 * at the end of a burst so the last value is never lost. For progress that
 * arrives once per file: thousands of reactive writes a minute, each a
 * re-render, where a few a second say the same.
 */
export function throttle<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number
): ((...args: A) => void) & { flush(): void } {
  let last = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: A | null = null
  const run = (): void => {
    timer = null
    if (!pending) return
    const args = pending
    pending = null
    last = Date.now()
    fn(...args)
  }
  const call = (...args: A): void => {
    pending = args
    if (timer) return
    const wait = ms - (Date.now() - last)
    if (wait <= 0) run()
    else timer = setTimeout(run, wait)
  }
  return Object.assign(call, {
    flush(): void {
      if (timer) clearTimeout(timer)
      run()
    }
  })
}
