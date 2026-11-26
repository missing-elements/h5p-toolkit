import type { ContentMetadata } from './metadata.js'

/**
 * The shapes crossing the three contexts: the page (element), the Service Worker and the Jobs
 * worker. Everything here is structured-cloneable.
 */

/** How the bytes of an archive are reached. Persisted, so the worker can rebuild it after a restart. */
export type SourceDescriptor =
  | {
      /** Host honours `Range`: read straight from the network, store nothing but extracted entries. */
      type: 'range-http'
      url: string
      size: number
      validator?: string | null
    }
  | {
      /** Host has CORS but ignores `Range`: the archive is downloaded into the chunk store first. */
      type: 'chunked'
      url: string
      /** `null` until the download finishes for a host that exposes no length. */
      size: number | null
      validator?: string | null
    }
  | {
      /** A `File` from a picker. The handle cannot be persisted; the page re-sends it on request. */
      type: 'file'
      name: string
      size: number
      lastModified: number
    }

/** The two descriptors a URL can produce. Both carry a validator; a picked file has none. */
export type RemoteSourceDescriptor = Exclude<SourceDescriptor, { type: 'file' }>

/** What a row has been through. Written for whoever is looking at the table; read by nothing. */
export type PackageStatus = 'registered' | 'indexed'

/**
 * Where to look for libraries a package does not carry: `pack`, the library pack (see
 * `PackLibrary`), or the URL of a `.h5p` that carries them.
 */
export type LibrarySource = 'pack' | { url: string }

/** A dependency as `library.json` and `h5p.json` declare it, versions as numbers. */
export interface PackDependency {
  machineName: string
  majorVersion: number
  minorVersion: number
}

/**
 * One library of the pack, as `parts/index.json` describes it: an archive per folder,
 * `<folder>.h5p`, so a package downloads only the libraries it needs, each hash-checked.
 */
export interface PackLibrary {
  /** `<machineName>-<major>.<minor>`, the one folder the part holds. */
  folder: string
  machineName: string
  majorVersion: number
  minorVersion: number
  patchVersion: number
  /** The dependencies its `library.json` declares. */
  preloadedDependencies?: PackDependency[]
  dynamicDependencies?: PackDependency[]
  editorDependencies?: PackDependency[]
  /** For an addon, the content the platforms add it to (`addTo` in its `library.json`). */
  addTo?: unknown
  /**
   * Carried for an H5P site's upload check, which wants a library's dependencies at the exact
   * major.minor, editor ones included (#146). The plan never takes one; h5p-author copies them.
   */
  installOnly?: true
  /** The part's size in bytes. */
  size: number
  /** The part's SHA-256, lower-case hex. */
  sha256: string
}

/**
 * The pack, offered with an `index` so the worker names the parts a package needs. `pinned` is
 * this release's version, whose index the worker carries; else the element sends a copy's index.
 */
export type PackOffer = {
  /** Play the pack's newer version of a library the package carries. */
  refresh: boolean
  /** Supply from the pack what the package does not carry. Off while an earlier source is still to be tried. */
  fill: boolean
  /**
   * Supply the newest older minor the pack has of a library the content names at a newer one than
   * any source has. Sent only once every source has been tried for the version named.
   */
  downgrade?: boolean
} & ({ pinned: true } | { libraries: Array<PackLibrary & { url: string }> })

/** A part to download and attach. */
export interface PackPart {
  folder: string
  url: string
  size: number
  sha256: string
}

/** A library the package carries that plays at the pack's newer version instead. */
export interface RefreshedLibrary {
  /** The machine name, `H5P.QuestionSet`. */
  library: string
  /** The version the package carries, `1.20.3`. */
  from: string
  /** The pack's, `1.21.2`. */
  to: string
}

/**
 * A library the content names at a newer minor than any library source has, played at the newest
 * older minor of the same major instead (`downgrade-libraries`, #85).
 */
export interface DowngradedLibrary {
  /** The machine name, `H5P.MultiChoice`. */
  library: string
  /** The version the content names, `1.17`: a major and a minor, as content names a library. */
  from: string
  /** The version that played, `1.16.27`. */
  to: string
}

