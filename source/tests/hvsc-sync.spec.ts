import { describe, it, expect, vi } from 'vitest'
import type { ManifestEntry } from '../src/hvsc/manifest'
import {
  DOCUMENT_FILES,
  planSync,
  runSync,
  syncDocuments,
  type LocalIndex,
  type SyncPlan
} from '../src/hvsc/sync'
import { CHECK_INTERVAL_MS, parseStatus, shouldCheck, updateAvailable } from '../src/hvsc/status'

const entry = (path: string, md5: string): ManifestEntry => ({ path, md5, lengths: [60] })

const RELEASE: ManifestEntry[] = [
  entry('/MUSICIANS/H/Hubbard_Rob/Commando.sid', 'a1'),
  entry('/MUSICIANS/H/Hubbard_Rob/Delta.sid', 'b2'),
  entry('/DEMOS/0-9/12345.sid', 'c3'),
  entry('/DOCUMENTS/Songlengths.md5', 'd4')
]

describe('planning a sync', () => {
  it('fetches what is missing and leaves what already matches', () => {
    const local: LocalIndex = new Map([
      ['/MUSICIANS/H/Hubbard_Rob/Commando.sid', 'a1'],
      ['/DEMOS/0-9/12345.sid', 'c3']
    ])
    const plan = planSync(RELEASE, local)
    expect(plan.add.map((e) => e.path)).toEqual([
      '/MUSICIANS/H/Hubbard_Rob/Delta.sid',
      '/DOCUMENTS/Songlengths.md5'
    ])
    expect(plan.replace).toHaveLength(0)
    expect(plan.unchanged).toBe(2)
    expect(plan.remove).toHaveLength(0)
  })

  it('replaces a file whose content differs, whatever its case', () => {
    const plan = planSync(RELEASE, new Map([['/MUSICIANS/H/Hubbard_Rob/Commando.sid', 'ZZ']]))
    expect(plan.replace.map((e) => e.path)).toEqual(['/MUSICIANS/H/Hubbard_Rob/Commando.sid'])
    const same = planSync(RELEASE, new Map([['/MUSICIANS/H/Hubbard_Rob/Commando.sid', 'A1']]))
    expect(same.replace).toHaveLength(0)
    expect(same.unchanged).toBe(1)
  })

  it('proposes removing a withdrawn tune', () => {
    const local: LocalIndex = new Map([
      ['/MUSICIANS/H/Hubbard_Rob/Commando.sid', 'a1'],
      ['/MUSICIANS/J/Jac/Withdrawn.sid', 'old']
    ])
    expect(planSync(RELEASE, local).remove).toEqual(['/MUSICIANS/J/Jac/Withdrawn.sid'])
  })

  it('never proposes removing something HVSC did not put there', () => {
    const local: LocalIndex = new Map([
      ['/My_own_tunes/Experiment.sid', 'mine'],
      ['/Notes.txt', 'mine'],
      ['/.sidplayer/status.json', 'mine'],
      ['/.sidplayer/favourites.json', 'mine']
    ])
    expect(planSync(RELEASE, local).remove).toEqual([])
  })

  /*
   * What a real unpacked collection actually holds, from a working copy:
   * disk images and readme.1st at the top level, an `update/` folder left by
   * an applied update package, and a DOCUMENTS folder full of files the
   * manifest never mentions - it lists only .sid files, and only under
   * DEMOS, GAMES and MUSICIANS, all 61,157 of them in release 85. None of
   * that may be offered for deletion.
   */
  it('leaves everything the manifest does not describe alone', () => {
    const local: LocalIndex = new Map([
      ['/10_Years_HVSC.d81', 'x'],
      ['/20_Years_HVSC.d64', 'x'],
      ['/HVSC_Intro_41.d64', 'x'],
      ['/readme.1st', 'x'],
      ['/update/new/MUSICIANS/A/Agemixer/Sky_High.sid', 'x'],
      ['/DOCUMENTS/HVSC.faq', 'x'],
      ['/DOCUMENTS/Songlengths.faq', 'x'],
      ['/DOCUMENTS/hv_sids.txt', 'x'],
      ['/DOCUMENTS/Update_Announcements/20260628.txt', 'x'],
      ['/DOCUMENTS/STIL.txt', 'x'],
      // A Compute! Sidplayer trio beside the tunes: not .sid, not listed.
      ['/MUSICIANS/H/Hubbard_Rob/Notes.txt', 'x'],
      ['/DEMOS/0-9/Something.mus', 'x']
    ])
    expect(planSync(RELEASE, local).remove).toEqual([])
  })

  it('still proposes removing a withdrawn tune beside all of that', () => {
    const local: LocalIndex = new Map([
      ['/readme.1st', 'x'],
      ['/DOCUMENTS/HVSC.faq', 'x'],
      ['/MUSICIANS/J/Jac/Withdrawn.sid', 'old'],
      ['/GAMES/A-F/Gone.SID', 'old']
    ])
    // Case-insensitively, since HVSC has had both spellings over the years.
    expect(planSync(RELEASE, local).remove).toEqual(['/GAMES/A-F/Gone.SID', '/MUSICIANS/J/Jac/Withdrawn.sid'])
  })

  it('counts a file with no checksum as unverified rather than re-fetching it', () => {
    const plan = planSync(RELEASE, new Map([['/MUSICIANS/H/Hubbard_Rob/Commando.sid', null]]))
    expect(plan.unverified).toEqual(['/MUSICIANS/H/Hubbard_Rob/Commando.sid'])
    expect(plan.unchanged).toBe(1)
    expect(plan.add.map((e) => e.path)).not.toContain('/MUSICIANS/H/Hubbard_Rob/Commando.sid')
  })

  it('knows when there is nothing to do', () => {
    const local: LocalIndex = new Map(RELEASE.map((e) => [e.path, e.md5]))
    const plan = planSync(RELEASE, local)
    expect(plan.unchanged).toBe(4)
    expect(plan.add.length + plan.replace.length + plan.remove.length).toBe(0)
  })
})

