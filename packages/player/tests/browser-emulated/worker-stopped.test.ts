/// <reference types="@vitest/browser-playwright" />
import { cdp } from 'vitest/browser'
import { afterEach, describe, expect, it } from 'vitest'
import '../../src/h5p-offline-player'
import { clearPackageCaches, play } from '../browser/utils'

/**
 * A load after the browser stopped the Service Worker (#136): its block cache is gone, so the index
 * was read again, tail then head. Kept with the package now, when the host gives an `ETag`.
 */

const rangesOf = async (log: string): Promise<string[]> => (await fetch(`/counted/__log?log=${log}`)).json()

/** Plays `src`, removes the player, stops the worker, and plays it again: the second load's requests. */
async function reloadAfterStop(src: string, log: string): Promise<string[]> {
  const first = await play(src)
  const before = (await rangesOf(log)).length
  first.remove()
  await cdp().send('ServiceWorker.enable')
  await cdp().send('ServiceWorker.stopAllWorkers')
  await play(src)
  return (await rangesOf(log)).slice(before)
}

describe('a load after the browser stopped the worker', () => {
  afterEach(() => clearPackageCaches())

  it('asks the host for the probe alone when it gave a validator', async () => {
    const log = crypto.randomUUID()
    // Its index is read from the blocks the first load kept, and its files from the warm's copies.
    expect(await reloadAfterStop(`/counted/basic.h5p?log=${log}&etag=1`, log)).toEqual(['bytes=0-0'])
  })

  it('reads the index again when the host gave none', async () => {
    const log = crypto.randomUUID()
    // An archive republished at the same URL keeps its package id without a validator, and old
    // blocks would send zip.js to the old offsets: the probe, then the index.
    const requests = await reloadAfterStop(`/counted/basic.h5p?log=${log}`, log)
    expect(requests[0]).toBe('bytes=0-0')
    expect(requests.length).toBeGreaterThan(1)
  })
})