/**
 * What the pack has to supply before the package can play: the parts to attach, and the package's
 * own folders that the newer versions among them replace.
 */
export interface PackPlan {
  parts: PackPart[]
  /** The package's own library folders to withhold, each replaced by a part. */
  superseded: string[]
  refreshed: RefreshedLibrary[]
}

/** What an archive declared but does not contain. */
export interface MissingLibraries {
  /** `mainLibrary` from `h5p.json`: the content type, for the error a host shows. */
  mainLibrary?: string
  /** Folder names as the runtime will ask for them, e.g. `H5P.InteractiveVideo-1.27`. */
  folders: string[]
  /** True when the archive carries no libraries at all — the usual content-only export. */
  all: boolean
  /**
   * True when the package is played `untrusted` and carries these itself: its own copy would
   * supply them, and only its own code is refused. A host can offer to play it trusted.
   */
  carried?: boolean
}

/**
 * What the host asked the frame to show and load, by h5p-standalone's option names (`activityId`
 * is its `xAPIObjectIRI`). Written into the package's record, so a restarted worker rebuilds it.
 */
export interface FrameOptions {
  /** The H5P action bar under the content, which the three buttons below live in. */
  frame?: boolean
  copyright?: boolean
  /** The download button; shown only with `downloadUrl`. */
  export?: boolean
  icon?: boolean
  /** The embed button; shown only with `embedCode`. */
  embed?: boolean
  fullScreen?: boolean
  downloadUrl?: string
  /** The code the embed button offers, `:w` and `:h` standing for the size. */
  embedCode?: string
  /** The script the embed dialog offers under "advanced", for sizing the embed; h5p-standalone's `resizeCode`. */
  resizeCode?: string
  /** Absolute URLs of stylesheets and scripts the frame loads after the runtime's own. */
  customCss?: string[]
  customJs?: string[]
  /**
   * The submit button, in content types that have one. The frame hands it to the top-level
   * instance as `extras.isReportingEnabled`, since this core never does (see frame-boot).
   */
  reportingIsEnabled?: boolean
  /** The id statements carry as their object. Default: the package URL, or the frame's own for a file. */
  activityId?: string
}

/** The learner, as H5P names the xAPI actor; h5p-standalone's `user`. */
export interface FrameUser {
  name: string
  mail: string
}

/** One row of the IndexedDB `packages` table. */
export interface PackageRecord {
  pkgId: string
  source: SourceDescriptor
  /**
   * A second package whose libraries fill this one's gaps. Stored rather than held in memory so
   * a restarted worker reattaches it without asking the page again.
   */
  libraryPkgId?: string
  /** The parts of the library pack attached, in the order they were; see `LoadSettings.parts`. */
  parts?: string[]
  /** The package's own library folders a part replaces; see `LoadSettings.superseded`. */
  superseded?: string[]
  /** An older minor answers for a newer one; see `LoadSettings.downgrade`. */
  downgrade?: boolean
  /**
   * `libraries` marks an archive registered only to supply library folders to another package.
   * It is never played, so it is not held to carrying everything its own `h5p.json` declares.
   */
  role?: 'content' | 'libraries'
  /** Absolute URLs of the frame assets, resolved by the element and used to synthesize the frame. */
  frameAssets: FrameAssets
  /** Extra CSP host-sources the host page vouches for. See the `allow-origins` attribute. */
  allowOrigins?: string[]
  /** The display and loading options the host set; absent from a record an older element wrote. */
  frameOptions?: FrameOptions
  /** The language tag the element was in when it loaded the package; absent when none was declared, and from a record an older element wrote. */
  language?: string
  /**
   * Played as data, none of the package's code runs: libraries come from the attached bundle only,
   * `content/` serves only H5P's file types, and the frame allows scripts by exact path or URL, not origin.
   */
  untrusted?: boolean
  status: PackageStatus
  title?: string
  /** `h5p.json`'s licence, authors and the rest, for the frame's copyright dialog; absent from an older row. */
  metadata?: ContentMetadata
  lastPlayed: number
  /** The element version that wrote the row. Read by nothing today; a future migration keys on it. */
  version: string
  /**
   * What each load asked for, by its load key: the settings above and the bundle attached. The
   * fields above are the last registration's, and serve only a frame an older element opened.
   */
  views?: Record<string, LoadSettings>
}

