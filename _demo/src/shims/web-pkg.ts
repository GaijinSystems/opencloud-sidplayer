/**
 * The two pieces of OpenCloud's web package the library view uses, as the
 * static demo provides them: the page title, and a store holding the one
 * space there is - the demo's own, in this browser.
 */
import { watchEffect, type Ref } from 'vue'
import { demoSpace } from '../demoSpace'

export function useDocumentTitle({ titleSegments }: { titleSegments: Ref<string[]> }): void {
  watchEffect(() => {
    document.title = [...titleSegments.value, 'SID Player demo'].filter(Boolean).join(' - ')
  })
}

export function useSpacesStore(): { personalSpace: typeof demoSpace } {
  return { personalSpace: demoSpace }
}
