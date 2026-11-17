type ScopeMode = 'analysed' | 'idle'

const BINS = 48
const EDGE = 2
const MID = (BINS - 1) / 2
/** Buckets per side: the display is mirrored around the centre. */
const HALF = Math.ceil(BINS / 2)

/** Which frequency bucket a bar shows: low in the middle, rising outwards. */
const bucketOf = (i: number): number => Math.floor(Math.abs(i - MID))

/**
 * Log-spaced bucket boundaries over `n` FFT bins: linear bins put almost
 * everything in the first eighth, which reads as broken rather than as detail.
 */
const bucketBounds = (n: number): Array<[number, number]> =>
  Array.from({ length: HALF }, (_, b) => {
    const lo = Math.floor(Math.pow(n, b / HALF))
    const hi = Math.min(n, Math.max(lo + 1, Math.floor(Math.pow(n, (b + 1) / HALF))))
    return [lo, hi]
  })

/**
 * A canvas spectrum fed by an AnalyserNode the player owns.
 *
 * Unlike a streamed radio station, SID audio is synthesised locally, so there
 * is no CORS question and the display is always measured, never indicative.
 * Two states only: `analysed` while playing, `idle` (a flat line) otherwise.
 *
 * Rendering is a canvas, not 48 reactive DOM nodes: this runs at 60 Hz for as
 * long as anything plays and should cost nothing measurable.
 */
export const useSpectrum = () => {
  let mode: ScopeMode = 'idle'

  let analyser: AnalyserNode | null = null
  let data: Uint8Array<ArrayBuffer> | null = null
  let bounds: Array<[number, number]> = []
  let canvas: HTMLCanvasElement | null = null
  let frame = 0
  const levels = new Float32Array(BINS).fill(0.03)
  const bucket = new Float32Array(HALF)

  /** Colours and gradient are read once per size/theme, not once per frame. */
  let paint: { h: number; grad: CanvasGradient } | null = null
  const repaint = () => {
    paint = null
    /*
     * While idle there is no rAF loop to pick the new colours up, so the flat
     * line would keep the old theme's gradient until something played again.
     * One draw costs 48 fillRect calls.
     */
    if (mode === 'idle') draw()
  }
  let themeWatch: MutationObserver | null = null

  const reduced = () =>
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

  /*
   * The context and the canvas's size, kept rather than asked for on every
   * frame: reading clientWidth sixty times a second is a layout query each
   * time. The size comes from a ResizeObserver where there is one.
   */
  let context: CanvasRenderingContext2D | null = null
  let size: { w: number; h: number } | null = null
  let resizeWatch: ResizeObserver | null = null

  const draw = () => {
    if (!canvas) return
    context ??= canvas.getContext('2d')
    const g = context
    if (!g) return
    const dpr = window.devicePixelRatio || 1
    const w = size?.w ?? canvas.clientWidth
    const h = size?.h ?? canvas.clientHeight
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr
      canvas.height = h * dpr
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, w, h)
    if (!paint || paint.h !== h) {
      const styles = getComputedStyle(canvas)
      const grad = g.createLinearGradient(0, h, 0, 0)
      grad.addColorStop(0, styles.getPropertyValue('--oc-role-primary').trim() || '#7b5ea7')
      grad.addColorStop(1, styles.getPropertyValue('--oc-role-tertiary').trim() || '#5a5c7e')
      paint = { h, grad }
    }
    g.fillStyle = paint.grad
    g.globalAlpha = mode === 'idle' ? 0.35 : 0.6
    const gap = 2
    const bw = (w - gap * (BINS - 1)) / BINS
    for (let i = 0; i < BINS; i++) {
      const bh = Math.max(2, levels[i] * h)
      g.fillRect(i * (bw + gap), h - bh, bw, bh)
    }
  }

  const step = () => {
    if (mode === 'analysed' && analyser && data) {
      analyser.getByteFrequencyData(data)
      for (let b = 0; b < HALF; b++) {
        const [lo, hi] = bounds[b]
        let sum = 0
        for (let j = lo; j < hi; j++) sum += data[j]
        bucket[b] = sum / (hi - lo) / 255
      }
      for (let i = 0; i < BINS; i++) {
        const v = i < EDGE || i >= BINS - EDGE ? 0 : bucket[bucketOf(i)]
        levels[i] = Math.max(0.03, levels[i] + (v - levels[i]) * (v > levels[i] ? 0.6 : 0.14))
      }
    }
    draw()
    frame = requestAnimationFrame(step)
  }

  const run = () => {
    cancelAnimationFrame(frame)
    if (mode === 'idle') {
      levels.fill(0.03)
      draw()
      return
    }
    if (reduced()) {
      draw()
      return
    }
    frame = requestAnimationFrame(step)
  }

  /** Give the composable its canvas. Safe to call with null on unmount. */
  const mount = (el: HTMLCanvasElement | null) => {
    canvas = el
    context = null
    size = null
    resizeWatch?.disconnect()
    resizeWatch = null
    if (el && typeof ResizeObserver === 'function') {
      resizeWatch = new ResizeObserver(() => {
        size = { w: el.clientWidth, h: el.clientHeight }
        if (mode === 'idle') draw()
      })
      resizeWatch.observe(el)
    }
    repaint()
    themeWatch?.disconnect()
    themeWatch = null
    if (el && typeof MutationObserver === 'function') {
      // The shell applies its theme as inline custom properties on <html>, so
      // a theme change there is a `style` mutation; nothing else on the page
      // tells the canvas about it.
      themeWatch = new MutationObserver(repaint)
      themeWatch.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['style', 'data-theme', 'class']
      })
    }
    draw()
  }

  /** Point the display at an analyser. The player creates one per graph. */
  const attach = (an: AnalyserNode | null) => {
    analyser = an
    if (an) {
      data = new Uint8Array(an.frequencyBinCount)
      bounds = bucketBounds(an.frequencyBinCount)
    } else {
      data = null
      bounds = []
    }
  }

  const setActive = (on: boolean) => {
    mode = on && analyser ? 'analysed' : 'idle'
    run()
  }

  const destroy = () => {
    cancelAnimationFrame(frame)
    themeWatch?.disconnect()
    themeWatch = null
    resizeWatch?.disconnect()
    resizeWatch = null
    analyser = null
    canvas = null
    context = null
  }

  return { mount, attach, setActive, repaint, destroy }
}
