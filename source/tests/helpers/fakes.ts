import { vi } from 'vitest'
import type { Resource } from '@opencloud-eu/web-client'
import type { SpaceOps } from '../../src/hvsc/space'
import type { DocumentCache } from '../../src/hvsc/store'

/**
 * A space that holds nothing and accepts everything: every listing is empty,
 * every read comes back empty, every write succeeds and goes nowhere. A spec
 * passes the operations its test is about and gets the rest from here, each
 * a mock of its own so calls can be counted without one spec seeing another's.
 */
export function fakeSpaceOps(overrides: Partial<SpaceOps> = {}): SpaceOps {
  return {
    list: vi.fn(async () => ({ folders: [], files: [] })),
    read: vi.fn(async () => new Uint8Array(0)),
    readHead: vi.fn(async () => new Uint8Array(0)),
    readText: vi.fn(async () => null),
    write: vi.fn(async () => {}),
    writeText: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    ensureFolder: vi.fn(async () => {}),
    ...overrides
  }
}

/**
 * As much of a `Resource` as the code under test reads: an id, the name the
 * path ends in, and the path. `extra` adds to that or replaces it - a type,
 * a size, an id that is not the path.
 */
export const resourceAt = (path: string, extra: Record<string, unknown> = {}): Resource =>
  ({ id: path, name: path.split('/').pop(), path, ...extra }) as unknown as Resource

/** A browser cache that keeps nothing; `overrides` stands in for the parts a test is about. */
export function fakeCache(overrides: Partial<DocumentCache> = {}): DocumentCache {
  return {
    loadDocuments: vi.fn(async () => null),
    saveDocuments: vi.fn(async () => {}),
    loadHeaders: vi.fn(async () => new Map()),
    saveHeaders: vi.fn(async () => {}),
    loadMus: vi.fn(async () => null),
    saveMus: vi.fn(async () => {}),
    ...overrides
  }
}
