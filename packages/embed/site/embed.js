/*! @missing-elements/h5p-embed. MIT. */
/**
 * The embed page: the element alone, driven by the query string, for a site that frames a player
 * domain of its own. It speaks H5P's resizer protocol upward; xAPI goes only to `xapi=`'s origin.
 */

/**
 * @import { H5PPlayerElement, PlayerErrorDetail, PlayerStateChangeDetail, ReadyDetail } from '@missing-elements/h5p-offline-player'
 */

/** Where the element's `libraries="pack"` fetches the library pack from, for a site without its own copy. */
const PACK_CDN_ORIGIN = 'https://cdn.jsdelivr.net'

/**
 * @param {object} [options]
 * @param {string | null} [options.packBase] the folder of this site's copy of the library pack's
 *   parts (`parts/` of `@missing-elements/h5p-libraries`), which `libraries=pack` plays from
 * @param {H5PPlayerElement['pack']} [options.pack] the same, as the `pack` export a bundler
 *   resolves; it wins over `packBase`. Without either, `pack` is the element's copy on jsDelivr
 * @param {string | null} [options.librariesPack] the URL of a whole `libraries.h5p` on this site,
 *   for a page written before the pack was split: played as any bundle, with no refresh
 * @param {string[] | null} [options.packages] the other origins packages and bundles may come from;
 *   `null` plays any, one from another origin `untrusted` when the storage is this origin's
 * @param {string | null} [options.defaultLibraries] the `libraries` value for an address with none,
 *   so a snippet without `&libraries=` plays an export that has none; `&libraries=none` opts out
 * @param {H5PPlayerElement['runtime']} [options.runtime] the `runtime` export of `@missing-elements/h5p-runtime`,
 *   for a page that bundles the element; without it the element looks for `frame-assets/` beside itself
 * @param {boolean} [options.askInOwnFrame] whether a foreign package plays `untrusted` when this
 *   origin frames the page, sharing its storage; a preview of a chosen package passes `false`
 */