/**
 * What one load asked for, apart from the bytes, under a random key its frame's URLs carry, so two
 * players can show one package differently. Not a hash: a reload would detach another's bundle.
 */
export interface LoadSettings {
  frameAssets: FrameAssets
  allowOrigins?: string[]
  frameOptions?: FrameOptions
  language?: string
  untrusted?: boolean
  /** The bundle attached for this load; see `PackageRecord.libraryPkgId`. */
  libraryPkgId?: string
  /** The library pack's parts attached for this load, by their package ids, consulted before the bundle. */
  parts?: string[]
  /**
   * The package's own library folders withheld because a part carries a newer version of the
   * library: requests for them resolve to the part's folder, by the rule `get()` serves with.
   */
  superseded?: string[]
  /**
   * A library named at a newer minor than any source has is served from the newest older minor of
   * the same major. Set once every source was tried, kept so a restarted worker serves the same folders.
   */
  downgrade?: boolean
  /** When a load last registered these, for keeping the newest few. */
  registered: number
}

/**
 * Where the runtime's files are: `@missing-elements/h5p-runtime`'s `dist/`, resolved by the host,
 * an `assets-base` or beside the element. A package of its own: it is GPL-3.0, the player MIT.
 */
export interface FrameAssets {
  /**
   * h5p-standalone's `main.bundle.js`, the loader of a runtime up to 0.2: in a record written with
   * it, whose frame the worker still writes that way. Later runtimes load what `boot` names.
   */
  mainJs?: string
  /** `frame.bundle.js` — the H5P core's scripts, jQuery and h5p.js among them. */
  frameJs: string
  /** `h5p.css`, the core's stylesheets rebuilt to stand alone: icon fonts and images inlined. */
  frameCss: string
  /**
   * The frame's boot script, `frame-boot.js`, named in the frame document. Absent from a record an
   * element before 0.5 wrote, when it was inlined; the worker then looks beside `mainJs`.
   */
  bootJs?: string
  /**
   * The text faces taken out of that sheet, which the frame document declares itself. Absent
   * from a record an older element wrote, whose `frameCss` still declares them.
   */
  fonts?: FrameFont[]
  /**
   * The core's strings in every language, `l10n.js`, named in the frame document when the language
   * is not English. Absent from an older record or `runtime`: the frame is then English.
   */
  l10nJs?: string
}

export interface FrameFont {
  family: string
  style: string
  weight: string
  url: string
}

/**
 * What a frame loads, as the worker's `boot` route answers (`sw/library-load.ts`): a runtime after
 * 0.2 builds `H5PIntegration` from it. A contract with the runtime.
 */
export interface LibraryLoad {
  /** The main library at the version served, `H5P.QuestionSet 1.21`: `H5PIntegration`'s `library`. */
  library: string
  /** Every library's scripts, dependencies first, as entry names under the package's root. */
  scripts: string[]
  /** Every library's stylesheets, in the same order. */
  styles: string[]
  /**
   * The core's `libraryDirectories`: for a library served from a folder its version does not name,
   * `H5P.Foo-1.2` → `H5P.Foo`, so that `H5P.getLibraryPath` finds it.
   */
  directories: Record<string, string>
  /** The library folders, reachable from the package, that carry an `upgrades.js`. */
  upgrades: string[]
}

export type ErrorCode =
  | 'no-cors'
  | 'no-worker'
  | 'network'
  | 'quota'
  | 'bad-archive'
  | 'runtime'

export class PlayerError extends Error {
  code: ErrorCode
  /** Set when the failure is a package that declared libraries it does not carry. */
  missingLibraries?: MissingLibraries

  constructor(
    code: ErrorCode,
    message: string,
    options?: { cause?: unknown; missingLibraries?: MissingLibraries }
  ) {
    super(message, options)
    this.name = 'PlayerError'
    this.code = code
    this.missingLibraries = options?.missingLibraries
  }
}

/* ------------------------------------------------------------------ page → Service Worker */

