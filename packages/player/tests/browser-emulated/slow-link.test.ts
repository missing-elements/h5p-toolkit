/// <reference types="@vitest/browser-playwright" />
import { cdp } from 'vitest/browser'
import { afterEach, describe, expect, it } from 'vitest'
import '../../src/h5p-offline-player'
import { FIXTURES, clearPackageCaches, frameFetch, play, virtualUrl } from '../browser/utils'

/**
 * A large deflated entry over a slow link, emulated through CDP as DevTools' throttling is. It
 * reaches the Jobs worker, which reads the archive and so decides the time to first byte.
 */

const MEDIA = 'content/media/big.bin'
const KB = 1024

const throttle = async (bytesPerSecond: number) => {
  await cdp().send('Network.enable')
  await cdp().send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 20,
    downloadThroughput: bytesPerSecond,
    uploadThroughput: bytesPerSecond
  })
}

const unthrottle = () =>
  cdp().send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1
  })

describe('a large deflated entry on a slow link', () => {
  afterEach(async () => {
    await unthrottle()
    await clearPackageCaches()
  })

  it('serves its first bytes within seconds, not after the first 16 MB', { timeout: 60_000 }, async () => {
    await clearPackageCaches()
    // Booted at full speed: the libraries are not what is being measured.
    const player = await play(FIXTURES.segmented)
    await throttle(1024 * KB)

    // The throttle is in effect: two megabytes fetched directly take about two seconds.
    const check = performance.now()
    await (
      await fetch(FIXTURES.largeStored, { headers: { Range: 'bytes=0-2097151' }, cache: 'no-store' })
    ).arrayBuffer()
    expect(performance.now() - check).toBeGreaterThan(1_500)

    // The media element's opening probe: four 4 MB segments opened together and handed over whole
    // put the first byte 16 s out here; streamed from the first segment, it is a few hundred kB.
    const started = performance.now()
    const response = await frameFetch(player, virtualUrl(player, MEDIA), { headers: { Range: 'bytes=0-1023' } })
    const elapsed = performance.now() - started

    expect([200, 206]).toContain(response.status)
    expect((await response.arrayBuffer()).byteLength).toBe(1024)
    expect(elapsed).toBeLessThan(8_000)
  })
})
