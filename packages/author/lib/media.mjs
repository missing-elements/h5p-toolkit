import { mp4Info } from '@missing-elements/h5p-normalize/mp4'
import { escapeText } from './text.mjs'

/**
 * The files content shows, copied into `content/` with what H5P records of each; a video on
 * YouTube, Vimeo, Panopto or Echo360 stays an address, as the editor embeds it (`linked`: #263).
 */

/** The types H5P accepts for content (`H5PCore::$defaultContentWhitelist`), by what a field takes. */
const TYPES = {
  image: { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp' },
  video: { mp4: 'video/mp4', webm: 'video/webm', ogg: 'video/ogg' },
  audio: { mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', webm: 'audio/webm' },
  file: {
    pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', vtt: 'text/vtt', webvtt: 'text/vtt', rtf: 'application/rtf',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', mp3: 'audio/mpeg', mp4: 'video/mp4', json: 'application/json'
  }
}

/** The folder under `content/` H5P's editor keeps each kind in (h5peditor-file.class.php). */
const FOLDERS = { image: 'images', video: 'videos', audio: 'audios', file: 'files' }

/** The containers a video and a recording come in, among H5P's types, and how to name them. */
const PLAYS = {
  video: { takes: ['mp4', 'webm', 'ogg'], what: 'an MP4, WebM or Ogg video' },
  audio: { takes: ['mp3', 'mp4', 'wav', 'ogg', 'webm'], what: 'an MP3, M4A, WAV, Ogg or WebM recording' }
}

/** Codecs of an mp4's picture that not every browser plays, by the name its index gives them. */
const NOT_EVERYWHERE = /** @type {Record<string, string>} */ ({ hvc1: 'HEVC (H.265)', hev1: 'HEVC (H.265)' })

/** Whether a host name is one of these domains or under one. @param {string} host @param {string[]} domains */
const under = (host, domains) => domains.some((domain) => host === domain || host.endsWith(`.${domain}`))

/**
 * Video a host plays itself, embedded by address: `plays` takes only what H5P.Video 1.6's pattern
 * takes, as it gives any other to its HTML5 player, which cannot play a page.
 * @type {{ host: string, mime: string, plays: RegExp, on: (url: URL) => boolean, form: string, oembed?: (address: string) => string, sends?: { type: string, body: (status: number) => string }, answers?: Record<number, { gone?: string, closed?: string }>, length?: (answer: any) => number | undefined }[]}
 */
const HOSTED = [
  {
    host: 'Vimeo',
    mime: 'video/Vimeo',
    plays: /^https?:\/\/(?:[\w-]+\.)*vimeo\.com\/(?:channels\/[A-Za-z_]+\/|groups\/[A-Za-z_]+\/videos\/)?\d/,
    on: (url) => under(url.hostname, ['vimeo.com']),
    form: 'https://vimeo.com/ and the video\'s number',
    // Every form it plays, a channel's and a group's too, and an unlisted video's with its hash.
    oembed: (address) => `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(address)}`,
    // Its 404 is a page of the words alone.
    sends: { type: 'text/html', body: (status) => `${status} ${STATUS_WORDS[status]}` },
    // 404: no such video, a private one, or an unlisted one without its full link (Vimeo's help). A
    // password or domain limit answers 200; a 403 is Vimeo refusing the network.
    answers: {
      404: { gone: 'has no video there that others can play: give https://vimeo.com/ and the number of a public video, or all of an unlisted video\'s link, which has more after the number' }
    },
    // Its own answer names it, and a video being made ready has no length yet.
    length: (answer) => (answer?.provider_name === 'Vimeo' && Number.isFinite(answer.duration) && answer.duration > 0 ? answer.duration : undefined)
  },
  {
    host: 'YouTube',
    mime: 'video/YouTube',
    plays: /^https?:\/\/(?:[\w-]+\.)*(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|embed\/|v\/)|youtu\.be\/)[\w-]{11}/i,
    on: (url) => under(url.hostname, ['youtube.com', 'youtube-nocookie.com', 'youtu.be']),
    form: 'https://www.youtube.com/watch?v= and the video\'s id',
    // Asked by its watch address: YouTube's oEmbed answers 404 for /embed/ and /v/ addresses of a
    // video it has (2026-11-20).
    oembed: (address) => {
      const id = YOUTUBE_ID.exec(address)?.[1]
      return id ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}` : ''
    },
    // The status's words alone, under the type of the answer it would have given.
    sends: { type: 'application/json', body: (status) => STATUS_WORDS[status] },
    // Seen: 400 for an id it never had, 404 for a taken-down video, 403 for a private one, 200 for
    // an age-gated one. 401 not seen: said to be embedding turned off.
    answers: {
      400: { gone: 'has no video there: give https://www.youtube.com/watch?v= and the id of a public or unlisted video' },
      404: { gone: 'has no video there any more: give https://www.youtube.com/watch?v= and the id of a public or unlisted video' },
      403: { closed: 'says the video is private: nobody but its owner can play it until it is made public or unlisted' },
      401: { closed: 'would not say the video may be embedded, which is taken to mean its owner has turned embedding off: play it where it will be used' }
    }
  },
  {
    host: 'Panopto',
    mime: 'video/Panopto',
    plays: /^https?:\/\/[^/\s]+\/Panopto\/[^?\s]+\?id=\S+$/,
    on: (url) => under(url.hostname, ['panopto.com', 'panopto.eu']) || url.pathname.toLowerCase().startsWith('/panopto/'),
    form: 'the viewer\'s, …/Panopto/Pages/Viewer.aspx?id= and the session\'s id'
  },
  {
    host: 'Echo360',
    mime: 'video/Echo360',
    plays: /^https?:\/\/echo360[^/\s]+\/media\/[^/\s]+\/h5p(?:[/?#]\S*)?$/i,
    on: (url) => url.hostname.split('.').some((label) => label.startsWith('echo360')),
    form: 'its H5P address, https://echo360.org/media/, the media\'s id and /h5p'
  }
]

/** A YouTube video's id, in an address H5P.Video plays. */
const YOUTUBE_ID = /(?:[?&]v=|\/embed\/|\/v\/|youtu\.be\/)([\w-]{11})/i

/** How long a host may take to say whether it has a video, before the build goes on without it. */
const ASK_MS = 10_000

/**
 * A status's words, which YouTube and Vimeo send alone with an answer that is no video (`sends`). A
 * proxy, a filter or Vimeo refusing a network answers otherwise.
 */
const STATUS_WORDS = /** @type {Record<number, string>} */ ({ 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found' })

/** A YouTube Short or live stream, by its video's id, which H5P.Video plays at the watch address. */
const YOUTUBE_SHORT = /^https?:\/\/(?:[\w-]+\.)*youtube\.com\/(?:shorts|live)\/([\w-]{11})(?![\w-])/i

/** The licences a file's copyright may name, as H5P lists them. */
const COPYRIGHT_LICENSES = ['U', 'CC BY', 'CC BY-SA', 'CC BY-ND', 'CC BY-NC', 'CC BY-NC-SA', 'CC BY-NC-ND', 'GNU GPL', 'PD', 'C']

/** The parts of a file's copyright a source writes, as H5P records them. */
const COPYRIGHT_FIELDS = ['license', 'author', 'title', 'year', 'source', 'version']

/** A file's copyright source as H5P's editor takes it, and a build: a web address. */
const COPYRIGHT_SOURCE = /^https?:\/\/.+/i

/**
 * A saved file's copyright as a source writes it (#236): parts with text, none for the licence "U"
 * alone. The editor saves empty parts, which a build refuses: they are left out, `left` told.
 * @param {unknown} copyright
 * @param {(key: 'license' | 'source', value: string) => void} [left]
 * @returns {Record<string, string> | undefined}
 * @internal
 */
export function writtenCopyright(copyright, left = () => {}) {
  if (!copyright || typeof copyright !== 'object' || Array.isArray(copyright)) return undefined
  const parts = Object.entries(copyright).filter(([key, value]) => COPYRIGHT_FIELDS.includes(key) && typeof value === 'string' && value.trim() !== '')
  const license = parts.find(([key]) => key === 'license')?.[1]
  const listed = license === undefined || COPYRIGHT_LICENSES.includes(license)
  if (!listed) left('license', license)
  const source = parts.find(([key]) => key === 'source')?.[1]
  if (source !== undefined && !COPYRIGHT_SOURCE.test(source)) left('source', source)
  const kept = Object.fromEntries(parts.filter(([key, value]) => key === 'source' ? COPYRIGHT_SOURCE.test(value) : listed || (key !== 'license' && key !== 'version')))
  return Object.entries(kept).some(([key, value]) => key !== 'license' || value !== 'U') ? kept : undefined
}

/** The most a download may bring: a package of this size is already past what a learner waits for. */
const MAX_DOWNLOAD = 1024 ** 3

/**
 * How long a download may go without a byte before it is given up. Not a bound on the whole: a
 * large video over a slow link takes as long as it takes, and only a silent one is dead.
 */
const IDLE_MS = 60_000

/**
 * @template F
 * @typedef {{ name: string, from: F }} StagedFile a file to add to the package: its name under `content/`, and where its bytes are
 * @typedef {{ path: string, message: string }} Problem
 */

/**
 * @typedef {{ file: string, seconds: number, host?: string }} MediaLength a video's or recording's
 *   length: `file` as the source names it, `seconds` from its index or its `host`
 * @typedef {{
 *   source: string, kind?: 'image' | 'video' | 'audio', format?: string, width?: number, height?: number,
 *   seconds?: number, host?: string, notes: string[], problem?: string
 * }} MediaFacts what a file is (`MediaStore.describe`), with a `problem` if no source can name it
 */

/**
 * Where a build's files are, and where a download is kept, which differ between Node and a page.
 * @template F a kept file: a path on disk, or a `Blob`
 * @typedef {{
 *   what: string,
 *   name(source: string): string,
 *   local(source: string): Promise<{ file: F } | { missing: string }>,
 *   keep(body: ReadableStream<Uint8Array>, extension: string): Promise<F>,
 *   open(file: F): Promise<{ size: number, read(offset: number, length: number): Promise<Uint8Array>, close(): Promise<void> }>,
 *   linked?(source: string): string | undefined,
 *   unread?: boolean
 * }} MediaAccess
 *   `linked`: where a file stays and plays from (#263). `unread`: judged by name, none read (#270).
 */

/**
 * A file name's extension, lowercased, as Node's `extname` takes it: none for a name that only
 * starts with a dot.
 * @param {string} name
 */
function extensionOf(name) {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/**
 * A URL's path decoded, or as written where an escape in it is not one, `%zz`: a name to keep,
 * which nothing is gained by refusing.
 * @param {string} path
 */
function decoded(path) {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

/**
 * A path's last segment, past any slash it ends with, as Node's `basename` takes it.
 * @param {string} path
 */
function lastSegment(path) {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

/**
 * An image's width and height from its header: PNG, JPEG, GIF, BMP. A JPEG's are in its frame
 * header, past any number of segments (a colour profile, XMP), so they are walked by length.
 * @param {(offset: number, length: number) => Promise<Uint8Array>} read the file's bytes from an offset, fewer at its end
 * @returns {Promise<{ width: number, height: number } | null>}
 * @internal
 */
export async function imageSize(read) {
  const head = await read(0, 26)
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
  const ascii = (/** @type {number} */ offset, /** @type {number} */ length) => String.fromCharCode(...head.subarray(offset, offset + length))
  if (head.length >= 24 && ascii(1, 3) === 'PNG' && ascii(12, 4) === 'IHDR') return { width: view.getUint32(16), height: view.getUint32(20) }
  if (head.length >= 10 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
  if (head.length >= 26 && ascii(0, 2) === 'BM') return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) }
  if (head.length < 4 || head[0] !== 0xff || head[1] !== 0xd8) return null
  let offset = 2
  // A bound on the walk, far past the few dozen segments a camera or an editor writes.
  for (let steps = 0; steps < 10_000; steps++) {
    const segment = await read(offset, 9)
    if (segment.length < 4 || segment[0] !== 0xff) return null
    const marker = segment[1]
    // Fill before a marker.
    if (marker === 0xff) {
      offset += 1
      continue
    }
    const header = new DataView(segment.buffer, segment.byteOffset, segment.byteLength)
    // A start-of-frame marker, baseline to lossless, holds the size; DHT, JPG and DAC do not.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return segment.length < 9 ? null : { width: header.getUint16(7), height: header.getUint16(5) }
    }
    offset += 2 + header.getUint16(2)
  }
  return null
}

/**
 * Whether bytes start with an MPEG audio frame's header a decoder takes: the sync bits, then no
 * reserved version, layer, bit rate or sample rate.
 * @param {Uint8Array} head
 */
const mpegFrame = (head) => head.length >= 4 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && (head[1] & 0x18) !== 0x08 &&
  (head[1] & 0x06) !== 0 && (head[2] & 0xf0) !== 0xf0 && (head[2] & 0x0c) !== 0x0c

/**
 * What a video's or recording's first bytes say it is: its container, a web page, or none known:
 * `ftyp` (mp4, m4a), EBML (WebM), `OggS`, RIFF `WAVE`, an ID3 tag or frame (MP3), `<` (a page).
 * @param {Uint8Array} head the file's first 16 bytes, or all of a shorter one
 * @returns {'mp4' | 'webm' | 'ogg' | 'wav' | 'mp3' | 'page' | undefined}
 */
function containerOf(head) {
  const ascii = (/** @type {number} */ offset, /** @type {number} */ length) => String.fromCharCode(...head.subarray(offset, offset + length))
  if (ascii(4, 4) === 'ftyp') return 'mp4'
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'webm'
  if (ascii(0, 4) === 'OggS') return 'ogg'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'wav'
  if (ascii(0, 3) === 'ID3' || mpegFrame(head)) return 'mp3'
  const text = ascii(0, head.length)
  // UTF-16 read as its characters by leaving out the zero bytes, which only it has here.
  const page = /^(?:\xff\xfe|\xfe\xff)/.test(text) ? text.slice(2).replaceAll('\0', '') : text.replace(/^\xef\xbb\xbf/, '')
  return /^\s*</.test(page) ? 'page' : undefined
}

/**
 * The types `describe` reads. A name's extension says which; a web address with none gets the type
 * its server gives, a video's before a recording's (`.webm`, `.ogg`).
 */
const DESCRIBED = { ...TYPES.image, ...TYPES.audio, ...TYPES.video }

/**
 * The served types `DESCRIBED` loses to a video's, which share an extension with a recording's:
 * a web address with no extension, served so, is still read.
 */
const SERVED_AUDIO = { 'audio/ogg': 'ogg', 'audio/webm': 'webm' }

/** Whose types those are, in a problem. */
const DESCRIBED_AS = 'only a picture, a video or a recording is read:'

/** A format's name, by a picture's extension or a played file's container. */
const FORMATS = /** @type {Record<string, string>} */ ({ png: 'PNG', jpg: 'JPEG', jpeg: 'JPEG', gif: 'GIF', bmp: 'BMP', mp4: 'MP4', webm: 'WebM', ogg: 'Ogg', wav: 'WAV', mp3: 'MP3' })

/** Seconds as a message gives them: to a hundredth. @param {number} seconds */
const rounded = (seconds) => Math.round(seconds * 100) / 100

/**
 * The line a build's output says of the video an Interactive Video's times were held to (#260), so
 * the next change starts from its length: a file's from its index, a host's as it said it.
 * @param {MediaLength} length
 */
export function lengthLine({ file, seconds, host }) {
  return `The video ${file} is ${host ? `about ${rounded(seconds)} s long, as ${host} says` : `${rounded(seconds)} s long`}: keep every time within it.`
}

/**
 * What a file is, in one line (`MediaStore.describe`, #260): the problem with it, or its kind and
 * what was read of it, then what is worth saying besides.
 * @param {MediaFacts} facts
 */
export function mediaLine({ source, kind, format, width, height, seconds, host, notes, problem }) {
  if (problem) return problem
  const a = (/** @type {string} */ word) => (/^(?:MP|Ogg)/.test(word) ? `an ${word}` : `a ${word}`)
  /** @type {string} */
  let what
  if (host) what = `a video on ${host}, ${seconds === undefined ? 'which does not say how long it is' : `about ${rounded(seconds)} s long`}`
  else if (kind === 'image') what = `${a(String(format))} picture, ${width} by ${height} pixels`
  else {
    // A WebM or an Ogg file is a video's or a recording's, and nothing here reads which.
    const noun = format === 'WebM' || format === 'Ogg' ? 'file' : kind === 'video' ? 'video' : 'recording'
    what = `${a(String(format))} ${noun}, ${seconds === undefined ? 'whose length a build does not read' : `${rounded(seconds)} s long`}`
  }
  return [`${source}: ${what}`, ...notes].join('; ')
}

/** The most a host's answer for a video may hold and still be read: Vimeo's is about 1.5 kB. */
const MAX_ANSWER = 64 * 1024

/**
 * A short answer's JSON, or nothing where it is none or runs longer than a host's answer does:
 * what answers is not always the host, and nothing here reads a body of any length whole.
 * @param {Response} response
 * @returns {Promise<unknown>}
 */
async function shortJson(response) {
  const reader = response.body?.getReader()
  if (!reader) return undefined
  /** @type {Uint8Array[]} */
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_ANSWER) return undefined
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let at = 0
    for (const chunk of chunks) {
      bytes.set(chunk, at)
      at += chunk.length
    }
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return undefined
  } finally {
    await reader.cancel().catch(() => {})
  }
}

/** @template F */
export class MediaStore {
  /**
   * @param {MediaAccess<F>} access where the files are, and where a download is kept
   * @param {{ fetch?: typeof fetch, idle?: number }} [options]
   *   `fetch`, for media named by web address; `idle`, the milliseconds a download may go without a byte
   */
  constructor(access, { fetch: fetchImpl = globalThis.fetch, idle = IDLE_MS } = {}) {
    this.access = access
    this.fetch = fetchImpl
    this.idle = idle
    /** @type {StagedFile<F>[]} */
    this.files = []
    /** @type {Map<string, { name: string, mime: string, width?: number, height?: number }>} by kind and source, so one file named twice for one kind is copied once */
    this.known = new Map()
    /** @type {Set<string>} */
    this.names = new Set()
    /** @type {Map<string, MediaLength>} a video's or a recording's length, by its path in the package or the address it stays at, where its index or its host gave one */
    this.lengths = new Map()
    /** @type {Map<string, Promise<{ status: number, seconds?: number }>>} what a host answered of a video, by the address asked, so one video named twice is asked of once */
    this.asked = new Map()
    /** @type {Set<string>} the hosts that gave no answer at all, none of which is asked again in this build */
    this.unanswered = new Set()
    /** @type {string[]} the files left at an address and played from there, as the source names them (#263) */
    this.linked = []
    /** @type {string[]} the files not looked at, as the source names them, where none is read (#270) */
    this.unread = []
  }

  /**
   * A video's or a recording's length, by its path in the package or the address it stays at:
   * read from a file's index, or as its host said it.
   * @param {string} path
   * @returns {MediaLength | undefined}
   */
  lengthOf(path) {
    return this.lengths.get(path)
  }

  /**
   * A written file made what H5P stores (`{ path, mime, width?, height?, copyright }`), its bytes
   * staged for the package; sizes, containers and an mp4's length and tracks are read from them.
   * @param {any} field the image, video, audio or file field
   * @param {{ path: string, copyright?: any }} value as written
   * @param {string} at where it is written, for problems
   * @param {(path: string, message: string) => void} report
   * @param {(path: string, message: string) => void} [note] what is worth saying of a file and no reason not to build
   * @returns {Promise<Record<string, unknown>>}
   */
  async resolve(field, value, at, report, note = () => {}) {
    const kind = /** @type {'image' | 'video' | 'audio' | 'file'} */ (field.type)
    const source = value.path.trim()
    const copyright = this.copyright(value.copyright, `${at}.copyright`, report)
    const web = /^https?:\/\//i.test(source)
    if (web && kind === 'video') {
      const short = YOUTUBE_SHORT.exec(source)
      const address = short ? `https://www.youtube.com/watch?v=${short[1]}` : source
      const hosted = HOSTED.find(({ plays }) => plays.test(address))
      if (hosted) {
        const seconds = this.access.unread ? undefined : await this.#there(hosted, address, source, `${at}.path`, report, note)
        if (seconds !== undefined) this.lengths.set(address, { file: source, seconds, host: hosted.host })
        return { path: address, mime: hosted.mime, copyright }
      }
      const url = URL.canParse(address) ? new URL(address) : null
      const other = url ? HOSTED.find(({ on }) => on(url)) : undefined
      if (other) {
        report(`${at}.path`, `${source} is an address on ${other.host} that H5P.Video cannot play: give ${other.form}`)
        return { path: source, copyright }
      }
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(source) && !web) {
      report(`${at}.path`, `expected ${this.access.what} or an http(s) address`)
      return { path: source, copyright }
    }
    const types = /** @type {Record<string, string>} */ (TYPES[kind])
    if (this.access.unread) return { ...this.#unread(source, web, types, at, report), copyright }
    const address = web ? undefined : this.access.linked?.(source)
    if (address !== undefined) return { ...this.#linked(kind, source, address, types, at, report), copyright }
    const key = `${kind} ${source}`
    let known = this.known.get(key)
    if (!known) {
      const staged = web ? await this.#download(source, kind, types, at, report) : await this.#local(source, types, at, report)
      if (!staged) return { path: source, copyright }
      const extension = staged.extension
      const mime = types[extension]
      const name = this.#name(FOLDERS[kind], staged.stem, extension)
      /** @type {{ name: string, mime: string, width?: number, height?: number }} */
      const described = { name, mime }
      if (kind === 'image') {
        const file = await this.access.open(staged.from)
        try {
          const size = await imageSize((offset, length) => file.read(offset, length))
          if (!size) report(`${at}.path`, `${source} is not a ${extension.toUpperCase()} image whose size can be read`)
          else Object.assign(described, size)
        } finally {
          await file.close()
        }
      } else if (kind === 'video' || kind === 'audio') {
        const file = await this.access.open(staged.from)
        try {
          const played = await this.#played(file, kind, source, web, `${at}.path`, report, note)
          if (played?.seconds) this.lengths.set(name, { file: source, seconds: played.seconds })
        } finally {
          await file.close()
        }
      }
      this.files.push({ name, from: staged.from })
      this.known.set(key, described)
      known = described
    }
    const { name, ...rest } = known
    return { path: name, ...rest, copyright }
  }

  /**
   * A file's copyright as H5P records it: a licence, and its author, title, year, source and
   * version when given, as plain text.
   * @param {unknown} written
   * @param {string} at
   * @param {(path: string, message: string) => void} report
   */
  copyright(written, at, report) {
    if (written === undefined) return { license: 'U' }
    if (!written || typeof written !== 'object' || Array.isArray(written)) return { license: 'U' }
    const value = /** @type {Record<string, unknown>} */ (written)
    /** @type {Record<string, string>} */
    const out = { license: 'U' }
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'licenseVersion' && value.version === undefined && typeof entry === 'string') {
        // The source's own word for it, beside its license (#285): a run that read only the list
        // below deleted the field, and the version with it.
        report(`${at}.licenseVersion`, `is the source's word; a file's copyright names its licence's version "version": write "version": ${JSON.stringify(entry)}`)
        continue
      }
      if (!COPYRIGHT_FIELDS.includes(key)) {
        report(`${at}.${key}`, 'is not part of a copyright; write license, author, title, year, source or version')
        continue
      }
      if (typeof entry !== 'string' || !entry.trim()) {
        report(`${at}.${key}`, 'expected text')
        continue
      }
      if (key === 'license' && !COPYRIGHT_LICENSES.includes(entry)) report(`${at}.license`, `use one of ${COPYRIGHT_LICENSES.join(', ')}`)
      if (key === 'source' && !COPYRIGHT_SOURCE.test(entry)) report(`${at}.source`, 'expected an http(s) address')
      out[key] = key === 'license' || key === 'version' ? entry : escapeText(entry)
    }
    return out
  }

  /**
   * What a file is, before a source names it (#260): a picture's size, a video's or recording's
   * container, an mp4's length and tracks, a hosted video's host and length.
   * @param {string} written a path, or a web address
   * @returns {Promise<MediaFacts>}
   */
  async describe(written) {
    const source = written.trim()
    /** @type {string[]} */
    const problems = []
    /** @type {string[]} */
    const notes = []
    // A problem names the file; a note comes after its facts, where the file is named already.
    const own = (/** @type {string} */ message) => (/^it /.test(message) ? `${source}: ${message}` : message)
    const report = (/** @type {string} */ _at, /** @type {string} */ message) => { problems.push(own(message)) }
    const note = (/** @type {string} */ _at, /** @type {string} */ message) => { notes.push(message.startsWith(`${source}: `) ? message.slice(source.length + 2) : message) }
    const failed = () => ({ source, notes, problem: problems[0] })
    const web = /^https?:\/\//i.test(source)
    if (web) {
      const short = YOUTUBE_SHORT.exec(source)
      const address = short ? `https://www.youtube.com/watch?v=${short[1]}` : source
      const hosted = HOSTED.find(({ plays }) => plays.test(address))
      if (hosted) {
        const seconds = await this.#there(hosted, address, source, '', report, note)
        if (problems.length) return failed()
        return { source, kind: 'video', host: hosted.host, ...(seconds === undefined ? {} : { seconds }), notes }
      }
      const url = URL.canParse(address) ? new URL(address) : null
      const other = url ? HOSTED.find(({ on }) => on(url)) : undefined
      if (other) return { source, notes, problem: `${source} is an address on ${other.host} that H5P.Video cannot play: give ${other.form}` }
    } else if (/^[a-z][a-z0-9+.-]+:/i.test(source)) {
      // Two letters or more before the colon: one alone is a Windows drive.
      return { source, notes, problem: `${source}: expected a file or an http(s) address` }
    }
    const staged = web ? await this.#download(source, 'file', DESCRIBED, '', report, DESCRIBED_AS, SERVED_AUDIO) : await this.#local(source, DESCRIBED, '', report, DESCRIBED_AS)
    if (!staged) return failed()
    const file = await this.access.open(staged.from)
    try {
      if (Object.hasOwn(TYPES.image, staged.extension)) {
        const size = await imageSize((offset, length) => file.read(offset, length))
        if (!size) return { source, notes, problem: `${source} is not a ${staged.extension.toUpperCase()} image whose size can be read` }
        return { source, kind: 'image', format: FORMATS[staged.extension], ...size, notes }
      }
      const kind = Object.hasOwn(TYPES.video, staged.extension) ? 'video' : 'audio'
      const played = await this.#played(file, kind, 'it', web, '', report, note)
      if (!played) return failed()
      return { source, kind, format: FORMATS[played.container], ...(played.seconds ? { seconds: played.seconds } : {}), notes }
    } finally {
      await file.close()
    }
  }

  /**
   * A video's or recording's bytes held to what its field takes: its container from its first bytes
   * and, for an mp4, its index; notes for no sound, no picture or one not every browser plays.
   * @param {{ size: number, read(offset: number, length: number): Promise<Uint8Array> }} file
   * @param {'video' | 'audio'} kind
   * @param {string} source as written
   * @param {boolean} web named by a web address
   * @param {string} at
   * @param {(path: string, message: string) => void} report
   * @param {(path: string, message: string) => void} note
   * @returns {Promise<{ container: string, seconds?: number } | undefined>} its container, and its
   *   length in seconds where its index gives one; nothing where it is refused
   */
  async #played(file, kind, source, web, at, report, note) {
    const { takes, what } = PLAYS[kind]
    // An mp4 by its index, as the normalizer reads one, after `ftyp` or an older file's `moov`,
    // `mdat`, `free` or `wide`; any other by its first bytes.
    const info = await mp4Info((offset, length) => file.read(offset, length), file.size)
    const container = info ? 'mp4' : containerOf(await file.read(0, 16))
    if (container === 'page') {
      report(at, `${source} is a web page, not ${kind === 'video' ? 'a video' : 'a recording'}${web ? ': give the address of the file itself' : ''}`)
      return undefined
    }
    if (!container || !takes.includes(container)) {
      report(at, `${source} is not ${what}: its first bytes are none of theirs`)
      return undefined
    }
    if (!info) {
      if (container === 'mp4') report(at, `${source} has no index (moov) a player can read: is the file whole?`)
      return container === 'mp4' ? undefined : { container }
    }
    const held = new Set(info.tracks.map((track) => track.kind))
    if (held.size && !held.has('audio')) note(at, `${source} has no sound`)
    if (held.size && kind === 'video' && !held.has('video')) note(at, `${source} has no picture`)
    const codecs = new Set(info.tracks.filter((track) => track.kind === 'video').map((track) => NOT_EVERYWHERE[track.codec]).filter(Boolean))
    for (const codec of codecs) note(at, `${source} is ${codec}, which not every browser plays; H.264 plays in all of them`)
    return { container, ...(info.duration ? { seconds: info.duration } : {}) }
  }

  /**
   * @param {string} source
   * @param {Record<string, string>} types
   * @param {string} at
   * @param {(path: string, message: string) => void} report
   * @param {string} [takes] what takes those types, for a problem
   */
  async #local(source, types, at, report, takes = 'this field takes') {
    const name = this.access.name(source)
    const extension = extensionOf(name)
    if (!Object.hasOwn(types, extension)) {
      report(`${at}.path`, `${source}: ${takes} ${Object.keys(types).map((each) => `.${each}`).join(', ')}`)
      return null
    }
    const found = await this.access.local(source)
    if ('missing' in found) {
      report(`${at}.path`, `${source}: ${found.missing}`)
      return null
    }
    return { from: found.file, extension, stem: name.slice(0, name.length - extension.length - 1) }
  }

  /**
   * A file not looked at (#270), for a source whose files are elsewhere, as a chat attachment: by
   * path, judged by name and listed in `unread`; by web address, left as written.
   * @param {string} source
   * @param {boolean} web
   * @param {Record<string, string>} types
   * @param {string} at
   * @param {(path: string, message: string) => void} report
   * @returns {{ path: string, mime?: string }}
   */
  #unread(source, web, types, at, report) {
    if (web) return { path: source }
    const extension = extensionOf(this.access.name(source))
    if (!Object.hasOwn(types, extension)) {
      report(`${at}.path`, `${source}: this field takes ${Object.keys(types).map((each) => `.${each}`).join(', ')}`)
      return { path: source }
    }
    if (!this.unread.includes(source)) this.unread.push(source)
    return { path: source, mime: types[extension] }
  }

  /**
   * A file left at a web address and played from there (#263): a video or recording only, as a
   * picture's size needs its bytes. Nothing is checked, so the package is a preview.
   * @param {string} kind
   * @param {string} source
   * @param {string} address
   * @param {Record<string, string>} types
   * @param {string} at
   * @param {(path: string, message: string) => void} report
   * @returns {{ path: string, mime?: string }}
   */
  #linked(kind, source, address, types, at, report) {
    if (kind !== 'video' && kind !== 'audio') {
      report(`${at}.path`, `${source}: only a video or a recording is played from an address; give the file itself`)
      return { path: source }
    }
    const extension = extensionOf(this.access.name(source))
    if (!Object.hasOwn(types, extension)) {
      report(`${at}.path`, `${source}: this field takes ${Object.keys(types).map((each) => `.${each}`).join(', ')}`)
      return { path: source }
    }
    if (typeof address !== 'string' || !/^https?:\/\//i.test(address) || !URL.canParse(address)) {
      report(`${at}.path`, `${source}: the address it is played from is not an http(s) address`)
      return { path: source }
    }
    const hosted = HOSTED.find(({ on }) => on(new URL(address)))
    if (hosted) {
      report(`${at}.path`, `${source}: the address it is played from is on ${hosted.host}, whose player shows a video, not a file; give ${hosted.form} as the path instead`)
      return { path: source }
    }
    if (!this.linked.includes(source)) this.linked.push(source)
    return { path: address, mime: types[extension] }
  }

  /**
   * Whether a host has a video, asked of its oEmbed (#218): a made-up id built a dead player. Not
   * there is a problem, private a note; no answer, or not the host's, says nothing.
   * @param {(typeof HOSTED)[number]} hosted
   * @param {string} address as H5P.Video will play it
   * @param {string} source as written
   * @param {string} at
   * @param {(path: string, message: string) => void} report
   * @param {(path: string, message: string) => void} note
   * @returns {Promise<number | undefined>} the video's length in seconds, where the host's answer gives one (#260)
   */
  async #there(hosted, address, source, at, report, note) {
    const ask = hosted.oembed?.(address)
    if (!ask || !hosted.answers) return undefined
    let answer = this.asked.get(ask)
    if (!answer) {
      // One at a time, and a host that does not answer costs its ten seconds once, not a video.
      if (this.unanswered.has(hosted.host)) return undefined
      answer = this.#ask(ask, hosted)
      this.asked.set(ask, answer)
    }
    const { status, seconds } = await answer
    if (status === 0) this.unanswered.add(hosted.host)
    const meaning = hosted.answers[status]
    if (meaning?.gone) report(at, `${source}: ${hosted.host} ${meaning.gone} (it answered ${status})`)
    else if (meaning?.closed) note(at, `${source}: ${hosted.host} ${meaning.closed} (it answered ${status})`)
    return seconds
  }

  /**
   * The status a host's oEmbed answers: 0 if not in time, -1 if not sent as the host sends it
   * (`sends`). With it the length in seconds where the answer carries one (`length`, #260).
   * @param {string} url
   * @param {(typeof HOSTED)[number]} hosted
   * @returns {Promise<{ status: number, seconds?: number }>}
   */
  async #ask(url, hosted) {
    try {
      const response = await this.fetch(url, { signal: AbortSignal.timeout(ASK_MS) })
      const { status } = response
      const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
      if (status === 200 && hosted.length && type === 'application/json') {
        return { status, seconds: hosted.length(await shortJson(response)) }
      }
      if (!hosted.answers || !hosted.sends || !Object.hasOwn(hosted.answers, status)) {
        await response.body?.cancel().catch(() => {})
        return { status }
      }
      const own = type === hosted.sends.type && (await response.text()).trim() === hosted.sends.body(status)
      if (!own) await response.body?.cancel().catch(() => {})
      return { status: own ? status : -1 }
    } catch {
      return { status: 0 }
    }
  }

  /**
   * A web address downloaded and kept, its type taken from its name or, failing that, from what
   * the server says it is.
   * @param {string} source
   * @param {string} kind
   * @param {Record<string, string>} types
   * @param {string} at
   * @param {(path: string, message: string) => void} report
   * @param {string} [takes] what takes those types, for a problem
   * @param {Record<string, string>} [served] an extension, by a served type `types` does not map to one
   */
  async #download(source, kind, types, at, report, takes = 'this field takes', served = /** @type {Record<string, string>} */ ({})) {
    let url
    try {
      url = new URL(source)
    } catch {
      report(`${at}.path`, `${source} is not a web address`)
      return null
    }
    const controller = new AbortController()
    const failed = (/** @type {unknown} */ error) => {
      const cause = controller.signal.aborted ? controller.signal.reason : error
      report(`${at}.path`, `${source} could not be downloaded: ${cause instanceof Error ? cause.message : cause}`)
      return null
    }
    // Started again by every byte that arrives: a page's timers have no `refresh`.
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer
    const wait = () => {
      clearTimeout(timer)
      timer = setTimeout(() => controller.abort(new Error(`nothing arrived for ${this.idle / 1000} s`)), this.idle)
    }
    wait()
    try {
      let response
      try {
        response = await this.fetch(url.href, { redirect: 'follow', signal: controller.signal })
      } catch (error) {
        return failed(error)
      }
      wait()
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        report(`${at}.path`, `${source} answered ${response.status}${kind === 'video' ? '; for a video on YouTube, Vimeo, Panopto or Echo360 give its address there' : ''}`)
        return null
      }
      const named = extensionOf(lastSegment(new URL(response.url || url.href).pathname))
      const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
      const extension = Object.hasOwn(types, named) ? named : Object.keys(types).find((each) => types[each] === type) ?? (Object.hasOwn(served, type) ? served[type] : undefined)
      if (!extension) {
        await response.body.cancel()
        report(`${at}.path`, `${source} is ${type || 'of an unknown type'}: ${takes} ${Object.keys(types).map((each) => `.${each}`).join(', ')}`)
        return null
      }
      let received = 0
      const limited = response.body.pipeThrough(new TransformStream({
        transform(chunk, stream) {
          wait()
          received += chunk.length
          if (received > MAX_DOWNLOAD) stream.error(new Error(`larger than ${MAX_DOWNLOAD / 1024 ** 3} GB`))
          else stream.enqueue(chunk)
        }
      }))
      let from
      try {
        from = await this.access.keep(limited, extension)
      } catch (error) {
        return failed(error)
      }
      const last = lastSegment(decoded(new URL(response.url || url.href).pathname))
      const stem = (named && last.endsWith(`.${named}`) && last !== `.${named}` ? last.slice(0, -named.length - 1) : last) || kind
      return { from, extension, stem }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * A name under `content/` for a file: its own, made safe, and numbered where another has it.
   * @param {string} folder
   * @param {string} stem
   * @param {string} extension
   */
  #name(folder, stem, extension) {
    const safe = stem.normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || folder.slice(0, -1)
    let name = `${folder}/${safe}.${extension}`
    for (let count = 2; this.names.has(name.toLowerCase()); count++) name = `${folder}/${safe}-${count}.${extension}`
    this.names.add(name.toLowerCase())
    return name
  }
}