export function startEmbed({ packBase = null, pack = null, librariesPack = null, packages = null, defaultLibraries = null, runtime = null, askInOwnFrame = true } = {}) {
  const params = new URLSearchParams(location.search)
  const player = /** @type {H5PPlayerElement} */ (document.querySelector('h5p-player'))
  // Before `src`: the element resolves the runtime's files, and reads where the pack is, when a
  // package is set.
  if (runtime) player.runtime = runtime
  if (pack) player.pack = pack
  else if (packBase) player.setAttribute('pack-base', packBase)
  const ownPack = Boolean(pack || packBase)
  const notice = /** @type {HTMLElement} */ (document.querySelector('#notice'))
  const loader = /** @type {HTMLElement} */ (document.querySelector('#loader'))
  const framed = window.parent !== window

  /* ---------------------------------------------------------------- notices */

  /**
   * @param {string} text
   * @param {string} [kind]
   * @param {{ href: string, text: string } | null} [link]
   */
  const say = (text, kind = '', link = null) => {
    notice.replaceChildren()
    if (text) {
      notice.append(text)
      if (link) {
        const anchor = document.createElement('a')
        anchor.href = link.href
        anchor.target = '_top'
        anchor.rel = 'noopener'
        anchor.textContent = link.text
        notice.append(' ', anchor, '.')
      }
    }
    notice.className = `notice ${kind}`.trim()
    notice.hidden = !text
    requestAnimationFrame(announce)
  }

  /**
   * @param {string} text
   * @param {string} [code]
   */
  const refuse = (text, code = 'refused') => {
    loader.hidden = true
    say(text, 'error')
    post({ context: 'h5p-offline-player', action: 'error', code, message: text })
  }

  /* ---------------------------------------------------------------- sizing, upward */

  /**
   * A message to the page that frames this one: the height as h5p-resizer.js expects, and `report`,
   * `error` and `xapi` in this page's own. To any parent unless a target is set: nothing secret.
   * @param {object} message
   * @param {string} [target]
   */
  const post = (message, target = '*') => {
    if (framed) window.parent.postMessage(message, target)
  }

  // The body's own height rather than the document's scrollHeight: the latter can never report
  // less than the frame, so a shrink would never be seen.
  const contentHeight = () => Math.ceil(document.body.getBoundingClientRect().height)

  const announce = () => post({ context: 'h5p', action: 'resize', scrollHeight: contentHeight() })

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || !event.data || event.data.context !== 'h5p') return
    switch (event.data.action) {
      case 'ready':
        // h5p-resizer.js announces itself once it is on the page; it expects a `hello` back.
        post({ context: 'h5p', action: 'hello' })
        break
      case 'hello':
        announce()
        break
      case 'resizePrepared':
        announce()
        break
    }
  })

  post({ context: 'h5p', action: 'hello' })

  // The element dispatches `resize` before it applies the height to itself; measure after layout.
  player.addEventListener('resize', () => requestAnimationFrame(announce))
  player.addEventListener('ready', () => requestAnimationFrame(announce))

  /* ---------------------------------------------------------------- the report, upward */

  /**
   * What the player learnt about the package, posted once when the content is up, to any parent as
   * it named the package. The shapes are an interface a preview builds on: a field is only added.
   */
  let startedAt = 0

  player.addEventListener('ready', (event) => {
    const { source, metadata, libraryBundle, downgradedLibraries } = /** @type {CustomEvent<ReadyDetail>} */ (event).detail
    post({
      context: 'h5p-offline-player',
      action: 'report',
      source: source && { type: source.type, size: source.size },
      metadata: metadata && {
        title: metadata.title,
        license: metadata.license,
        licenseVersion: metadata.licenseVersion,
        authors: metadata.authors?.map(({ name }) => name),
        mainLibrary: metadata.mainLibrary
      },
      libraryBundle,
      // Absent from an element older than the page's own; this page and the element ship together.
      downgradedLibraries: downgradedLibraries ?? [],
      elapsedMs: Math.round(performance.now() - startedAt)
    })
  })

  /* ---------------------------------------------------------------- xAPI, relayed on request */

  /**
   * An origin, or nothing: the parameter has to be exactly what `event.origin` will read.
   * @param {string | null} value
   */
  const originOf = (value) => {
    if (!value) return null
    try {
      const origin = new URL(value).origin
      return origin !== 'null' && origin === value.replace(/\/$/, '') ? origin : null
    } catch {
      return null
    }
  }

  const relayTo = originOf(params.get('xapi'))
  if (relayTo && framed) {
    for (const type of ['xapi', 'finished']) {
      player.addEventListener(type, (event) => {
        post({ context: 'h5p-offline-player', action: type, .../** @type {CustomEvent<object>} */ (event).detail }, relayTo)
      })
    }
  }

  /* ---------------------------------------------------------------- errors, and Safari */

  /**
   * Asks whether to play an untrusted package with its own code; set when one is played so.
   * @type {(() => void) | null}
   */
  let askToTrust = null

  player.addEventListener('error', (event) => {
    // The element's own `error`, which the DOM's types take for a script's `ErrorEvent`.
    const { code, message, missingLibraries } = /** @type {CustomEvent<PlayerErrorDetail>} */ (/** @type {unknown} */ (event)).detail
    // Played untrusted, it cannot do without its own copy of a library: a click decides.
    if (missingLibraries?.carried && player.untrusted && askToTrust) {
      askToTrust()
      return
    }
    if (code === 'no-worker' && framed) {
      // Detected, not sniffed: a browser, an in-app one or a page that is not https may give a
      // frame no Service Worker, and the player cannot run without one. Safari does allow it.
      say("This browser does not run the player inside another site's page.", 'error', {
        href: location.href,
        text: 'Open it on its own'
      })
      post({ context: 'h5p-offline-player', action: 'error', code, message })
      return
    }
    // Once the content is up, a runtime error inside it is the content's business: it keeps
    // running, and a red notice over a working video would say otherwise.
    if (code === 'runtime' && player.state === 'ready') {
      console.warn(`h5p-player: the content reported an error and kept running: ${message}`)
      return
    }
    say(message || code, 'error')
    post({ context: 'h5p-offline-player', action: 'error', code, message })
  })

  player.addEventListener('statechange', (event) => {
    const { state } = /** @type {CustomEvent<PlayerStateChangeDetail>} */ (event).detail
    if (state !== 'error') say('')
    // Shown from the HTML on, until the content is up or the load has failed.
    loader.hidden = state === 'ready' || state === 'error' || state === 'idle'
    requestAnimationFrame(announce)
  })

  /* ---------------------------------------------------------------- which hosts */

  /**
   * The origin of a URL as this page resolves it, or `null` for what is not one.
   * @param {string} value
   */
  const urlOrigin = (value) => {
    try {
      const url = new URL(value, location.href)
      // A `data:` or `blob:` URL has an opaque origin: name its scheme, so it is never "ours".
      return url.origin === 'null' ? url.protocol : url.origin
    } catch {
      return null
    }
  }

  /**
   * A package's address as the element is given it: resolved against this page, only if `http` or
   * `https`, as the parsed `href`, never the text, so `src` holds what was checked.
   * @param {string} value
   */
  const packageUrl = (value) => {
    try {
      const url = new URL(value, location.href)
      return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
    } catch {
      return null
    }
  }

  const allowed = packages ? new Set(packages) : null
  /**
   * Whether this player was told it may fetch from `origin`. Always true without a list.
   * @param {string} origin
   */
  const permitted = (origin) => origin === location.origin || !allowed || allowed.has(origin)

  /**
   * The `libraries` value with `pack` resolved to this site's copy, or an error to show. With a
   * host list every bundle's origin must be on it; the CSP says it too, this puts it in words.
   * @param {string} value
   * @returns {{ value?: string, error?: string }}
   */
  const librarySources = (value) => {
    /** @type {string[]} */
    const sources = []
    if (value === 'none') return { value: '' }
    for (const token of value.split(/\s+/).filter(Boolean)) {
      if (token === 'pack') {
        // This site's copy of the pack, else the element's on jsDelivr where that may be reached,
        // so a snippet written for `pack` keeps playing after a rebuild with --no-libraries.
        if (ownPack || (!librariesPack && permitted(PACK_CDN_ORIGIN))) sources.push('pack')
        else if (librariesPack) sources.push(librariesPack)
        else return { error: 'This player was set up without the library pack, so libraries=pack is not available here.' }
      } else {
        const origin = urlOrigin(token)
        if (!origin || !permitted(origin)) return { error: `This player does not fetch libraries from ${origin ?? token}.` }
        sources.push(token)
      }
    }
    return { value: [...new Set(sources)].join(' ') }
  }

  /**
   * The element's display options, by attribute name, for the embedding page to ask for. Not
   * `custom-js`, `embed-code` or `user`: a link should not hand out a script, nor a learner's name.
   */
  const applyOptions = () => {
    for (const name of ['frame', 'copyright', 'export', 'icon', 'reporting']) {
      if (params.has(name) && params.get(name) !== 'off') player.setAttribute(name, '')
    }
    if (params.get('fullscreen') === 'off') player.setAttribute('fullscreen', 'off')
    // The pack's newer versions of the libraries a package carries, unless the embedding page
    // needs the package exactly as exported.
    if (params.get('refresh-libraries') === 'off') player.setAttribute('refresh-libraries', 'off')
    // Content made for a newer version than any source has plays at the older one, unless the
    // embedding page would rather have it refused.
    if (params.get('downgrade-libraries') === 'off') player.setAttribute('downgrade-libraries', 'off')
    for (const name of ['activity-id', 'custom-css']) {
      const value = params.get(name)?.trim()
      if (value) player.setAttribute(name, value)
    }
    const lang = params.get('lang')?.trim().replaceAll('_', '-')
    if (lang && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(lang)) player.setAttribute('lang', lang)
  }

  /**
   * @param {string} value
   * @param {string | undefined} libraries
   */
  const start = (value, libraries) => {
    if (libraries) player.setAttribute('libraries', libraries)
    if (params.get('preload') === 'auto') player.setAttribute('preload', 'auto')
    applyOptions()
    startedAt = performance.now()
    player.setAttribute('src', value)
  }

  /**
   * Whether this document's storage is this origin's own: top level, or framed by this origin. In
   * another site's frame it is partitioned by that site, so scripts reach only what it played.
   */
  const sharesOriginStorage = () => {
    if (!framed) return true
    // Treated as another site's frame: the page around it chose this package, so no click.
    if (!askInOwnFrame) return false
    try {
      return window.parent.location.origin === location.origin
    } catch {
      return false // Another origin's frame: reading its location throws, and the storage is partitioned.
    }
  }

  /* ---------------------------------------------------------------- load */

  const src = params.get('src')?.trim()
  if (!src) {
    refuse('No package given. Add ?src=<url of a .h5p file> to the address.', 'no-src')
    return
  }
  const address = packageUrl(src)
  if (!address) {
    refuse('The package address is not an http or https URL.')
    return
  }
  const { origin } = address
  if (!permitted(origin)) {
    refuse(`This player does not play packages from ${origin}.`)
    return
  }
  // The address's own value wins, `none` included; an address without one gets the page's default.
  const libraries = params.get('libraries')?.trim() || defaultLibraries?.trim()
  const sources = libraries ? librarySources(libraries) : { value: '' }
  if (sources.error) {
    refuse(sources.error)
    return
  }

  // A host on the list was vouched for when the site was set up, and in another site's frame the
  // storage is that site's own: those play as they are.
  if (origin === location.origin || allowed || !sharesOriginStorage()) {
    start(address.href, sources.value)
    return
  }

  // Another origin's package would share this origin's storage: it plays untrusted, as data with
  // pack's code, and asks for a click only when it needs its own code or there is no pack.
  const { host } = address
  askToTrust = () => {
    loader.hidden = true
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = 'Open with its own scripts'
    button.addEventListener('click', () => {
      say('')
      loader.hidden = false
      player.untrusted = false
      player.removeAttribute('src')
      start(address.href, sources.value)
    })
    say(
      `This package from ${host} plays only with its own scripts. They would run on this site and ` +
        'could read what other packages saved in this browser. Open it only if you trust that site.'
    )
    notice.append(' ', button)
  }
  // The address's `libraries=` is the link-writer's, and a bundle's code runs as the host's own, so
  // an untrusted package plays with this site's sources alone until the click has trusted it.
  const own = defaultLibraries?.trim() ? librarySources(defaultLibraries.trim()).value : ''
  const sitesSources = own || librarySources('pack').value
  if (!sitesSources) {
    askToTrust()
    return
  }
  player.untrusted = true
  start(address.href, sitesSources)
}