describe('running a sync', () => {
  const plan = (over: Partial<SyncPlan> = {}): SyncPlan => ({
    add: [],
    replace: [],
    remove: [],
    unchanged: 0,
    unverified: [],
    ...over
  })

  const mirrorOf = (bytes = 8) => ({
    tune: vi.fn(async (path: string) => {
      if (path.includes('Missing')) throw new Error('404')
      return new Uint8Array(bytes)
    })
  })
  const spaceOf = () => ({ write: vi.fn(async () => {}), remove: vi.fn(async () => {}) })

  it('writes every file it fetches and reports as it goes', async () => {
    const mirror = mirrorOf(10)
    const space = spaceOf()
    const seen: number[] = []
    const result = await runSync(plan({ add: RELEASE.slice(0, 3) }), {
      mirror,
      space,
      concurrency: 2,
      onProgress: (p) => seen.push(p.done)
    })
    expect(mirror.tune).toHaveBeenCalledTimes(3)
    expect(space.write).toHaveBeenCalledTimes(3)
    expect(result).toMatchObject({ done: 3, total: 3, added: 3, failed: 0, bytes: 30 })
    expect(seen).toContain(1)
    expect(result.recent.at(-1)?.action).toBe('add')
  })

  it('counts a replacement separately from an addition', async () => {
    const result = await runSync(plan({ add: [RELEASE[0]], replace: [RELEASE[1]] }), {
      mirror: mirrorOf(),
      space: spaceOf()
    })
    expect(result).toMatchObject({ added: 1, replaced: 1 })
  })

  it('keeps going when one file fails, and says how many did', async () => {
    const mirror = mirrorOf()
    const space = spaceOf()
    const result = await runSync(
      plan({ add: [...RELEASE.slice(0, 2), entry('/GAMES/A-F/Missing.sid', 'x')] }),
      {
        mirror,
        space
      }
    )
    expect(result.failed).toBe(1)
    expect(result.added).toBe(2)
    expect(space.write).toHaveBeenCalledTimes(2)
    expect(result.recent.some((r) => r.action === 'fail')).toBe(true)
  })

  it('deletes nothing unless the removals were approved', async () => {
    const space = spaceOf()
    const withoutApproval = await runSync(plan({ remove: ['/MUSICIANS/J/Jac/Gone.sid'] }), {
      mirror: mirrorOf(),
      space
    })
    expect(space.remove).not.toHaveBeenCalled()
    expect(withoutApproval.total).toBe(0)

    const approved = await runSync(plan({ remove: ['/MUSICIANS/J/Jac/Gone.sid'] }), {
      mirror: mirrorOf(),
      space,
      applyRemovals: true
    })
    expect(space.remove).toHaveBeenCalledWith('/MUSICIANS/J/Jac/Gone.sid')
    expect(approved.removed).toBe(1)
  })

  /*
   * What a run finished, file by file, so a paused run can be resumed from
   * where it stopped rather than started again from the first file.
   */
  it('reports each file it finished, and not the ones that failed', async () => {
    const done: string[] = []
    await runSync(plan({ add: [...RELEASE.slice(0, 2), entry('/GAMES/A-F/Missing.sid', 'x')] }), {
      mirror: mirrorOf(),
      space: spaceOf(),
      onDone: (path) => done.push(path)
    })
    expect(done.sort()).toEqual(
      RELEASE.slice(0, 2)
        .map((e) => e.path)
        .sort()
    )

    const removed: string[] = []
    await runSync(plan({ add: RELEASE.slice(0, 1), remove: ['/MUSICIANS/J/Jac/Gone.sid'] }), {
      mirror: mirrorOf(),
      space: spaceOf(),
      applyRemovals: true,
      onDone: (path) => removed.push(path)
    })
    expect(removed).toContain('/MUSICIANS/J/Jac/Gone.sid')
  })

  /*
   * A release that moves a tune lists it as one addition and one removal.
   * With the addition failed and the removal carried out anyway, the only
   * copy the collection had went to the trash.
   */
  it('removes nothing, approved or not, when a fetch failed', async () => {
    const space = spaceOf()
    const result = await runSync(
      plan({ add: [RELEASE[0], entry('/GAMES/A-F/Missing.sid', 'x')], remove: ['/MUSICIANS/J/Jac/Gone.sid'] }),
      { mirror: mirrorOf(), space, applyRemovals: true }
    )
    expect(space.remove).not.toHaveBeenCalled()
    expect(result).toMatchObject({ failed: 1, removed: 0, removalsHeld: 1, done: 2, total: 2 })
  })

  /* The one moment a tune's bytes are in hand, for whoever wants its header. */
  it('hands over what it wrote, and nothing it did not', async () => {
    const seen: string[] = []
    await runSync(plan({ add: [RELEASE[0], entry('/GAMES/A-F/Missing.sid', 'x')] }), {
      mirror: mirrorOf(12),
      space: spaceOf(),
      onBytes: (e, bytes) => seen.push(`${e.path}:${bytes.byteLength}`)
    })
    expect(seen).toEqual([`${RELEASE[0].path}:12`])
  })

  it('stops between files when asked, and says why', async () => {
    const mirror = mirrorOf()
    const space = spaceOf()
    let calls = 0
    const result = await runSync(plan({ add: RELEASE }), {
      mirror,
      space,
      concurrency: 1,
      shouldStop: () => (++calls > 2 ? 'paused' : false)
    })
    expect(result.stopped).toBe('paused')
    expect(result.done).toBeLessThan(4)
  })
})

