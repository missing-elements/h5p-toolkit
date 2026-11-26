import { describe, expect, it } from 'vitest'
import '../../src/h5p-offline-player'
import type { H5PPlayerElement, PlayerProgressDetail } from '../../src/h5p-offline-player'
import { FIXTURES, clearPackageCaches, createPlayer, waitForEvent, waitForSettled } from './utils'

/**
 * Pulling deflated media before the content asks: a deflate stream cannot restart, so a tail read
 * waits for it all. `unused.bin` is unreferenced, so its extraction can only be a prefetch.
 */

const UNREFERENCED = 'content/media/unused.bin'

/** Entries seen extracting, collected from the element's own progress events. */
function watchExtractions(player: H5PPlayerElement): Set<string> {
  const seen = new Set<string>()
  player.addEventListener('progress', (event: Event) => {
    const detail = (event as unknown as CustomEvent<PlayerProgressDetail>).detail
    if (detail.phase === 'extract' && detail.entry) seen.add(detail.entry)
  })
  return seen
}

describe('preload', () => {
  it('pulls a large deflated entry the content never asks for', async () => {
    await clearPackageCaches()

    const player = createPlayer({ preload: 'auto' })
    const extracting = watchExtractions(player)
    const settled = waitForSettled(player)
    player.setAttribute('src', FIXTURES.largeDeflated)

    expect(await settled).toEqual({ ok: true })
    if (!extracting.has(UNREFERENCED)) await waitForEvent<PlayerProgressDetail>(player, 'progress', 10_000, (detail) => detail.phase === 'extract' && detail.entry === UNREFERENCED)
  })

  it('leaves it alone by default, so a host decides whether to spend the bandwidth', async () => {
    await clearPackageCaches()

    const player = createPlayer()
    expect(player.preload).toBe('none')

    const extracting = watchExtractions(player)
    const settled = waitForSettled(player)
    player.setAttribute('src', FIXTURES.largeDeflated)

    expect(await settled).toEqual({ ok: true })
    // The referenced media may well be extracting by now — the content renders it as a video.
    // The unreferenced one has nobody to ask for it.
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    expect([...extracting]).not.toContain(UNREFERENCED)
  })
})
