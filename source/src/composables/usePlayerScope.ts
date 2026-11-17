import { onBeforeUnmount, watch, type Ref } from 'vue'
import type { Session } from '../player/session'
import { useSpectrum } from './useSpectrum'

/**
 * A spectrum that follows the session's player: fed by its analyser, running
 * while it plays and `shown` says the canvas is wanted, drawn on `canvas`,
 * repainted when the theme changes and let go of with the component.
 *
 * The full view, the library's bar and the dock each wired the same four
 * watches by hand.
 */
export function usePlayerScope(
  session: Session,
  canvas: Ref<HTMLCanvasElement | null>,
  shown: () => boolean
): void {
  const { player, prefs } = session
  const scope = useSpectrum()
  watch(canvas, (el) => scope.mount(el), { immediate: true })
  watch(player.analyser, (analyser) => scope.attach(analyser), { immediate: true })
  watch(
    // The analyser too: the graph that makes it can arrive after the play.
    () => [shown() && player.state.value === 'playing', player.analyser.value] as const,
    ([on]) => scope.setActive(on),
    { immediate: true }
  )
  watch(
    () => prefs.theme,
    () => scope.repaint()
  )
  onBeforeUnmount(() => scope.destroy())
}
