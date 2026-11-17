import { describe, it, expect } from 'vitest'
import { formatTime, formatAddress, formatBytes } from '../src/helpers/format'

describe('formatTime', () => {
  it('formats minutes and seconds, and hours once past one', () => {
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(65)).toBe('1:05')
    expect(formatTime(3600)).toBe('1:00:00')
    expect(formatTime(3725.9)).toBe('1:02:05')
  })
  it('reads negative and non-finite as zero', () => {
    expect(formatTime(-3)).toBe('0:00')
    expect(formatTime(Number.NaN)).toBe('0:00')
  })
})

describe('formatAddress', () => {
  it('uses the $XXXX convention', () => {
    expect(formatAddress(0xd400)).toBe('$D400')
    expect(formatAddress(0x80)).toBe('$0080')
  })
})

describe('formatBytes', () => {
  it('rounds sensibly', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(4096)).toBe('4 KB')
    expect(formatBytes(-1)).toBe('—')
  })

  it('stops at megabytes and shows one decimal there', () => {
    // Where the unit runs out: a whole HVSC document is tens of megabytes
    // and must not read as thousands of kilobytes.
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(1536 * 1024)).toBe('1.5 MB')
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe('5120.0 MB')
  })

  it('reads a non-finite size as nothing known', () => {
    expect(formatBytes(Number.NaN)).toBe('—')
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—')
  })
})
