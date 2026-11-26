import { describe, expect, it } from 'vitest'
import '../../src/h5p-offline-player'
import { FIXTURES, clearPackageCaches, play } from './utils'

/**
 * A host that honours `Range` but gzips the archive, as GitHub Pages does: ranged requests get
 * `identity`, plain ones gzip, so two lengths exist; cross-origin, only `Content-Length` shows.
 */
describe('a host that compresses the archive', () => {
  it('answers a ranged request uncompressed and at the true length, a plain one gzipped', async () => {
    const url = new URL(FIXTURES.compressingBasic, location.href).href

    const ranged = await fetch(url, { headers: { Range: 'bytes=0-' }, cache: 'no-store' })
    const rangedLength = Number(ranged.headers.get('content-length'))
    await ranged.body?.cancel()

    const plain = await fetch(url, { cache: 'no-store' })
    const plainLength = Number(plain.headers.get('content-length'))
    const decoded = (await plain.arrayBuffer()).byteLength

    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('content-range')).toBe(`bytes 0-${rangedLength - 1}/${rangedLength}`)
    // The plain answer was the gzipped copy: shorter on the wire, the archive once decoded.
    expect(plainLength).toBeLessThan(rangedLength)
    expect(decoded).toBe(rangedLength)
  })

  it('plays', async () => {
    await clearPackageCaches()
    const player = await play(FIXTURES.compressingBasic)
    expect(player.state).toBe('ready')
  })
})