export type ToWorkerMessage =
  | { type: 'ping' }
  /**
   * `view`: the load's key, under which the worker keeps the record's settings for this load
   * alone. A worker that knows it answers `ack` with `views`; one that does not ignores it.
   */
  | { type: 'register'; record: PackageRecord; view?: string }
  /**
   * `deep`: also follow each library's dependencies, as the runtime will, and refuse what none
   * provides. `pack`: the library pack is a source; the reply carries a `plan` if it has parts.
   */
  | { type: 'index'; pkgId: string; view?: string; deep?: boolean; pack?: PackOffer }
  /** Answer to a `need-file` request: the page hands back the `File` the worker lost on restart. */
  | { type: 'file'; pkgId: string; file: File }
  /**
   * Points a package at registered, indexed ones for its libraries: a bundle (replacing the last)
   * or pack parts (added, with the folders they replace). `downgrade`: see `LoadSettings`.
   */
  | { type: 'attach-libraries'; pkgId: string; libraryPkgId?: string; parts?: string[]; superseded?: string[]; downgrade?: true; view?: string }
  /**
   * Asks for a library bundle already downloaded whole from `url`, for when `url` cannot be
   * reached now. Answered `downloaded-libraries`, with `null` when there is none.
   */
  | { type: 'find-downloaded-libraries'; url: string }

/**
 * A large deflated entry no `Range` reaches without the stream before it, so it needs a background
 * inflate. Named in `indexed` to start early: a non-faststart mp4 can only move its wait.
 */
export interface PrefetchEntry {
  entry: string
  location: EntryLocation
}

/**
 * Where an entry's compressed bytes are, so the Jobs worker needs no index of its own. From the
 * central directory it names the local header; from a forward index it carries where data begins.
 */
export interface EntryLocation {
  /** Offset of the local header in the archive. */
  header?: number
  /** Where the compressed bytes begin, when the local header has already been read. */
  dataStart?: number
  compressedSize: number
  /** Uncompressed size. */
  size: number
  method: number
}

/** One entry inside a warm span: where its local header is, and what follows it. */
export interface WarmEntry {
  name: string
  /** Offset of the local header in the archive. */
  offset: number
  compressedSize: number
  /** Uncompressed size. */
  size: number
  method: number
}

/**
 * A run of the archive worth pulling whole before the frame boots: small entries (library scripts,
 * styles, JSON) the runtime would ask for one by one. Named in `indexed` for a `Range` host.
 */
export interface WarmSpan {
  start: number
  /** Exclusive. */
  end: number
  /** In archive order. */
  entries: WarmEntry[]
}

export type WorkerReply =
  | { ok: true; type: 'pong'; version: string }
  | {
      ok: true
      type: 'indexed'
      pkgId: string
      title?: string
      prefetch?: PrefetchEntry[]
      /** Spans to pull whole before booting. Only for a host that honours `Range`. */
      warm?: WarmSpan[]
      /** For a partial index: whether everything the runtime needs to boot has arrived. */
      ready?: boolean
      /**
       * The xAPI `context.revision` for this package: its index fingerprint and any attached
       * bundle's. Absent for a partial index, which has no central directory yet.
       */
      revision?: string
      /** `h5p.json`'s licence, authors and the rest, as the element's `metadata` shows them. */
      metadata?: ContentMetadata
      /** `h5p.json`'s `mainLibrary`, the content type, when the manifest names one. */
      mainLibrary?: string
      /**
       * Parts of the library pack to attach before the package can play, for an `index` that
       * offered the pack. The reply carries nothing else then: index again once they are attached.
       */
      plan?: PackPlan
      /**
       * For a `deep` index: the libraries served at an older minor than the content or a library
       * asks for, which only a load that asked for the downgrade gets. Absent when none was.
       */
      downgraded?: DowngradedLibrary[]
    }
  /** `views`: the register named a load key and the worker kept the settings under it. */
  | { ok: true; type: 'ack'; views?: true }
  | { ok: true; type: 'downloaded-libraries'; pkgId: string | null }
  | { ok: false; code: ErrorCode; message: string; missingLibraries?: MissingLibraries }

/* ------------------------------------------------------------------ Service Worker → page */

