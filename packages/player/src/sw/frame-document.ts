import { randomHex } from '../shared/pkg-id.js'
import type { FrameAssets, FrameFont, FrameOptions } from '../shared/protocol.js'
import { contentMetadata, type ContentMetadata } from '../shared/metadata.js'
import { isEnglish, LANGUAGE_TAG } from '../shared/language.js'

/**
 * The frame document, generated per request: H5P core assumes it owns the page, so it gets one of
 * its own. `html.h5p-iframe` is set because the core's stylesheet keys its rules on it.
 */

/**
 * Origins real content types reach at runtime, by directive. Written without a scheme so the page's
 * own applies: WebFont builds its URL from `location.protocol`, and `https:` would block localhost.
 */
const RUNTIME_ALLOWLIST = {
  script: [
    // MathJax, for H5P.MathDisplay.
    'cdn.jsdelivr.net',
    'cdnjs.cloudflare.com',
    // Google's WebFont loader.
    'ajax.googleapis.com',
    // Video providers H5P.Video has a handler for: each loads a player API here, then its player in
    // an iframe, which `frame-src *` covers. Echo360 needs no script.
    'www.youtube.com',
    'player.vimeo.com',
    'developers.panopto.com'
  ],
  style: ['fonts.googleapis.com'],
  font: ['fonts.gstatic.com', 'fonts.googleapis.com'],
  // By path, since one endpoint is all it needs: Vimeo's SDK reads the video's oEmbed record before
  // it can build the player (*The frame CSP's runtime allowlist is written without schemes*).
  connect: ['vimeo.com/api/oembed.json'],
  // TimelineJS (H5P.Timeline) fetches a slide's media as JSONP, a `<script>` naming the endpoint,
  // so these are script sources in both policies. Its Twitter, Storify and Vine endpoints are dead.
  jsonp: ['*.wikipedia.org/w/api.php', 'vimeo.com/api/v2/video/', 'soundcloud.com/oembed', 'api.flickr.com/services/rest/']
} as const

/**
 * The header the boot script (0.2 and later) asks for an untrusted package's `content.json` with,
 * `semantics` as value, to check it against the libraries' semantics; the worker serves no other.
 */
export const CONTENT_CHECK_HEADER = 'x-h5p-content-check'

/**
 * The video players' APIs an `untrusted` frame may load, by exact path: a whole host would let
 * markup a package injects load any script it serves, as a CDN serving all of npm does.
 */
const UNTRUSTED_SCRIPT_PATHS = [
  'https://www.youtube.com/iframe_api',
  'https://www.youtube.com/s/player/',
  'https://player.vimeo.com/api/player.js',
  'https://developers.panopto.com/scripts/'
]

/**
 * A CSP host-source and nothing else: a value with a `;` or a quote would append directives of its
 * own, so anything not plainly a host is dropped.
 */
const HOST_SOURCE = /^(?:(?:https?|wss?):\/\/)?(?:\*\.)?[a-z0-9.-]+(?::\d+)?$/i

export function sanitizeOrigins(values: readonly string[] | undefined): string[] {
  if (!values) return []
  return [...new Set(values.map((value) => value.trim()).filter((value) => HOST_SOURCE.test(value)))]
}

