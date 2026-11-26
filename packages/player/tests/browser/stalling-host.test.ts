import { type H5PPlayerElement, type PlayerProgressDetail } from '../../src/h5p-offline-player'
import { afterEach, describe, expect, it } from 'vitest'
import '../../src/h5p-offline-player'
import type { PlayerErrorDetail } from '../../src/h5p-offline-player'
import { FIXTURES, clearPackageCaches, frameFetch, play, virtualUrl, waitForEvent } from './utils'

/**
 * An extraction that loses its link mid-way: the virtual server keeps serving the response, and
 * the Jobs worker resumes. A 30 s silence once errored the media element for good.
 */

const MEDIA = 'content/media/big.bin'
const TAIL = 1024

/** This file's own host on the stalling server, so other files' outages leave it alone. */
const HOST = 'stalling-host'

const outage = (ms: number, mode: 'silent' | 'reset') =>
  fetch(`/stalling/__outage?ms=${ms}&mode=${mode}&host=${HOST}`, { cache: 'no-store' })

/**
 * The entry's last bytes, past the watermark, so the body follows the extraction. Returned
 * pending: Firefox sends headers with the first body bytes, so the outage must start before.
 */
async function tailOf(player: Awaited<ReturnType<typeof play>>, errors: string[]): Promise<() => Promise<ArrayBuffer>> {
  player.addEventListener('error', ((event: CustomEvent<PlayerErrorDetail>) => {
    errors.push(event.detail.message)
  }) as EventListener)
  const probe = await frameFetch(player, virtualUrl(player, MEDIA), { headers: { Range: 'bytes=0-0' } })
  const size = Number(/\/(\d+)$/.exec(probe.headers.get('content-range') ?? '')?.[1])
  await probe.arrayBuffer()
  expect(size).toBeGreaterThan(TAIL)

  const tail = frameFetch(player, virtualUrl(player, MEDIA), {
    headers: { Range: `bytes=${size - TAIL}-` }
  })
  return async () => {
    const response = await tail
    expect(response.status).toBe(206)
    return response.arrayBuffer()
  }
}

/** Resolves on the next extraction progress with bytes landed: the transfer is under way. */
const underWay = (player: H5PPlayerElement) =>
  waitForEvent<PlayerProgressDetail>(player, 'progress', 30_000, (detail) => detail.phase === 'extract' && detail.loaded > 0)

describe('an extraction across an outage of the host', () => {
  afterEach(async () => {
    await outage(0, 'silent')
    await clearPackageCaches()
  })

  it('is not given up on while the link is silent for longer than the stall bound', { timeout: 120_000 }, async () => {
    await clearPackageCaches()
    const player = await play(`${FIXTURES.stalling}&host=${HOST}`)
    const errors: string[] = []
    const tail = await tailOf(player, errors)

    // The transfer is under way: bytes of the tail's extraction have landed. Now nothing arrives
    // for longer than the server would once wait.
    await underWay(player)
    const started = performance.now()
    await outage(35_000, 'silent')

    const body = await tail()
    expect(performance.now() - started).toBeGreaterThan(35_000)
    expect(body.byteLength).toBe(TAIL)
    expect(errors).toEqual([])
  })

  it('picks the transfer up where it stopped once a host that dropped it is back', { timeout: 90_000 }, async () => {
    await clearPackageCaches()
    const player = await play(`${FIXTURES.stalling}&host=${HOST}`)
    const errors: string[] = []
    const tail = await tailOf(player, errors)

    // The transfer is under way; then every request in flight is cut, and new ones are refused, for a while.
    await underWay(player)
    const started = performance.now()
    await outage(12_000, 'reset')

    const body = await tail()
    expect(performance.now() - started).toBeGreaterThan(12_000)
    expect(body.byteLength).toBe(TAIL)
    expect(errors).toEqual([])
  })
})
