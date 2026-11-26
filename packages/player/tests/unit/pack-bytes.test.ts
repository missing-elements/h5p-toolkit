import { execFileSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { splitPack, writePack } from '../../../libraries/scripts/parts.mjs'

/**
 * The pack's bytes, pinned by hash, depend on its libraries alone: not on time zone (#48, #51) or
 * the hub's file order (#116). Each zone gets a process, as `TZ` may not move a worker's clock.
 */

const librariesDir = resolve(import.meta.dirname, '../../../libraries')
const parts = pathToFileURL(resolve(librariesDir, 'scripts/parts.mjs')).href

// A pack of one library, written by the `writePack` the real one uses and split by `splitPack`;
// prints the bytes' hashes and the first entry's DOS time and date.
const build = `
import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { splitPack, writePack } from ${JSON.stringify(parts)}

const text = (value) => new TextEncoder().encode(value)
const pack = await writePack([{
  folder: 'H5P.Tiny-1.0',
  files: new Map([
    ['H5P.Tiny-1.0/library.json', text(JSON.stringify({ machineName: 'H5P.Tiny', majorVersion: 1, minorVersion: 0, patchVersion: 3 }))],
    ['H5P.Tiny-1.0/tiny.js', text('H5P.Tiny = function () {}')]
  ])
}])

const out = await mkdtemp(join(tmpdir(), 'pack-bytes-'))
const [{ sha256 }] = await splitPack(pack, out)
const part = await readFile(join(out, 'H5P.Tiny-1.0.h5p'))
const header = new DataView(pack.buffer)
console.log(JSON.stringify({
  pack: createHash('sha256').update(pack).digest('hex'),
  part: createHash('sha256').update(part).digest('hex'),
  indexed: sha256,
  time: header.getUint16(10, true),
  date: header.getUint16(12, true)
}))
`

function buildIn(timeZone: string) {
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', build], {
    cwd: librariesDir,
    env: { ...process.env, TZ: timeZone },
    encoding: 'utf8'
  })
  return JSON.parse(output.trim().split('\n').at(-1)!) as { pack: string; part: string; indexed: string; time: number; date: number }
}

describe('the library pack', () => {
  it('is the same bytes in every time zone', () => {
    const [utc, ...others] = ['UTC', 'Europe/Kyiv', 'America/Los_Angeles', 'Pacific/Kiritimati'].map(buildIn)
    for (const other of others) expect(other).toEqual(utc)
    expect(utc.part).toBe(utc.indexed)
  }, 30_000)

  it('records 2000-01-01 02:00, the time pack 1.0.0 shipped with', () => {
    // A different time rewrites every part and every hash the player pins, for no library's sake.
    const { time, date } = buildIn('UTC')
    expect(time).toBe(2 << 11)
    expect(date).toBe(((2000 - 1980) << 9) | (1 << 5) | 1)
  }, 30_000)

  // Two libraries' files, as a hub bundle lists them, and the same listed the other way round.
  const text = (value: string) => new TextEncoder().encode(value)
  const tiny = (patchVersion: number, script: string) => ({
    folder: 'H5P.Tiny-1.0',
    files: new Map([
      ['H5P.Tiny-1.0/library.json', text(JSON.stringify({ machineName: 'H5P.Tiny', majorVersion: 1, minorVersion: 0, patchVersion }))],
      ['H5P.Tiny-1.0/tiny.js', text(script)],
      ['H5P.Tiny-1.0/tiny.css', text('.h5p-tiny { color: teal }')]
    ])
  })
  const other = () => ({
    folder: 'H5P.Other-1.0',
    files: new Map([
      ['H5P.Other-1.0/library.json', text(JSON.stringify({ machineName: 'H5P.Other', majorVersion: 1, minorVersion: 0, patchVersion: 7 }))],
      ['H5P.Other-1.0/other.js', text('H5P.Other = function () {}')],
      ['H5P.Other-1.0/language/de.json', text('{"semantics":[]}')]
    ])
  })
  const reversed = ({ folder, files }: { folder: string; files: Map<string, Uint8Array> }) => ({ folder, files: new Map([...files].reverse()) })
  /** Each part's SHA-256, by folder. */
  async function partsOf(pack: Uint8Array) {
    const index = await splitPack(pack, await mkdtemp(join(tmpdir(), 'pack-parts-')))
    return Object.fromEntries(index.map(({ folder, sha256 }: { folder: string; sha256: string }) => [folder, sha256]))
  }

  it('keeps the entries of a library whose files are the same, in whatever order a bundle lists them', async () => {
    const before = await writePack([other(), tiny(1, 'H5P.Tiny = function () {}')])
    const again = [reversed(other()), reversed(tiny(1, 'H5P.Tiny = function () {}'))]
    expect(Buffer.compare(await writePack(again, before), before)).toBe(0)
    // Without the pack before, the bundle's order is the order written: the refresh of #116.
    expect(Buffer.compare(await writePack(again), before)).not.toBe(0)
  })

  it("writes again only the library that changed, so only its part's hash moves", async () => {
    const before = await writePack([other(), tiny(1, 'H5P.Tiny = function () {}')])
    const after = await writePack([reversed(other()), reversed(tiny(2, 'H5P.Tiny = function (params) {}'))], before)
    const [partsBefore, partsAfter] = [await partsOf(before), await partsOf(after)]
    expect(partsAfter['H5P.Other-1.0']).toBe(partsBefore['H5P.Other-1.0'])
    expect(partsAfter['H5P.Tiny-1.0']).not.toBe(partsBefore['H5P.Tiny-1.0'])
  })
})