export interface FrameDocumentOptions {
  pkgId: string
  /** Absolute URL of the package root on the virtual file server, without a trailing slash. */
  virtualRoot: string
  /** Absolute URL of the load's `boot` route, where a runtime after 0.2 asks what to load. */
  bootUrl: string
  assets: FrameAssets
  nonce: string
  title?: string
  /** The manifest's metadata, for the runtime's copyright dialog and the statements' object name. */
  metadata?: ContentMetadata
  /**
   * Extra origins the host vouches for, for content that reaches somewhere this package cannot
   * know about — a tenant's own Panopto or Echo360 host, an in-house CDN.
   */
  allowOrigins?: string[]
  /** What the host asked the frame to show and load; see `FrameOptions`. */
  frameOptions?: FrameOptions
  /**
   * The library folders with an `upgrades.js`, for content written for an older minor than the one
   * served: a runtime up to 0.2 reads it here, a later one from the `boot` route.
   */
  upgrades?: string[]
  /** The language tag the element was in: the frame's, for a package that names none of its own. */
  language?: string
  /** Played as data: scripts by exact path only. See `untrustedScriptSources`. */
  untrusted?: boolean
  /** The URL of the worker serving the frame, which Firefox checks a script it made up against. */
  workerScript?: string
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * The frame's boot script is a runtime package file, so it ships with the core under its licence.
 * A record from before 0.5 has no `bootJs`: the file sits beside `main.bundle.js` in every layout.
 */
export function bootScriptUrl(assets: FrameAssets): string {
  if (assets.bootJs) return assets.bootJs
  try {
    return new URL('frame-boot.js', assets.mainJs ?? '').href
  } catch {
    // A `mainJs` that is not a URL has no sibling to resolve; the bare name is left to the frame's
    // own base, as a record from before 0.5 would have resolved it.
    return 'frame-boot.js'
  }
}

/** A tag from a record, which came back from IndexedDB: held to a tag's shape, `und` read as none. */
function recordedTag(value: unknown): string | undefined {
  return typeof value === 'string' && LANGUAGE_TAG.test(value) && value.toLowerCase() !== 'und' ? value : undefined
}

/**
 * The frame speaks the content's language, so H5P's buttons match: `h5p.json`'s `defaultLanguage`,
 * else the element's, else English (#55: the strings once followed the element, not the content).
 */
function frameLanguage(options: Pick<FrameDocumentOptions, 'metadata' | 'language'>): string {
  return recordedTag(options.metadata?.defaultLanguage) ?? recordedTag(options.language) ?? 'en'
}

/**
 * The runtime's `l10n.js`, which the boot script picks the core's strings from, in any language but
 * English. The URL came from IndexedDB, so it must be http(s); an older record has none: English.
 */
function l10nScriptUrl(assets: FrameAssets, language: string): string | undefined {
  if (isEnglish(language)) return undefined
  return customUrls(typeof assets.l10nJs === 'string' ? [assets.l10nJs] : [])[0]
}

/** Origins that appear in a CSP directive, deduplicated. `'self'` covers same-origin assets. */
function assetOrigins(assets: FrameAssets, base: string, language: string): string[] {
  const origins = new Set<string>()
  const strings = l10nScriptUrl(assets, language)
  const urls = [
    ...(assets.mainJs ? [assets.mainJs] : []),
    assets.frameJs,
    assets.frameCss,
    bootScriptUrl(assets),
    ...(assets.fonts ?? []).map((font) => font.url),
    ...(strings ? [strings] : [])
  ]
  for (const url of urls) {
    try {
      const origin = new URL(url, base).origin
      if (origin !== new URL(base).origin) origins.add(origin)
    } catch {
      // An unparseable asset URL is left out of the policy; the load then fails visibly.
    }
  }
  return [...origins]
}

/**
 * `@font-face` rules for the faces `sync-h5p-assets.mjs` took from the core sheet, so only used
 * ones load. Values come from IndexedDB: a misfit is dropped, a parsed `href` cannot leave `url()`.
 */
export function fontFaceRules(fonts: readonly FrameFont[] | undefined): string {
  if (!fonts) return ''
  return fonts
    .flatMap(({ family, style, weight, url }) => {
      if (!/^[A-Za-z][A-Za-z0-9 -]*$/.test(family) || !/^(normal|italic)$/.test(style) || !/^\d{3}$/.test(weight)) {
        return []
      }
      let href: string
      try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return []
        href = parsed.href
      } catch {
        return []
      }
      return [
        `  @font-face { font-display: swap; font-family: '${family}'; font-style: ${style}; font-weight: ${weight}; src: url("${href}") format('woff2'); }`
      ]
    })
    .join('\n')
}

/**
 * The host's own stylesheets and scripts, held to what the element writes: absolute http(s) URLs.
 * They come from IndexedDB like the fonts, so anything else is dropped rather than written in.
 */
function customUrls(urls: readonly string[] | undefined): string[] {
  return (urls ?? []).flatMap((url) => {
    try {
      const parsed = new URL(url)
      return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? [parsed.href] : []
    } catch {
      return []
    }
  })
}

