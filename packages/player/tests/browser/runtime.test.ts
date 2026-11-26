import { describe, expect, it } from 'vitest'
import '../../src/h5p-offline-player'
import { FIXTURES, createPlayer, frameDocument, waitForSettled } from './utils'

/**
 * The runtime handed over as a property, as a bundled host does with the `runtime` export of
 * `@missing-elements/h5p-runtime`: the worker writes those URLs into the frame.
 */
describe('the runtime property', () => {
  const base = new URL('/frame-assets/', location.href).href
  const runtime = {
    frameJs: `${base}frame.bundle.js?via=runtime`,
    frameCss: `${base}h5p.css?via=runtime`,
    bootJs: `${base}frame-boot.js?via=runtime`,
    fonts: [{ family: 'Inter', style: 'normal', weight: '400', url: `${base}fonts/inter-400.woff2?via=runtime` }]
  }

  it('is what the frame loads, over the default directory beside the element', async () => {
    const player = createPlayer()
    player.runtime = runtime
    const settled = waitForSettled(player)
    player.setAttribute('src', FIXTURES.basic)

    const result = await settled
    if (!result.ok) expect.fail(`${result.detail.code} — ${result.detail.message}`)
    expect(player.state).toBe('ready')

    const scripts = [...frameDocument(player).querySelectorAll('script[src]')].map((script) => script.getAttribute('src'))
    // The boot script under the nonce, and the core it loads after it.
    expect(scripts).toContain(runtime.bootJs)
    expect(scripts).toContain(runtime.frameJs)
    expect(frameDocument(player).querySelector('style')?.textContent).toContain(runtime.fonts[0].url)
  })

  it('plays a load that names the loader of runtime 0.2, on a host that has since upgraded', async () => {
    // A page from before an upgrade still names the old `main.bundle.js`, whose URL now serves this
    // runtime's boot script: it must boot from the route in the document (#49).
    const player = createPlayer()
    player.runtime = { ...runtime, mainJs: `${base}main.bundle.js` } as typeof runtime
    const settled = waitForSettled(player)
    player.setAttribute('src', FIXTURES.basic)

    const result = await settled
    if (!result.ok) expect.fail(`${result.detail.code} — ${result.detail.message}`)
    const scripts = [...frameDocument(player).querySelectorAll('script[src]')].map((script) => script.getAttribute('src'))
    expect(scripts).toContain(`${base}main.bundle.js`)
  })

  it('refuses a value missing one of the three files, since that frame would never boot', () => {
    const player = createPlayer()
    player.runtime = { frameJs: 'b', frameCss: 'c' } as never
    expect(player.runtime).toBeNull()
    player.runtime = runtime
    expect(player.runtime?.bootJs).toBe(runtime.bootJs)
  })
})
