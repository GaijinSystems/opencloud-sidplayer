<script setup lang="ts">
import { ref } from 'vue'
import LibraryView from '@app/library/LibraryView.vue'

/**
 * The SID Library as it looks in OpenCloud, with nothing behind it but the
 * files beside this page. What needs a server - searching the whole
 * collection, fetching it, updating it - says so instead of failing.
 */

type Notice = { title: string; body: string }

const NOTICES: Record<'search' | 'collection', Notice> = {
  search: {
    title: 'Search is not part of this demo',
    body: 'In the app, search covers the whole High Voltage SID Collection - over 61,000 tunes, by title, composer, real name, year, chip and STIL commentary. That needs an OpenCloud instance to fetch the collection’s documents, about 9 MB; this demo has ten tunes and no server.'
  },
  collection: {
    title: 'Not in this demo',
    body: 'Fetching and updating the collection needs an OpenCloud instance with a route to an HVSC mirror. This demo has the ten tunes in its favourites and no server behind it.'
  }
}

const notice = ref<Notice | null>(null)

/** Search fields: whichever way one is reached, by click, by tab or by the `/` key. */
function onFocus(event: FocusEvent): void {
  const target = event.target as HTMLElement | null
  if (target?.matches('input[type="search"], [role="searchbox"]')) {
    target.blur()
    notice.value = NOTICES.search
  }
}

/** Buttons whose work is the server's. */
function onClick(event: MouseEvent): void {
  const button = (event.target as HTMLElement | null)?.closest('button, a')
  const label = (button?.textContent ?? '').trim()
  // Whole labels, so a reworded one is let through rather than another caught.
  if (/^(Download all…|Update…|Index all tunes|Download release \d*|Start online)$/.test(label)) {
    event.preventDefault()
    event.stopPropagation()
    notice.value = NOTICES.collection
  }
}
</script>

<template>
  <div class="demo" @focusin.capture="onFocus" @click.capture="onClick">
    <header class="demo-bar">
      <span class="demo-title">SID Player for OpenCloud</span>
      <span class="demo-pill">Demo</span>
      <span class="demo-note">Ten tunes, played in your browser. Favourites and settings stay in this browser; nothing is uploaded.</span>
      <a class="demo-link" href="https://github.com/GaijinSystems/opencloud-sidplayer">Get the app</a>
    </header>
    <main class="demo-main">
      <div class="demo-panel">
        <library-view />
      </div>
    </main>
    <div v-if="notice" class="demo-scrim" @click.self="notice = null">
      <div class="demo-dialog" role="dialog" aria-modal="true" :aria-label="notice.title">
        <h2>{{ notice.title }}</h2>
        <p>{{ notice.body }}</p>
        <oc-button appearance="filled" @click="notice = null">OK</oc-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.demo {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  /* OpenCloud's frame: the app in a panel inset from the chrome around it. */
  background: var(--oc-role-chrome);
  color: var(--oc-role-on-chrome);
}
.demo-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  height: 60px;
  padding: 0 20px;
  font-size: 13px;
}
.demo-title {
  font-weight: 600;
  font-size: 18px;
}
.demo-pill {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--oc-role-secondary-container);
  color: var(--oc-role-on-secondary-container);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.demo-note {
  flex-grow: 1;
  color: var(--oc-role-on-surface-variant);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.demo-link {
  color: inherit;
  font-weight: 500;
  white-space: nowrap;
}
.demo-main {
  flex-grow: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 0 8px 8px;
}
.demo-panel {
  flex-grow: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 10px;
  background: var(--oc-role-background);
  color: var(--oc-role-on-background);
}
.demo-scrim {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.42);
}
.demo-dialog {
  max-width: 460px;
  padding: 22px;
  border-radius: 12px;
  background: var(--oc-role-surface);
  color: var(--oc-role-on-surface);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.28);
}
.demo-dialog h2 {
  margin: 0 0 8px;
  font-size: 17px;
  font-weight: 600;
}
.demo-dialog p {
  margin: 0 0 18px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--oc-role-on-surface-variant);
}
</style>