/** The origins of those URLs that are not the frame's own, for the directive each kind loads under. */
function customOrigins(urls: readonly string[], base: string): string[] {
  const own = new URL(base).origin
  return [...new Set(urls.map((url) => new URL(url).origin).filter((origin) => origin !== own))]
}

/**
 * The options as the boot script may see them: each value checked for its type, the URLs for
 * their shape, so a record from an older or a tampered store cannot hand the runtime a surprise.
 */
function sanitizeFrameOptions(options: FrameOptions | undefined): FrameOptions | undefined {
  if (!options) return undefined
  const out: FrameOptions = {}
  for (const flag of ['frame', 'copyright', 'export', 'icon', 'embed', 'fullScreen', 'reportingIsEnabled'] as const) {
    if (typeof options[flag] === 'boolean') out[flag] = options[flag]
  }
  for (const text of ['embedCode', 'resizeCode', 'activityId'] as const) {
    if (typeof options[text] === 'string' && options[text]) out[text] = options[text]
  }
  const [downloadUrl] = customUrls(options.downloadUrl ? [options.downloadUrl] : [])
  if (downloadUrl) out.downloadUrl = downloadUrl
  const customCss = customUrls(options.customCss)
  if (customCss.length) out.customCss = customCss
  const customJs = customUrls(options.customJs)
  if (customJs.length) out.customJs = customJs
  return Object.keys(out).length ? out : undefined
}

/**
 * Where an `untrusted` frame loads scripts: its package path, the runtime's files and `custom-js`
 * by exact URL, and the video APIs. Not `'self'`: injected markup could load any host script.
 */
function untrustedScriptSources(options: FrameDocumentOptions): string[] {
  const strings = l10nScriptUrl(options.assets, frameLanguage(options))
  const files = [
    ...(options.assets.mainJs ? [options.assets.mainJs] : []),
    options.assets.frameJs,
    bootScriptUrl(options.assets),
    ...(strings ? [strings] : []),
    ...customUrls(options.frameOptions?.customJs),
    ...(options.workerScript ? [options.workerScript] : [])
  ]
  return [pathSource(`${options.virtualRoot}/`, options.virtualRoot), ...files.map((url) => pathSource(url, options.virtualRoot)), ...UNTRUSTED_SCRIPT_PATHS, ...RUNTIME_ALLOWLIST.jsonp].filter(
    (source): source is string => source !== null
  )
}

/**
 * A URL as a CSP source by path (a source takes no query), with `;` and `,` percent-encoded so it
 * cannot end the directive or policy; browsers decode before comparing. `null` if not http(s).
 */
function pathSource(url: string, base: string): string | null {
  try {
    const parsed = new URL(url, base)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return `${parsed.origin}${parsed.pathname.replaceAll(';', '%3B').replaceAll(',', '%2C')}`
  } catch {
    return null
  }
}

export function buildContentSecurityPolicy(options: FrameDocumentOptions): string {
  const origins = assetOrigins(options.assets, options.virtualRoot, frameLanguage(options))
  const extra = sanitizeOrigins(options.allowOrigins)
  // The host's own stylesheets and scripts are the host's choice, like `assets-base`: their
  // origins join the directive they load under without an `allow-origins` entry.
  const customCss = customOrigins(customUrls(options.frameOptions?.customCss), options.virtualRoot)
  const customJs = customOrigins(customUrls(options.frameOptions?.customJs), options.virtualRoot)
  const directive = (name: string, ...sources: string[]) =>
    `${name} ${sources.filter(Boolean).join(' ')}`

  return [
    `default-src 'self'`,
    directive(
      'script-src',
      ...(options.untrusted ? untrustedScriptSources(options) : ["'self'", ...origins, ...customJs, ...RUNTIME_ALLOWLIST.script, ...RUNTIME_ALLOWLIST.jsonp]),
      ...extra,
      `'nonce-${options.nonce}'`,
      // EmbeddedJS compiles templates with `eval`: board games and older question sets need it.
      // It adds no reach, as the archive's own scripts already run under `'self'`.
      "'unsafe-eval'"
    ),
    // CKEditor-authored text carries `style="…"` on nearly every field, so inline styles cannot
    // be refused without breaking the majority of real content.
    directive(
      'style-src',
      "'self'",
      ...origins,
      ...customCss,
      ...RUNTIME_ALLOWLIST.style,
      ...extra,
      "'unsafe-inline'"
    ),
    directive('font-src', "'self'", ...origins, ...RUNTIME_ALLOWLIST.font, ...extra, 'data:'),
    // Left open: content types embed YouTube, Vimeo and externally hosted media.
    `img-src * data: blob:`,
    `media-src * data: blob:`,
    `frame-src *`,
    // Narrow on purpose: the few types fetching remote data (subtitles, JSON) are blocked. Vimeo's
    // oEmbed record is the exception, since nothing of Vimeo's plays without it.
    directive('connect-src', "'self'", ...RUNTIME_ALLOWLIST.connect, ...extra),
    `worker-src 'self' blob:`,
    `object-src 'none'`,
    // `'self'`, not `'none'`: H5P sets a `<base>` to the frame's URL, and refusing it logs an error
    // on every load. Same-origin still stops a script repointing relative URLs at another origin.
    `base-uri 'self'`,
    `form-action 'none'`
  ].join('; ')
}