describe('the collection documents', () => {
  /*
   * Songlengths.md5 lists tunes and nothing else - not the documents, not
   * itself - so a sync driven only by the manifest would leave the library
   * with no lengths, no commentary and no composer names. Confirmed against
   * the real file: zero of its 61,157 entries is under DOCUMENTS/.
   */
  const md5Of = (bytes: Uint8Array) => `md5-${bytes.byteLength}`

  it('fetches every document the manifest cannot mention', async () => {
    const mirror = { tune: vi.fn(async (path: string) => new Uint8Array(path.length)) }
    const space = { write: vi.fn(async () => {}), remove: vi.fn(async () => {}) }
    const result = await syncDocuments(mirror, space, new Map(), md5Of)
    expect(mirror.tune).toHaveBeenCalledTimes(DOCUMENT_FILES.length)
    expect(result.written).toEqual([
      '/DOCUMENTS/HVSC.txt',
      '/DOCUMENTS/Songlengths.md5',
      '/DOCUMENTS/STIL.txt',
      '/DOCUMENTS/Musicians.txt'
    ])
    expect(space.write).toHaveBeenCalledTimes(4)
  })

  it('writes only the ones that differ', async () => {
    const mirror = { tune: vi.fn(async (path: string) => new Uint8Array(path.length)) }
    const space = { write: vi.fn(async () => {}), remove: vi.fn(async () => {}) }
    const local: LocalIndex = new Map([
      ['/DOCUMENTS/STIL.txt', md5Of(new Uint8Array('/DOCUMENTS/STIL.txt'.length))]
    ])
    const result = await syncDocuments(mirror, space, local, md5Of)
    expect(result.unchanged).toEqual(['/DOCUMENTS/STIL.txt'])
    expect(result.written).toHaveLength(3)
  })

  /*
   * What arrives is looked at before it is written. A proxy answering 200
   * with its own error page would otherwise put that page into the
   * collection as Songlengths.md5, and the catalogue built from it next
   * would have no tunes in it at all.
   */
  it('does not write a document that is not what it should be', async () => {
    const mirror = { tune: vi.fn(async (path: string) => new Uint8Array(path.length)) }
    const space = { write: vi.fn(async () => {}), remove: vi.fn(async () => {}) }
    const result = await syncDocuments(mirror, space, new Map(), md5Of, DOCUMENT_FILES, {
      accept: (path) => !path.endsWith('Songlengths.md5')
    })
    expect(result.failed).toEqual(['/DOCUMENTS/Songlengths.md5'])
    expect(space.write).toHaveBeenCalledTimes(3)
  })

  it('reports a document it could not fetch instead of failing the sync', async () => {
    const mirror = {
      tune: vi.fn(async (path: string) => {
        if (path.endsWith('Musicians.txt')) throw new Error('404')
        return new Uint8Array(4)
      })
    }
    const space = { write: vi.fn(async () => {}), remove: vi.fn(async () => {}) }
    const result = await syncDocuments(mirror, space, new Map(), md5Of)
    expect(result.failed).toEqual(['/DOCUMENTS/Musicians.txt'])
    expect(result.written).toHaveLength(3)
  })
})

