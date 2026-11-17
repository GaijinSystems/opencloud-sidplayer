import type { HeaderFields } from './headers'
import type { MusDetails } from '../cgsc/details'

/**
 * The browser-side cache, in IndexedDB.
 *
 * Two things are worth keeping between visits. The collection's documents are
 * 9 MB, which is a few seconds off the space every time the library opens.
 * The header fields are worse: 61,157 range reads, minutes of work, and they
 * only change when the collection does. A third, smaller: what a Compute's
 * tune said about itself when it was selected, so that selecting it again
 * after a reload does not fetch the file again.
 *
 * Both are caches, never the truth: everything here can be rebuilt from the
 * collection, and a release number stamped on the record is what says whether
 * it still applies. IndexedDB is also allowed to be missing - a private
 * window, blocked site data - so every call resolves rather than rejecting,
 * and the library works without it, only slower.
 */

const DB_NAME = 'sidplayer-hvsc'
/**
 * The cache under the app's earlier name. It holds nothing that cannot be
 * read again, so it is let go of rather than carried over.
 */
const LEGACY_DB_NAME = 'sidplay-hvsc'
/*
 * 2: headers moved from being keyed by path and stamped with a release to
 * being keyed by the tune's MD5, and the document record was discarded.
 *
 * The header fields are a pure function of the file's bytes, so the MD5 is
 * their natural identity: the cache now survives a new release, a tune moved
 * to another folder, and the state before any sync has told us what release
 * this is - which used to store everything under release 0 and then orphan
 * all of it the moment a sync set the real number. Records of superseded
 * releases also used to accumulate for ever, since nothing pruned them.
 *
 * The upgrade drops both stores rather than migrating. Documents cached by
 * version 1 were decoded as UTF-8 and have U+FFFD where HVSC wrote accented
 * letters, and headers cached under a release number cannot be given an MD5
 * after the fact; both are re-read from the collection in a few seconds.
 *
 * 3: adds the Compute's details, keyed by collection path, since that
 * collection publishes no MD5 to key them by. This upgrade only adds: the two
 * stores above are as version 2 left them, and dropping them would cost
 * everyone a re-read of HVSC's documents and every header they had indexed
 * for the sake of a store that starts empty anyway.
 */
const DB_VERSION = 3
const DOCUMENTS = 'documents'
const HEADERS = 'headers'
const MUS = 'mus'
const DOCUMENTS_KEY = 'current'

export interface CachedDocuments {
  release: number
  songlengths: string
  /**
   * The server's MD5s of the three files these were read from, joined, where
   * it gave one for the manifest. The release number alone does not say the file is the same
   * one: a sync finished from another device, or an archive unpacked over
   * the collection by hand, changes the file and not the number.
   */
  checksums?: string
  stil: string | null
  musicians: string | null
}

export interface DocumentCache {
  loadDocuments(): Promise<CachedDocuments | null>
  saveDocuments(documents: CachedDocuments): Promise<void>
  /** Header fields by tune MD5, for every tune this browser has read. */
  loadHeaders(): Promise<Map<string, HeaderFields>>
  saveHeaders(records: HeaderRecord[]): Promise<void>
  /** What a Compute's tune said about itself, by its path in that collection. */
  loadMus(path: string): Promise<MusRecord | null>
  saveMus(record: MusRecord): Promise<void>
}

export interface HeaderRecord extends HeaderFields {
  /** Whole-file MD5, which is what the fields belong to. */
  md5: string
}

/** A Compute's tune's details, under its path in that collection. */
export interface MusRecord extends MusDetails {
  path: string
}