/**
 * Sent to the frame client, which relays it up. The Service Worker cannot run a job: browsers kill
 * a worker event after minutes and a killed inflate cannot resume, so the page does.
 */
export type FromWorkerMessage =
  | { type: 'need-job'; pkgId: string; entry: string; location: EntryLocation }
  | { type: 'need-file'; pkgId: string }

/* ------------------------------------------------------------------ element → Jobs worker */

/**
 * A job, with the picked `File` when the package is one: the element sends the file with every
 * job for such a package, and the worker keeps it by package for the life of the worker.
 */
export type ToJobsMessage = ToJobsRequest & { file?: File }

type ToJobsRequest =
  /** `sha256`: what the downloaded bytes must hash to, for a part of the library pack. */
  | { type: 'download'; pkgId: string; source: SourceDescriptor; sha256?: string }
  /** `prefetch`: asked for ahead of demand, so it queues behind anything the runtime is waiting on. */
  | {
      type: 'extract'
      pkgId: string
      entry: string
      location: EntryLocation
      source: SourceDescriptor
      prefetch?: true
    }
  /** Pulls the spans into the cache. Reports under the reserved entry name `WARM_ENTRY`. */
  | { type: 'warm'; pkgId: string; source: SourceDescriptor; spans: WarmSpan[] }
  | { type: 'abort'; pkgId: string }

/**
 * The first thing the Jobs worker posts. Messages sent to a worker whose script never loaded are
 * dropped, so the page holds its jobs until this arrives; see `JobsWorkerHandle`.
 */
export const JOBS_READY = 'jobs-ready'

export type FromJobsMessage =
  | { type: 'progress'; pkgId: string; entry?: string; loaded: number; total: number | null }
  | { type: 'done'; pkgId: string; entry?: string }
  | { type: 'failed'; pkgId: string; entry?: string; code: ErrorCode; message: string }

/* ------------------------------------------------------------------ frame → element */

/**
 * H5P's own iframe-resizing protocol: the frame sends these to `window.parent`, the element
 * answers. `h5p-resizer.js` in h5p-php-library is the reference for the embedder side.
 */
export interface H5PResizerMessage {
  context: 'h5p'
  action: 'hello' | 'prepareResize' | 'resize' | 'resizePrepared' | 'ready'
  scrollHeight?: number
  clientHeight?: number
}

export type FromFrameMessage =
  | { channel: 'h5p-player'; type: 'ready'; pkgId: string }
  | { channel: 'h5p-player'; type: 'xapi'; pkgId: string; statement: unknown; verb?: string }
  | { channel: 'h5p-player'; type: 'finished'; pkgId: string; statement: unknown }
  | { channel: 'h5p-player'; type: 'error'; pkgId: string; message: string }
  | { channel: 'h5p-player'; type: 'relay'; pkgId: string; payload: FromWorkerMessage }
  /** Sent before the runtime initialises, when the frame was opened with `resume`. Answered `user-data`. */
  | { channel: 'h5p-player'; type: 'need-user-data'; pkgId: string }
  /**
   * The runtime saved a state, or deleted one (`data: null`). `session` is the token the element
   * gave this document at boot; one told to forget (`clearUserData()`) carries a stale token.
   */
  | { channel: 'h5p-player'; type: 'user-data'; pkgId: string; session: string } & UserDataEntry

/* ------------------------------------------------------------------ element → frame */

/**
 * One saved value: a data type (`state`), its sub-content (`'0'`: the content) and a JSON string.
 * `null`: in a preload, saved against another build; in a save, deleted.
 */
export interface UserDataEntry {
  dataType: string
  subContentId: string
  data: string | null
}

/** The answer to `need-user-data`: what to preload, how often to save, and the token to save under. */
export interface UserDataPreload {
  channel: 'h5p-player'
  type: 'user-data'
  session: string
  /** Seconds between saves; what H5P core calls `saveFreq`. */
  saveInterval: number
  entries: UserDataEntry[]
  /**
   * The learner the host named, for the statements' actor. It travels in a message to the frame,
   * not in the record: a name and an address are not for the worker's database.
   */
  user?: FrameUser
}
