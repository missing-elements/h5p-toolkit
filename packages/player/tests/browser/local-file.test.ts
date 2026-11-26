import { describe, expect, it } from 'vitest'
import '../../src/h5p-offline-player'
import { FIXTURES, createPlayer, frameDocument, waitForSettled } from './utils'

/**
 * The local-file adapter, the path after downloading by hand from a host without CORS. A `File`
 * handle cannot be persisted, so the worker cannot rebuild its source on its own.
 */
describe('playing a picked file', () => {
  const pickFile = async (fixture: string, name = 'picked.h5p') => {
    const bytes = await (await fetch(fixture)).arrayBuffer()
    return new File([bytes], name, { type: 'application/zip', lastModified: 1700000000000 })
  }

  it('plays a File set on the element', async () => {
    const player = createPlayer()
    const settled = waitForSettled(player)
    player.file = await pickFile(FIXTURES.basic)

    const result = await settled
    expect(result.ok).toBe(true)
    expect(frameDocument(player).querySelector('.h5p-offline-test')).toBeTruthy()
  })

  it('gives the same file the same id, so its cached entries are found again', async () => {
    const file = await pickFile(FIXTURES.basic)

    const first = createPlayer()
    const firstSettled = waitForSettled(first)
    first.file = file
    await firstSettled

    const second = createPlayer()
    const secondSettled = waitForSettled(second)
    second.file = await pickFile(FIXTURES.basic)
    await secondSettled

    expect(second.pkgId).toBe(first.pkgId)
  })

  it('separates two files that differ only in name', async () => {
    const first = createPlayer()
    const firstSettled = waitForSettled(first)
    first.file = await pickFile(FIXTURES.basic, 'one.h5p')
    await firstSettled

    const second = createPlayer()
    const secondSettled = waitForSettled(second)
    second.file = await pickFile(FIXTURES.basic, 'two.h5p')
    await secondSettled

    expect(second.pkgId).not.toBe(first.pkgId)
  })

  it('reports a bad archive rather than hanging on it', async () => {
    const player = createPlayer()
    const settled = waitForSettled(player)
    player.file = await pickFile(FIXTURES.notH5P)

    const result = await settled
    expect(result).toMatchObject({ ok: false, detail: { code: 'bad-archive' } })
  })
})