const open = (): Promise<IDBDatabase | null> =>
  new Promise((resolve) => {
    let idb: IDBFactory | undefined
    try {
      idb = globalThis.indexedDB
    } catch {
      resolve(null)
      return
    }
    if (!idb) {
      resolve(null)
      return
    }
    // Best effort, and never waited on: an old cache left behind costs disk, not correctness.
    try {
      idb.deleteDatabase(LEGACY_DB_NAME)
    } catch {
      /* nothing to tidy */
    }
    let request: IDBOpenDBRequest
    try {
      request = idb.open(DB_NAME, DB_VERSION)
    } catch {
      resolve(null)
      return
    }
    request.onupgradeneeded = (event) => {
      const db = request.result
      // Before 2, dropped rather than migrated: see the note on DB_VERSION.
      // From 2 on, an upgrade only adds what is new.
      if (event.oldVersion < 2) {
        if (db.objectStoreNames.contains(DOCUMENTS)) db.deleteObjectStore(DOCUMENTS)
        if (db.objectStoreNames.contains(HEADERS)) db.deleteObjectStore(HEADERS)
        db.createObjectStore(DOCUMENTS)
        db.createObjectStore(HEADERS, { keyPath: 'md5' })
      }
      if (!db.objectStoreNames.contains(MUS)) db.createObjectStore(MUS, { keyPath: 'path' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })

const done = (tx: IDBTransaction): Promise<boolean> =>
  new Promise((resolve) => {
    tx.oncomplete = () => resolve(true)
    tx.onerror = () => resolve(false)
    tx.onabort = () => resolve(false)
  })

/** What a request gives, or `fallback` where it fails or cannot be made at all. */
const ask = <T>(make: () => IDBRequest, fallback: T): Promise<T> =>
  new Promise((resolve) => {
    try {
      const request = make()
      request.onsuccess = () => resolve((request.result as T) ?? fallback)
      request.onerror = () => resolve(fallback)
    } catch {
      resolve(fallback)
    }
  })

/** Headers are written in batches: 61,157 single transactions would crawl. */
const BATCH = 2000

export function createDocumentCache(): DocumentCache {
  let db: IDBDatabase | null | undefined

  const database = async (): Promise<IDBDatabase | null> => {
    if (db === undefined) db = await open()
    return db
  }

  /** One record by key, or null for a missing record, a missing database or any failure. */
  const getOne = async <T>(store: string, key: string): Promise<T | null> => {
    const handle = await database()
    if (!handle) return null
    return ask<T | null>(() => handle.transaction(store, 'readonly').objectStore(store).get(key), null)
  }
  /** One record written; a failure - out of quota, the store gone - just means it is fetched again. */
  const putOne = async (store: string, value: unknown, key?: string): Promise<void> => {
    const handle = await database()
    if (!handle) return
    try {
      const tx = handle.transaction(store, 'readwrite')
      // No key at all, not an undefined one, for a store keyed by a path in the record.
      if (key === undefined) tx.objectStore(store).put(value)
      else tx.objectStore(store).put(value, key)
      await done(tx)
    } catch {
      /* nothing kept; the library reads it again */
    }
  }

  return {
    loadDocuments: () => getOne<CachedDocuments>(DOCUMENTS, DOCUMENTS_KEY),
    saveDocuments: (documents) => putOne(DOCUMENTS, documents, DOCUMENTS_KEY),

    async loadHeaders() {
      const handle = await database()
      const out = new Map<string, HeaderFields>()
      if (!handle) return out
      const records = await ask<HeaderRecord[]>(
        () => handle.transaction(HEADERS, 'readonly').objectStore(HEADERS).getAll(),
        []
      )
      for (const { md5, ...fields } of records) out.set(md5, fields)
      return out
    },

    async saveHeaders(records) {
      const handle = await database()
      if (!handle || !records.length) return
      for (let i = 0; i < records.length; i += BATCH) {
        try {
          const tx = handle.transaction(HEADERS, 'readwrite')
          const store = tx.objectStore(HEADERS)
          for (const record of records.slice(i, i + BATCH)) store.put(record)
          if (!(await done(tx))) return
        } catch {
          return
        }
      }
    },

    loadMus: (path) => getOne<MusRecord>(MUS, path),
    // Keyed by its own `path`, the store's key path, so no key is passed.
    saveMus: (record) => putOne(MUS, record)
  }
}