describe('status file', () => {
  const at = (iso: string) => ({ release: 85, upstream: 85, checkedAt: iso })

  it('checks when nothing is recorded, and once a day after that', () => {
    const now = Date.parse('2026-09-21T12:00:00Z')
    expect(shouldCheck(null, now)).toBe(true)
    expect(shouldCheck({ release: 85, upstream: null, checkedAt: null }, now)).toBe(true)
    expect(shouldCheck(at('2026-09-21T11:00:00Z'), now)).toBe(false)
    expect(shouldCheck(at('2026-09-20T11:59:00Z'), now)).toBe(true)
    expect(shouldCheck(at(new Date(now - CHECK_INTERVAL_MS).toISOString()), now)).toBe(true)
  })

  it('treats an unreadable or future timestamp as due', () => {
    const now = Date.parse('2026-09-21T12:00:00Z')
    expect(shouldCheck(at('not a date'), now)).toBe(true)
    expect(shouldCheck(at('2027-01-01T00:00:00Z'), now)).toBe(true)
  })

  it('reports an update only when upstream is genuinely ahead', () => {
    expect(updateAvailable({ release: 85, upstream: 86, checkedAt: null })).toBe(true)
    expect(updateAvailable({ release: 85, upstream: 85, checkedAt: null })).toBe(false)
    expect(updateAvailable({ release: null, upstream: 85, checkedAt: null })).toBe(true)
    expect(updateAvailable({ release: 85, upstream: null, checkedAt: null })).toBe(false)
    expect(updateAvailable(null)).toBe(false)
  })

  it('survives a status file that has been edited into nonsense', () => {
    expect(parseStatus('not json')).toBeNull()
    expect(parseStatus('null')).toBeNull()
    expect(parseStatus('{"release":"eighty-five"}')).toMatchObject({ release: null })
    // Online is the one mode written down; anything else is the whole collection.
    expect(parseStatus('{"mode":"online"}')?.mode).toBe('online')
    expect(parseStatus('{"mode":"elsewhere"}')?.mode).toBeUndefined()
    expect(parseStatus('{"unfinished":true}')?.unfinished).toBe(true)
    expect(parseStatus('{"unfinished":"yes"}')?.unfinished).toBeUndefined()
    expect(parseStatus('{"release":85,"upstream":86,"checkedAt":"2026-09-21T00:00:00Z"}')).toMatchObject({
      release: 85,
      upstream: 86
    })
  })
})