export function buildFrameDocument(options: FrameDocumentOptions): string {
  const { pkgId, virtualRoot, assets, nonce } = options
  const csp = buildContentSecurityPolicy(options)
  const language = frameLanguage(options)
  const l10nJs = l10nScriptUrl(assets, language)

  // Up to runtime 0.2, `main.bundle.js` loads before the boot script and `upgrades` ride here.
  // `boot` is in every document: a page open across an upgrade runs the new script, which needs it.
  const loader = assets.mainJs

  // A JSON block, not a script: data needs no nonce, so `frame-boot.js` is the same bytes for every
  // package. `<` is escaped so no value can end the block early.
  const bootConfig = JSON.stringify({
    pkgId,
    h5pJsonPath: virtualRoot,
    boot: options.bootUrl,
    frameJs: assets.frameJs,
    frameCss: assets.frameCss,
    title: options.title,
    // Checked again on the way out, as the options are: the record came back from IndexedDB.
    metadata: contentMetadata(options.metadata),
    options: sanitizeFrameOptions(options.frameOptions),
    upgrades: loader ? options.upgrades : undefined,
    // What the boot script picks H5P's own strings by, when it has the runtime's translations.
    language: l10nJs ? language : undefined,
    // The boot script checks the content against its libraries' semantics, and asks for it with
    // `CONTENT_CHECK_HEADER`, which is how the worker knows it will.
    untrusted: options.untrusted || undefined
  }).replaceAll('<', '\\u003c')

  const fontFaces = fontFaceRules(assets.fonts)
  // The core's strings in every language the runtime has, left on `window` for the boot script to
  // pick from, so this loads before it.
  const strings = l10nJs ? `<script nonce="${nonce}" src="${escapeHtml(l10nJs)}" charset="UTF-8"></script>\n` : ''
  const legacyLoader = loader ? `<script nonce="${nonce}" src="${escapeHtml(loader)}" charset="UTF-8"></script>\n` : ''

  // The YouTube rule is for H5P.Video's handler: its `player.g.style = …` throws up to 1.6.66
  // (field renamed), leaving a black picture with sound; 1.6.80 sets the same styles itself.
  return `<!DOCTYPE html>
<html lang="${escapeHtml(language)}" class="h5p-iframe">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
<title>${escapeHtml(options.title ?? 'H5P content')}</title>
<style nonce="${nonce}">
  html, body { background: transparent; }
  body { overflow-x: hidden; }
  #h5p-root { width: 100%; }
  .h5p-video.h5p-youtube iframe { position: absolute; top: 0; left: 0; width: 100%; height: 100%; }
${fontFaces}
</style>
</head>
<body>
<div id="h5p-root"></div>
${legacyLoader}${strings}<script type="application/json" id="h5p-boot-config">${bootConfig}</script>
<script nonce="${nonce}" src="${escapeHtml(bootScriptUrl(assets))}"></script>
</body>
</html>`
}

/** A fresh nonce per response: reusing one across responses would defeat the point of having it. */
export function createNonce(): string {
  return randomHex(16)
}
