import { afterEach, describe, expect, it } from 'vitest'
import '../../src/h5p-offline-player'
import type { ReadyDetail } from '../../src/h5p-offline-player'
import { FIXTURES, clearPackageCaches, createPlayer, frameFetch, frameWindow, messageOf, play, settle, virtualUrl, waitForSettled } from './utils'

/**
 * Filling in libraries an export left behind (h5p.com and h5p.org keep `content/` only): entries
 * resolve against the content archive, then the bundle, and the manifests merge so all types load.
 */
describe('supplying missing libraries', () => {
  const playWithLibraries = (src: string, libraries: string) => play(src, { libraries })

  it('plays a stripped export when a bundle supplies what it is missing', async () => {
    const player = await playWithLibraries(FIXTURES.needsLibraries, FIXTURES.libraries)

    expect(player.state).toBe('ready')
    expect(messageOf(player)).toBe(
      'Libraries came from somewhere else.'
    )
    // Which bundle answered, for a page's "where did the libraries come from" line.
    expect(player.libraryBundle).toEqual({ url: new URL(FIXTURES.libraries, location.href).href, origin: location.origin, fromCache: false })
  })

  it('takes several sources in order, asking the next only for what the one before left absent', async () => {
    // The first "bundle" is a content-only export, which supplies nothing; the second has the
    // libraries.
    const player = await playWithLibraries(FIXTURES.needsLibraries, `${FIXTURES.contentOnly} ${FIXTURES.libraries}`)

    expect(player.state).toBe('ready')
    expect(messageOf(player)).toBe(
      'Libraries came from somewhere else.'
    )
  })

  it('passes over a source it cannot reach while another remains', async () => {
    // The first source answers 404 and nothing was downloaded from it before; the second has the
    // libraries. The point of naming a second source is to have it when the first is not there.
    const player = await playWithLibraries(FIXTURES.needsLibraries, `${FIXTURES.missing} ${FIXTURES.libraries}`)
    expect(player.state).toBe('ready')
  })

  it('reports the last source when none of them could supply the libraries', async () => {
    const { result } = await settle(FIXTURES.needsLibraries, { libraries: `${FIXTURES.missing} ${FIXTURES.contentOnly}` })
    expect(result).toMatchObject({ ok: false, detail: { code: 'bad-archive' } })
  })

  it('still refuses it without a libraries attribute', async () => {
    const { result } = await settle(FIXTURES.needsLibraries)
    expect(result).toMatchObject({ ok: false, detail: { code: 'bad-archive' } })
  })

  it('reports which libraries are missing, in a form a host can act on', async () => {
    const { result } = await settle(FIXTURES.needsLibraries)
    if (result.ok) expect.fail('expected the package to be refused')

    expect(result.detail.missingLibraries).toMatchObject({
      mainLibrary: 'H5P.OfflineTest',
      folders: ['H5P.OfflineTest-1.0'],
      all: true
    })
  })

  it('serves library files from the bundle and content files from the package', async () => {
    const player = await playWithLibraries(FIXTURES.needsLibraries, FIXTURES.libraries)

    const fromBundle = await frameFetch(player, virtualUrl(player, 'H5P.OfflineTest-1.0/library.json'))
    expect(fromBundle.status).toBe(200)
    expect((await fromBundle.json()).machineName).toBe('H5P.OfflineTest')

    const fromPackage = await frameFetch(player, virtualUrl(player, 'content/content.json'))
    expect(fromPackage.status).toBe(200)
    expect((await fromPackage.json()).message).toBe('Libraries came from somewhere else.')
  })

  it('merges the manifests, so a dependency only the bundle names still loads', async () => {
    const player = await playWithLibraries(FIXTURES.needsLibraries, FIXTURES.libraries)

    const merged = await (await frameFetch(player, virtualUrl(player, 'h5p.json'))).json()
    const names = merged.preloadedDependencies.map((d: { machineName: string }) => d.machineName)
    expect(names).toContain('H5P.OfflineTest')
    expect(names).toContain('H5P.OfflineExtra')

    // Named by the bundle alone. Without the merge the runtime would never load it — in a real
    // Interactive Video that is "Unable to find constructor for: H5P.Text".
    expect((frameWindow(player) as unknown as { h5pOfflineExtraLoaded?: boolean }).h5pOfflineExtraLoaded).toBe(true)
  })

  // Paced, a host without `Range` is still sending media when its libraries arrive, and the frame
  // boots early if it may. It once did, before the bundle was attached: a 404 read as JSON.
  const pacedNoRange = (tag: string) => `${FIXTURES.needsDependencyNoRange}?throttle=131072&case=${tag}`

  it("refuses a package whose libraries need one it does not carry, by name, rather than fail on a 404 read as JSON", async () => {
    // h5p.json's libraries are all there, but the content type's own library.json asks for
    // H5P.OfflineExtra, which is missing: boot once ended on "Unexpected end of JSON input".
    for (const src of [FIXTURES.needsDependency, pacedNoRange('refused')]) {
      const { result } = await settle(src)
      if (result.ok) expect.fail(`expected ${src} to be refused`)
      expect(result.detail, src).toMatchObject({ code: 'bad-archive', missingLibraries: { folders: ['H5P.OfflineExtra-1.0'], all: false } })
      expect(result.detail.message, src).toContain('H5P.OfflineExtra-1.0')
    }
  })

  it("plays a package at its own older minor where nothing has the one it names, and says so with no bundle attached (#85)", async () => {
    // h5p.json names 1.1, the folder is 1.0, no bundle: `libraryBundle` stays null, the load keeps
    // the list. Without Range the frame waits: a partial index never downgrades.
    for (const src of [`${FIXTURES.olderOwn}?case=own`, `/no-range/older-own.h5p?case=own-${Date.now()}`]) {
      let detail: ReadyDetail | undefined
      const { player, result } = await settle(src, {}, (element) =>
        element.addEventListener('ready', (event) => (detail = (event as CustomEvent<ReadyDetail>).detail))
      )
      if (!result.ok) expect.fail(`${src}: ${result.detail.code} — ${result.detail.message}`)
      expect(messageOf(player), src).toBe('Served from the archive, never extracted to disk.')
      expect(player.libraryBundle, src).toBeNull()
      expect(player.downgradedLibraries, src).toEqual([{ library: 'H5P.OfflineTest', from: '1.1', to: '1.0.0' }])
      expect(detail?.downgradedLibraries, src).toEqual(player.downgradedLibraries)
    }
  })

  it('refuses that package with downgrade-libraries="off", naming the version it names', async () => {
    const { result } = await settle(`${FIXTURES.olderOwn}?case=own-off`, { 'downgrade-libraries': 'off' })
    if (result.ok) expect.fail('expected the package to be refused')
    expect(result.detail).toMatchObject({ code: 'bad-archive', missingLibraries: { folders: ['H5P.OfflineTest-1.1'] } })
  })

  it("supplies a library's own dependency from the bundle, on a host with Range and on one without", async () => {
    for (const src of [FIXTURES.needsDependency, FIXTURES.needsDependencyNoRange, pacedNoRange('supplied')]) {
      const player = await playWithLibraries(src, FIXTURES.libraries)
      expect((frameWindow(player) as unknown as { h5pOfflineExtraLoaded?: boolean }).h5pOfflineExtraLoaded, src).toBe(true)
      expect(player.libraryBundle?.url, src).toBe(new URL(FIXTURES.libraries, location.href).href)
    }
  })

  // Unpaced, the download ends before the frame could boot early. It once booted anyway, racing the
  // bundle for a missing library (a WebKit 404 read as JSON): now `indexing`, bundle, then boot.
  it('boots a whole download only after the final index has supplied what its libraries need', async () => {
    const player = createPlayer({ libraries: FIXTURES.libraries })
    const states: string[] = []
    player.addEventListener('statechange', (event) => states.push((event as CustomEvent<{ state: string }>).detail.state))
    const settled = waitForSettled(player)
    player.setAttribute('src', `${FIXTURES.needsDependencyNoRange}?case=whole-${Date.now()}`)

    const result = await settled
    if (!result.ok) expect.fail(`${result.detail.code} — ${result.detail.message}`)
    expect(states).toEqual(['probing', 'downloading', 'indexing', 'downloading', 'indexing', 'ready'])
    expect((frameWindow(player) as unknown as { h5pOfflineExtraLoaded?: boolean }).h5pOfflineExtraLoaded).toBe(true)
  })

  it('names the bundle in the revision, after the package', async () => {
    const player = await playWithLibraries(FIXTURES.needsLibraries, FIXTURES.libraries)
    expect(player.revision).toMatch(/^sha256:[0-9a-f]{64}; libraries sha256:[0-9a-f]{64}$/)
  })

  it("leaves the manifest of a complete package alone", async () => {
    const player = await play(FIXTURES.basic)

    const manifest = await (await frameFetch(player, virtualUrl(player, 'h5p.json'))).json()
    expect(manifest.preloadedDependencies).toHaveLength(1)
    expect(manifest.title).toBe('Offline player test')
  })

  it('reports a library source that cannot be read, naming what is still missing', async () => {
    const { result } = await settle(FIXTURES.needsLibraries, { libraries: '/fixtures/no-such-bundle.h5p' })
    if (result.ok) expect.fail('expected the package to be refused')
    expect(result.detail.code).toBe('bad-archive')
    expect(result.detail.message).toContain('H5P.OfflineTest-1.0')
  })
})

/**
 * A library source that cannot be reached (`/stalling/` in `reset` mode, 503) after a bundle came
 * from it. Each play has its own content URL: a replay keeps its reader and needs no libraries.
 */
describe('a library source that cannot be reached', () => {
  // A host of its own (`host=`): an outage here must not cut the stalling-host tests' transfers.
  const outage = (ms: number) => fetch(`/stalling/__outage?ms=${ms}&mode=reset&host=libraries`, { cache: 'no-store' })
  const content = (tag: string) => `${FIXTURES.needsLibraries}?case=${tag}-${Date.now()}`

  const settle = async (src: string, libraries: string) => {
    const player = createPlayer({ libraries })
    const settled = waitForSettled(player)
    player.setAttribute('src', src)
    return { player, result: await settled }
  }

  afterEach(async () => {
    await outage(0)
  })

  it('plays from the bundle downloaded from it before', async () => {
    const libraries = `/stalling/libraries.h5p?host=libraries&case=earlier-${Date.now()}`
    const first = await settle(content('online'), libraries)
    expect(first.result).toEqual({ ok: true })

    await outage(30_000)
    const { player, result } = await settle(content('offline'), libraries)
    if (!result.ok) expect.fail(`${result.detail.code} — ${result.detail.message}`)
    expect(messageOf(player)).toBe(
      'Libraries came from somewhere else.'
    )
    // Served from the copy downloaded before: no request reached the bundle's host this time.
    expect(player.libraryBundle).toMatchObject({ url: new URL(libraries, location.href).href, fromCache: true })
  })

  it('still fails, naming what is missing, when nothing was downloaded from it', async () => {
    await outage(30_000)
    const { result } = await settle(content('never'), `/stalling/libraries.h5p?host=libraries&case=never-${Date.now()}`)
    if (result.ok) expect.fail('expected the package to be refused')
    expect(result.detail.code).toBe('bad-archive')
    expect(result.detail.message).toContain('H5P.OfflineTest-1.0')
  })

  it('does not use a bundle whose bytes are gone', async () => {
    const libraries = `/stalling/libraries.h5p?host=libraries&case=evicted-${Date.now()}`
    const first = await settle(content('before'), libraries)
    expect(first.result).toEqual({ ok: true })

    await clearPackageCaches()
    await outage(30_000)
    const { result } = await settle(content('after'), libraries)
    if (result.ok) expect.fail('expected the package to be refused')
    expect(result.detail.code).toBe('bad-archive')
  })
})
