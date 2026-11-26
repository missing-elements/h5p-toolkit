import { ZipReader, type Entry, type FileEntry } from '@zip.js/zip.js'
import { BLOCK_CACHE_MAX_READ, INLINE_MAX_SIZE, MEDIA_INLINE_MAX_SIZE, WARM_ENTRY_MAX_SIZE, WARM_GAP, WARM_MAX_BYTES } from '../shared/constants.js'
import { indexEntryNames, normalizeEntryName } from '../shared/entry-names.js'
import { extensionOf, isMediaEntry, isTextEntry } from '../shared/mime.js'
import { DEFLATE, LOCAL_HEADER_FIXED_SIZE, STORED, readDataStart } from '../shared/local-header.js'
import {
  PlayerError,
  type DowngradedLibrary,
  type EntryLocation,
  type MissingLibraries,
  type PrefetchEntry,
  type WarmEntry,
  type WarmSpan
} from '../shared/protocol.js'
import type { SourceHandle } from '../shared/source.js'
import { SourceReader } from '../shared/source-reader.js'
import type { ByteRange } from '../shared/range.js'
import { deferredStream, inflated } from '../shared/stream-utils.js'
import type { ForwardEntry, ForwardIndexSnapshot } from '../shared/forward-index.js'
import { indexFingerprint, librariesFingerprint, revisionOf } from '../shared/revision.js'
import { contentMetadata, type ContentMetadata } from '../shared/metadata.js'
import { addonPatterns, dependenciesIn, librariesNamedIn, textMatches, type LibraryDependency, type PackageManifest } from '../shared/content-libraries.js'
import { findMissingLibraries, indexLibraryFolders, libraryFolderNames, parseLibraryFolder, reachableFolder, resolveLibraryFolder, walkDependencies, type LibraryFolder } from '../shared/library-folders.js'
import { ownLibraries as carriedLibraries, type OwnLibrary } from './pack-plan.js'

/**
 * The package reader: a zip central directory as a name → entry index, plus how each entry is
 * served. It also settles which libraries a package carries, lacks, or needs from another archive.
 */

export type Strategy =
  /** Small, or text the runtime has to parse whole: inflate once into the cache, then serve. */
  | { kind: 'inline' }
  /** Large and stored (method 0): the bytes are already flat in the archive, so slice them. */
  | { kind: 'slice' }
  /** Large and deflated (method 8): the Jobs worker inflates into chunks, served progressively. */
  | { kind: 'chunked' }

/** A library that names, in its `library.json`'s `addTo`, the content the platforms add it to. */
export interface Addon extends LibraryDependency {
  patterns: RegExp[]
}

export interface IndexedEntry {
  /** Normalised name, the form the virtual server routes on. */
  name: string
  size: number
  compressedSize: number
  method: number
  strategy: Strategy
  /** The zip.js entry, for an index read from the central directory. Absent for a forward entry. */
  zip?: FileEntry
  /** Where the compressed bytes begin, when the local header has already been read. */
  dataStart?: number
  encrypted?: boolean
}

/**
 * The file types an `untrusted` package may serve from `content/`: H5P's own default list
 * (`H5PCore::$defaultContentWhitelist`), nothing a browser would run: no script, page, SVG or XML.
 */
const CONTENT_FILE_TYPES = new Set(
  (
    'json png jpg jpeg gif bmp tif tiff eot ttf woff woff2 otf webm mp4 ogg mp3 m4a wav txt pdf ' +
    'rtf doc docx xls xlsx ppt pptx odt ods odp csv diff patch swf md textile vtt webvtt gltf glb'
  ).split(' ')
)

/**
 * What an `untrusted` package serves of its own: `h5p.json` and listed-type `content/` files. The
 * rest, library folders included, is withheld so none of its code runs; a bundle has the libraries.
 */
export function servedWhenUntrusted(name: string): boolean {
  if (name === 'h5p.json') return true
  if (!name.startsWith('content/')) return false
  return CONTENT_FILE_TYPES.has(extensionOf(name))
}

/** Takes what an `untrusted` package may not serve out of its index, and returns the names. */
function withholdCode(entries: Map<string, IndexedEntry>): Set<string> {
  const withheld = new Set<string>()
  for (const name of entries.keys()) {
    if (servedWhenUntrusted(name)) continue
    withheld.add(name)
    entries.delete(name)
  }
  return withheld
}

/**
 * Whether a name lies in one of the package's own library folders that a part of the library pack
 * replaces: such a folder is withheld whole, and requests for it resolve to the part's folder.
 */
function inSuperseded(name: string, superseded: ReadonlySet<string>): boolean {
  const top = topFolderOf(name)
  return top !== null && superseded.has(top)
}

/**
 * An entry together with the archive it lives in. A package may be served from more than one:
 * content from the one the user opened, libraries from a bundle attached to fill its gaps.
 */
export interface LocatedEntry {
  reader: PackageReader
  entry: IndexedEntry
}

export class PackageReader {
  readonly pkgId: string
  readonly entries: Map<string, IndexedEntry>
  manifest: PackageManifest
  /**
   * Built from the forward index of an archive still downloading: `absorb()` takes entries in as
   * they arrive; answers are provisional until a central-directory reader replaces it.
   */
  readonly partial: boolean
  /** For a partial reader: how far the archive is accounted for, and whether its index is complete. */
  parsedTo = 0
  forwardDone = false
  private forwardStopped = false
  private absorbed = 0
  /** Top-level folder of the newest entry: the one folder that may still be receiving files. */
  private lastTopFolder: string | null = null
  /**
   * `sha256:…` over the central directory (`indexFingerprint`). Set by `open`; a partial reader
   * has no central directory and so no fingerprint.
   */
  fingerprint: string | undefined

  /**
   * Played as data: what the archive carries beyond `h5p.json` and its content files is withheld
   * (`servedWhenUntrusted`), so library code comes only from an attached bundle.
   */
  readonly untrusted: boolean
  /** The names an untrusted reader withheld, kept to tell a host the package carries what it lacks. */
  private readonly withheld: Set<string>
  /** The package's own library folders a part of the pack replaces; see `inSuperseded`. */
  private readonly superseded: ReadonlySet<string>
  /**
   * Serve a library the content names at a newer minor than anything here at the newest older
   * one (`resolveLibraryFolder`), as the load asked once its sources were tried. See `downgrades`.
   */
  private readonly downgrade: boolean

  /** Archives consulted, in order, for an entry this one does not have. */
  private readonly fallbacks: PackageReader[] = []
  /**
   * With several archives attached, one fingerprint for all of them: see `settleRevision`. A
   * single archive's own is used as it is.
   */
  private librariesFingerprint: string | undefined
  /** Library folders reachable from here, built on first use and dropped when `use()` adds more. */
  private librariesByName: Map<string, LibraryFolder[]> | null = null
  /** Data offsets of stored entries, each read from its local header once. */
  private readonly dataRanges = new Map<string, Promise<ByteRange>>()

  private constructor(
    pkgId: string,
    /** The archive this reader reads. Exposed for the Jobs worker's liveness reports. */
    readonly handle: SourceHandle,
    entries: Map<string, IndexedEntry>,
    manifest: PackageManifest,
    partial = false,
    /** For an untrusted reader, what was withheld so far; `null` for one that serves everything. */
    withheld: Set<string> | null = null,
    superseded: ReadonlySet<string> = new Set(),
    downgrade = false
  ) {
    this.pkgId = pkgId
    this.entries = entries
    this.manifest = manifest
    this.partial = partial
    this.untrusted = withheld !== null
    this.withheld = withheld ?? new Set()
    this.superseded = superseded
    this.downgrade = downgrade
  }

  /**
   * Whether an older minor answers for a newer one now. Never while the archive arrives: a folder
   * still to come may carry the version asked for, and a frame booted early on the older keeps it.
   */
  private get downgrades(): boolean {
    return this.downgrade && !this.partial
  }

  /** `h5p.json`'s title, when it is a string: the manifest is untrusted, and three things render it. */
  get title(): string | undefined {
    const { title } = this.manifest as { title?: unknown }
    return typeof title === 'string' ? title : undefined
  }

  /** `h5p.json`'s licence, authors and the rest, as the runtime's copyright dialog reads them; the same caution. */
  get metadata(): ContentMetadata | undefined {
    return contentMetadata(this.manifest)
  }

  static async open(
    pkgId: string,
    handle: SourceHandle,
    options: { requireLibraries?: boolean; untrusted?: boolean; superseded?: Iterable<string>; downgrade?: boolean } = {}
  ): Promise<PackageReader> {
    let zipEntries: Entry[]
    try {
      const zip = new ZipReader(new SourceReader(handle))
      // zip.js would refuse the whole archive over one unsafe name; validating per entry here drops
      // just that path, and nothing downstream sees an unnormalised name.
      zipEntries = await zip.getEntries({ filenameValidation: 'tolerant' })
    } catch (error) {
      throw new PlayerError('bad-archive', 'Could not read the archive index', { cause: error })
    }

    const { index } = indexEntryNames(zipEntries)
    const entries = new Map<string, IndexedEntry>()

    for (const [name, zip] of index) {
      entries.set(name, {
        name,
        size: zip.uncompressedSize,
        compressedSize: zip.compressedSize,
        method: zip.compressionMethod,
        strategy: chooseStrategy(name, zip),
        // `indexEntryNames` drops directory entries, so every survivor has readable data.
        zip: zip as FileEntry
      })
    }

    if (!entries.has('h5p.json')) {
      throw new PlayerError('bad-archive', 'Archive has no h5p.json, so it is not an H5P package')
    }
    const withheld = options.untrusted ? withholdCode(entries) : null
    const superseded = new Set(options.superseded ?? [])
    for (const name of entries.keys()) if (inSuperseded(name, superseded)) entries.delete(name)

    const bare = new PackageReader(pkgId, handle, entries, {})
    const manifest = await readManifest(bare)

    const reader = new PackageReader(pkgId, handle, entries, manifest, false, withheld, superseded, options.downgrade === true)
    // Every record, directories and dropped names included: the fingerprint is of the archive
    // as published, not of what the player chose to serve from it.
    reader.fingerprint = await indexFingerprint(
      zipEntries.map((entry) => ({
        rawName: entry.rawFilename,
        crc32: entry.signature ?? 0,
        compressedSize: entry.compressedSize,
        size: entry.uncompressedSize,
        method: entry.compressionMethod
      }))
    )
    // A package that will have a library bundle attached is validated after the attach, not here.
    if (options.requireLibraries !== false) reader.assertLibrariesPresent()

    return reader
  }

  /**
   * A reader over an archive that is still downloading, from the entries its local headers have
   * given up so far. Nothing is asserted here: what is missing may simply not have arrived.
   */
  static async fromForwardIndex(
    pkgId: string,
    handle: SourceHandle,
    snapshot: ForwardIndexSnapshot,
    options: { untrusted?: boolean; superseded?: Iterable<string>; downgrade?: boolean } = {}
  ): Promise<PackageReader> {
    const reader = new PackageReader(
      pkgId,
      handle,
      new Map(),
      {},
      true,
      options.untrusted ? new Set() : null,
      new Set(options.superseded ?? []),
      options.downgrade === true
    )
    await reader.absorb(snapshot)
    return reader
  }

  /**
   * Takes in the entries a newer snapshot has and this reader does not: snapshots are cumulative
   * and in archive order, so only the tail is new, and first occurrence wins as in the full index.
   */
  async absorb(snapshot: ForwardIndexSnapshot): Promise<boolean> {
    if (!this.partial) return false
    const fresh = snapshot.entries.slice(this.absorbed)
    this.absorbed = snapshot.entries.length
    this.parsedTo = snapshot.parsedTo
    this.forwardDone = snapshot.done
    this.forwardStopped = snapshot.stopped !== null && !snapshot.done

    let manifestArrived = false
    for (const forward of fresh) {
      if (forward.directory) continue
      const name = normalizeEntryName(forward.name)
      if (name === null || this.entries.has(name) || this.withheld.has(name)) continue
      // Withheld or not, it says how far the archive has got: a folder is finished once a later
      // one begins.
      this.lastTopFolder = topFolderOf(name)
      if (this.untrusted && !servedWhenUntrusted(name)) {
        this.withheld.add(name)
        continue
      }
      if (inSuperseded(name, this.superseded)) continue
      this.entries.set(name, entryFromForward(name, forward))
      if (name === 'h5p.json') manifestArrived = true
    }

    if (fresh.length > 0) this.librariesByName = null
    if (manifestArrived) this.manifest = await readManifest(this)
    return fresh.length > 0
  }

  /**
   * For a partial reader: whether the runtime could boot now: `h5p.json` and each declared
   * dependency in a finished folder (exporters write one together). Never if the scanner gave up.
   */
  bootReady(): boolean {
    if (!this.partial) return true
    if (this.forwardStopped || !this.entries.has('h5p.json')) return false

    const dependencies = this.manifest.preloadedDependencies
    if (!Array.isArray(dependencies) || dependencies.length === 0) return false

    const names = this.entryNames()
    const available = this.availableLibraries()
    return dependencies.every((dependency) => {
      const folder = reachableFolder(dependency, names, available)
      if (folder === undefined) return false
      // A folder an attached archive serves is whole; only the package's own may still be arriving.
      // An untrusted archive's own folders never serve, so for it the one found is always a bundle's.
      return this.untrusted || this.locate(`${folder}/library.json`)?.reader !== this || this.folderComplete(folder)
    })
  }

  /**
   * The package's own library folders, as far as they can be told now: for a partial reader only
   * those that have finished arriving. An untrusted reader has none, since it withholds them all.
   */
  ownLibraryFolders(): string[] {
    const folders: string[] = []
    for (const name of this.entries.keys()) {
      const slash = name.indexOf('/')
      if (slash < 0 || name.slice(slash + 1) !== 'library.json') continue
      const folder = name.slice(0, slash)
      if (!this.partial || this.folderComplete(folder)) folders.push(folder)
    }
    return folders
  }

  /**
   * The folders `h5p.json` declares (`reachableFolder`): an export lists there every library the
   * content plays, flattened, and none carried only for an upload check. Empty if none carried.
   */
  private declaredFolders(): Set<string> {
    const names = new Set(this.entries.keys())
    const available = indexLibraryFolders(names)
    const folders = new Set<string>()
    for (const dependency of dependenciesIn(this.manifest)) {
      const folder = reachableFolder(dependency, names, available, true)
      if (folder) folders.add(folder)
    }
    return folders
  }

  /**
   * The plan's `ownLibraries` over this archive's folders. With `read`, only those the content
   * reaches are read; the rest, which nothing plays (#146), go by name, as the warm skips them.
   */
  async ownLibraries(read?: (located: LocatedEntry) => Promise<unknown>): Promise<OwnLibrary[]> {
    const folders = this.ownLibraryFolders()
    if (!read) return carriedLibraries(folders)
    const names = new Set(folders.map((folder) => `${folder}/library.json`))
    const available = indexLibraryFolders(names)
    const libraries = new Map<string, Promise<unknown>>()
    const readFolder = (folder: string) => {
      let library = libraries.get(folder)
      if (!library) {
        library = read({ reader: this, entry: this.entries.get(`${folder}/library.json`)! })
        libraries.set(folder, library)
      }
      return library
    }
    const { found } = await walkDependencies(
      await this.contentDependencies(),
      (dependency) => reachableFolder(dependency, names, available, this.downgrades),
      // One that does not parse has no dependencies here; the plan leaves it out, below.
      (folder) => readFolder(folder).catch(() => null)
    )
    const reached = new Set(found.map(({ located }) => located))
    // Reached first: the plan takes the first folder that satisfies a dependency, so it takes one it read.
    const ordered = [...folders.filter((folder) => reached.has(folder)), ...folders.filter((folder) => !reached.has(folder))]
    return carriedLibraries(ordered, readFolder, (folder) => reached.has(folder))
  }

  /** The library folders the attached archives provide, a part's or a bundle's. */
  providedLibraries(): Array<{ folder: string; machineName: string; major: number; minor: number }> {
    const provided: Array<{ folder: string; machineName: string; major: number; minor: number }> = []
    for (const fallback of this.fallbacks) {
      for (const folders of fallback.availableLibraries().values()) provided.push(...folders)
    }
    return provided
  }

  /**
   * The libraries the content asks for at its top: what `h5p.json` declares, and the sub-content
   * its parameters name. A full export's list already has the second; a stripped one's does not.
   */
  async contentDependencies(): Promise<Array<{ machineName: string; majorVersion: number; minorVersion: number }>> {
    return [...dependenciesIn(this.manifest), ...(await this.contentLibraries())].map(({ machineName, majorVersion, minorVersion }) => ({
      machineName,
      majorVersion: Number(majorVersion),
      minorVersion: Number(minorVersion)
    }))
  }

  /** The content's parameters, `content/content.json` parsed; `undefined` while it cannot be read. */
  contentParameters(): Promise<unknown> {
    return this.contentParams()
  }

  /** Whether `content/content.json` has arrived, for a partial reader; always for a whole one. */
  get contentArrived(): boolean {
    return !this.partial || this.forwardDone || this.entries.has('content/content.json')
  }

  /**
   * For a partial reader: a miss answerable without more of the archive, when its top-level folder
   * has finished arriving, or a versioned name matches a finished unversioned folder.
   */
  provablyAbsent(name: string): boolean {
    if (!this.partial || this.forwardDone) return true
    // An untrusted archive never serves this, however much of it arrives.
    if (this.untrusted && !servedWhenUntrusted(name)) return true
    const top = topFolderOf(name)
    if (top === null) return false

    if (this.hasFolder(top)) return this.folderComplete(top)

    const wanted = parseLibraryFolder(top)
    return wanted !== null && this.hasFolder(wanted.machineName) && this.folderComplete(wanted.machineName)
  }

  private folderComplete(folder: string): boolean {
    return this.forwardDone || this.lastTopFolder !== folder
  }

  private hasFolder(folder: string): boolean {
    const prefix = `${folder}/`
    for (const name of this.entries.keys()) if (name.startsWith(prefix)) return true
    return false
  }

  /**
   * What an xAPI statement's `context.revision` says about this package: its fingerprint, and
   * each attached bundle's. Undefined until every one of them has a central directory.
   */
  revision(): string | undefined {
    const libraries = this.fallbacks.map((reader) => reader.fingerprint)
    if (!this.fingerprint || libraries.some((fingerprint) => !fingerprint)) return undefined
    if (libraries.length > 1) return this.librariesFingerprint && revisionOf(this.fingerprint, [this.librariesFingerprint])
    return revisionOf(this.fingerprint, libraries as string[])
  }

  /**
   * Works out the one fingerprint that several attached archives (a dozen pack parts or more) share
   * in the revision. Call after the last `use()`: until then several attached mean no revision.
   */
  async settleRevision(): Promise<void> {
    const fingerprints = this.fallbacks.map((reader) => reader.fingerprint)
    this.librariesFingerprint =
      fingerprints.length > 1 && fingerprints.every(Boolean) ? await librariesFingerprint(fingerprints as string[]) : undefined
  }

  /** Adds an archive to consult for entries this one does not carry. */
  use(reader: PackageReader): void {
    if (reader === this || this.fallbacks.includes(reader)) return
    this.fallbacks.push(reader)
    this.librariesByName = null
    this.librariesFingerprint = undefined
  }

  /**
   * Looks an entry up in this archive, then in each attached one. A miss on a library path is
   * retried against a compatible version: `H5P.Text-1.0/` is served from `H5P.Text-1.1/`.
   */
  get(name: string): LocatedEntry | undefined {
    return this.locate(name) ?? this.locateCompatible(name)
  }

  /** Exact lookup, this archive first and then each attached one, in order. */
  private locate(name: string): LocatedEntry | undefined {
    const own = this.entries.get(name)
    if (own) return { reader: this, entry: own }

    for (const fallback of this.fallbacks) {
      const found = fallback.locate(name)
      if (found) return found
    }
    return undefined
  }

  private locateCompatible(name: string): LocatedEntry | undefined {
    const slash = name.indexOf('/')
    if (slash < 0) return undefined

    // Library folders are always the first path segment, so nothing deeper is ever reinterpreted.
    const wanted = parseLibraryFolder(name.slice(0, slash))
    if (!wanted) return undefined

    const folder = resolveLibraryFolder(this.availableLibraries(), wanted, this.downgrades)
    if (!folder || folder === wanted.folder) return undefined

    return this.locate(`${folder}/${name.slice(slash + 1)}`)
  }

  /**
   * Library folders reachable from here, this archive's own first. Memoised: it runs on the miss
   * path, misses are not rare, and rebuilding a map over every entry name is waste. `use()` resets.
   */
  private availableLibraries(): Map<string, LibraryFolder[]> {
    if (this.librariesByName) return this.librariesByName

    const merged = indexLibraryFolders(this.entries.keys())
    for (const fallback of this.fallbacks) {
      for (const [machineName, folders] of fallback.availableLibraries()) {
        const existing = merged.get(machineName)
        if (existing) existing.push(...folders)
        else merged.set(machineName, [...folders])
      }
    }

    this.librariesByName = merged
    return merged
  }

  /** Every entry name reachable through this reader, including the attached archives. */
  entryNames(): Set<string> {
    const names = new Set(this.entries.keys())
    for (const fallback of this.fallbacks) {
      for (const name of fallback.entryNames()) names.add(name)
    }
    return names
  }

  /**
   * The library folders reachable from here that carry an `upgrades.js`. The frame fetches a
   * library's upgrade steps only from a folder named here, so it never asks for a missing one.
   */
  foldersWithUpgrades(): string[] {
    const names = this.entryNames()
    const folders: string[] = []
    for (const name of names) {
      const match = /^([^/]+)\/upgrades\.js$/.exec(name)
      if (match && names.has(`${match[1]}/library.json`)) folders.push(match[1])
    }
    return folders.sort()
  }

  /**
   * What `h5p.json` declares but nothing reachable from here provides. For an untrusted package
   * that would have it all with its own folders, `carried` says so: only its code was refused.
   */
  missingLibraries(): MissingLibraries | null {
    const names = this.entryNames()
    const missing = describeMissingLibraries(names, this.manifest, this.downgrades)
    if (!missing || missing.folders.length === 0 || this.withheld.size === 0) return missing
    const withOwn = new Set([...names, ...this.withheld])
    return findMissingLibraries(withOwn, this.manifest, this.downgrades).length === 0 ? { ...missing, carried: true } : missing
  }

  /**
   * The libraries the declared ones need in turn that nothing reachable provides: an old export can
   * name a version its own libraries moved past (Font Awesome 4.3 for 4.5): the runtime died on it.
   */
  async missingDependencies(
    manifest: PackageManifest,
    read: (located: LocatedEntry) => Promise<unknown>,
    offered: ReadonlyArray<{ machineName: string; majorVersion: number }> = []
  ): Promise<MissingLibraries | null> {
    return (await this.checkDependencies(manifest, read, offered)).missing
  }

  /**
   * The walk `missingDependencies` makes, plus the libraries served at an older minor than asked,
   * once each. It starts from sub-content libraries a source has the major of (#85).
   */
  async checkDependencies(
    manifest: PackageManifest,
    read: (located: LocatedEntry) => Promise<unknown>,
    offered: ReadonlyArray<{ machineName: string; majorVersion: number }> = []
  ): Promise<{ missing: MissingLibraries | null; downgraded: DowngradedLibrary[] }> {
    const available = this.availableLibraries()
    const sourced = ({ machineName, majorVersion }: LibraryDependency) =>
      (available.get(machineName) ?? []).some(({ major }) => major === Number(majorVersion)) ||
      offered.some((library) => library.machineName === machineName && library.majorVersion === Number(majorVersion))
    const roots = [...dependenciesIn(manifest), ...(await this.contentLibraries()).filter(sourced)]

    // The walk is `walkDependencies`, which the SCORM writer runs over a zip too (#109); what it
    // locates here goes through `get`, so an attached archive and a compatible newer minor count.
    const { missing, found } = await walkDependencies(
      roots,
      (dependency) => libraryFolderNames(dependency).map((folder) => this.get(`${folder}/library.json`)).find(Boolean),
      async (located, dependency) => {
        try {
          return await read(located)
        } catch (error) {
          // Counted as having no dependencies, the walk would pass a tree it did not see, and the
          // runtime would die on the same file with "Unexpected end of JSON input" and no name.
          const reason = error instanceof Error ? error.message : String(error)
          throw new PlayerError('bad-archive', `${libraryFolderNames(dependency)[0]}/library.json could not be read: ${reason}`, { cause: error })
        }
      }
    )

    const downgraded = new Map<string, DowngradedLibrary>()
    for (const { dependency, located, library } of found) {
      const older = olderThanAsked(dependency, located, library)
      if (older) downgraded.set(`${older.library} ${older.from}`, older)
    }
    const listed = [...downgraded.values()].sort((a, b) => a.library.localeCompare(b.library) || a.from.localeCompare(b.from))
    if (missing.length === 0) return { missing: null, downgraded: listed }
    const folders = missing.map((dependency) => libraryFolderNames(dependency)[0]).sort()
    const carried = this.withheld.size > 0 && folders.every((folder) => this.withheld.has(`${folder}/library.json`))
    return {
      missing: { mainLibrary: manifest.mainLibrary, folders, all: false, ...(carried ? { carried } : {}) },
      downgraded: listed
    }
  }

  /** True when another archive is supplying entries this one does not have. */
  get hasFallbacks(): boolean {
    return this.fallbacks.length > 0
  }

  /**
   * The manifest as the runtime should see it with a bundle attached: a content-only export cuts
   * the list to the main library, so its interactions would not load. Merged: reachable ones only.
   */
  async mergedManifest(): Promise<PackageManifest> {
    const names = this.entryNames()
    const available = this.availableLibraries()
    const kept = new Map<string, LibraryDependency>()

    // Reachable as written, or through a compatible newer minor (the rule `get()` serves files by),
    // or, for a load that asked for it, an older one: a 1.17 is then answered from the pack's 1.16.
    const consider = (dependency: LibraryDependency) => {
      if (kept.has(dependency.machineName)) return
      if (reachableFolder(dependency, names, available, this.downgrades) === undefined) return
      kept.set(dependency.machineName, dependency)
    }

    for (const dependency of this.manifest.preloadedDependencies ?? []) consider(dependency)
    // A stripped export cuts the list to the main library, but its parameters still name every
    // sub-content library (a Question Set's questions); a full export lists them in h5p.json.
    for (const dependency of await this.contentLibraries()) consider(dependency)
    // A bundle's own manifest (a hub bundle's lists its content type's usual set; the pack's is empty): kept for a package
    // whose parameters name a library only through another one.
    for (const fallback of this.fallbacks) {
      for (const dependency of fallback.manifest.preloadedDependencies ?? []) consider(dependency)
    }
    // Addons, as platforms add them on save: a bundle library whose `library.json` names the
    // content it goes with, H5P.MathDisplay for LaTeX. A content-only export lost it.
    const params = await this.contentParams()
    for (const fallback of this.fallbacks) {
      for (const { machineName, majorVersion, minorVersion, patterns } of await fallback.addons()) {
        if (textMatches(params, patterns)) consider({ machineName, majorVersion, minorVersion })
      }
    }

    return { ...this.manifest, preloadedDependencies: [...kept.values()] }
  }

  private contentJson: Promise<unknown> | null = null

  /**
   * `content/content.json`, parsed once; `undefined` when it cannot be read. Not remembered while
   * it is absent, since on an archive still arriving it may yet come.
   */
  private contentParams(): Promise<unknown> {
    if (this.contentJson) return this.contentJson
    const located = this.locate('content/content.json')
    if (!located || located.reader !== this) return Promise.resolve(undefined)
    this.contentJson = new Response(this.inflate(located.entry)).json().catch(() => undefined)
    return this.contentJson
  }

  /** The sub-content libraries `content/content.json` names; none when it cannot be read. */
  private async contentLibraries(): Promise<LibraryDependency[]> {
    return librariesNamedIn(await this.contentParams())
  }

  private addonList: Promise<Addon[]> | null = null

  /**
   * The addons this archive carries, newest of each, read once: what a platform's `loadAddons`
   * answers, for the bundle that stands in for the platform's installed libraries.
   */
  addons(): Promise<Addon[]> {
    this.addonList ??= (async () => {
      const addons: Addon[] = []
      for (const [machineName, folders] of indexLibraryFolders(this.entries.keys())) {
        const newest = folders.reduce((a, b) => (b.major > a.major || (b.major === a.major && b.minor > a.minor) ? b : a))
        const entry = this.entries.get(`${newest.folder}/library.json`)
        if (!entry) continue
        const patterns = addonPatterns(await new Response(this.inflate(entry)).json().catch(() => null))
        if (patterns.length > 0) addons.push({ machineName, majorVersion: newest.major, minorVersion: newest.minor, patterns })
      }
      return addons
    })()
    return this.addonList
  }

  assertLibrariesPresent(): void {
    const missing = this.missingLibraries()
    if (!missing) return

    throw new PlayerError('bad-archive', explainMissingLibraries(missing), {
      missingLibraries: missing
    })
  }

  /**
   * Entries that need a background inflate to be served cold (a stored or small one is cheap), in
   * archive order: it tracks the order the content uses them far better than size does.
   */
  prefetchable(): PrefetchEntry[] {
    return [...this.entries.values()]
      .filter((entry) => entry.strategy.kind === 'chunked')
      .map((entry) => ({ entry: entry.name, location: locationOf(entry) }))
  }

  /**
   * The runs of the archive worth pulling whole before the frame boots, in archive order: each
   * small library file read on demand costs a round trip, a minute for a megabyte at 0.5 s latency.
   */
  warmSpans(): WarmSpan[] {
    // A forward entry has no offset to walk from, and the archive it came from is local anyway.
    const located = [...this.entries.values()].filter((entry) => entry.zip !== undefined)
    const offsets = located.map((entry) => entry.zip!.offset).sort((a, b) => a - b)
    const nextOffset = new Map<number, number>()
    for (let i = 0; i + 1 < offsets.length; i += 1) nextOffset.set(offsets[i], offsets[i + 1])

    // Candidates: declared folders, the root and `content/`. Libraries kept for an upload check,
    // mostly editors, are often over half a package's library bytes (#148).
    const declared = this.declaredFolders()
    const booted = (name: string) => {
      const slash = name.indexOf('/')
      return slash < 0 || declared.size === 0 || name.startsWith('content/') || declared.has(name.slice(0, slash))
    }
    const candidates = located
      .filter(
        (entry) =>
          booted(entry.name) &&
          entry.strategy.kind === 'inline' &&
          !entry.zip!.encrypted &&
          (entry.method === STORED || entry.method === DEFLATE) &&
          entry.compressedSize <= WARM_ENTRY_MAX_SIZE &&
          !isMediaEntry(entry.name)
      )
      .sort((a, b) => a.zip!.offset - b.zip!.offset)

    const spans: WarmSpan[] = []
    for (const entry of candidates) {
      const zip = entry.zip!
      // The central directory's name and extra lengths are the local header's in practice; the
      // slack covers a longer local extra field for the last entry, which has no successor.
      const computed =
        zip.offset + LOCAL_HEADER_FIXED_SIZE + zip.rawFilename.length + zip.rawExtraField.length + entry.compressedSize
      const end = nextOffset.get(zip.offset) ?? Math.min(this.handle.size, computed + 4096)
      const record: WarmEntry = {
        name: entry.name,
        offset: zip.offset,
        compressedSize: entry.compressedSize,
        size: entry.size,
        method: entry.method
      }
      const last = spans[spans.length - 1]
      if (last && zip.offset - last.end <= WARM_GAP) {
        last.end = Math.max(last.end, end)
        last.entries.push(record)
      } else {
        spans.push({ start: zip.offset, end, entries: [record] })
      }
    }

    const kept: WarmSpan[] = []
    let budget = WARM_MAX_BYTES
    for (const span of spans) {
      if (!span.entries.some((entry) => isTextEntry(entry.name))) continue
      const length = span.end - span.start
      if (length > budget) continue
      budget -= length
      kept.push(span)
    }
    return kept
  }

  /**
   * Inflates an entry into a stream for `cache.put()` or a `Response`, so it is never whole in
   * memory. A forward entry has no zip.js object behind it, so `DecompressionStream` inflates it.
   */
  inflate(entry: IndexedEntry): ReadableStream<Uint8Array> {
    const zip = entry.zip
    if (!zip) return this.inflateDirect(entry)

    if (zip.encrypted) {
      throw new PlayerError('bad-archive', `${entry.name} is encrypted`)
    }
    const getData = zip.getData
    if (!getData) {
      throw new PlayerError('bad-archive', `${entry.name} has no readable data`)
    }

    const transform = new TransformStream<Uint8Array, Uint8Array>()
    // Not awaited: the consumer reads while zip.js writes. zip.js aborts the writable itself on a
    // failed inflate, so this abort is only the fallback for a rejection that skipped the stream.
    void this.blocksFor(entry, zip).then(() => getData.call(zip, transform.writable)).catch((error: unknown) => {
      // A locked writable means zip.js still holds the writer and has already errored the stream
      // on its way out; aborting it again is refused, in Chromium by throwing.
      if (transform.writable.locked) return
      try {
        void transform.writable.abort(error)
      } catch {
        // Already aborted or closed: the consumer has its error either way.
      }
    })

    return transform.readable
  }

  /**
   * Pulls a small entry's header and data into the block cache in one request before zip.js reads
   * them in pieces. Over HTTP only, up to `BLOCK_CACHE_MAX_READ`; a failure is left to zip.js.
   */
  private blocksFor(entry: IndexedEntry, zip: FileEntry): Promise<void> {
    if (this.handle.descriptor.type !== 'range-http') return Promise.resolve()
    const start = zip.offset
    // The central directory's name and extra lengths are the local header's in practice; a longer
    // local extra field only costs zip.js's data read a block of its own.
    const end = Math.min(
      this.handle.size - 1,
      start + LOCAL_HEADER_FIXED_SIZE + zip.rawFilename.length + zip.rawExtraField.length + entry.compressedSize - 1
    )
    if (end - start + 1 > BLOCK_CACHE_MAX_READ) return Promise.resolve()
    return this.handle.read({ start, end }).then(
      () => undefined,
      () => undefined
    )
  }

  /**
   * Byte range of an entry's compressed data: the local header is read to find where it starts,
   * unless a forward entry knows. A promise is kept, so a media element's burst shares one read.
   */
  dataRange(entry: IndexedEntry): Promise<ByteRange> {
    const known = this.dataRanges.get(entry.name)
    if (known) return known

    const reading = this.readDataRange(entry)
    this.dataRanges.set(entry.name, reading)
    reading.catch(() => this.dataRanges.delete(entry.name))
    return reading
  }

  private inflateDirect(entry: IndexedEntry): ReadableStream<Uint8Array> {
    if (entry.encrypted) throw new PlayerError('bad-archive', `${entry.name} is encrypted`)
    if (entry.method !== STORED && entry.method !== DEFLATE) {
      throw new PlayerError('bad-archive', `${entry.name} uses compression method ${entry.method}`)
    }
    if (entry.compressedSize === 0) return new Blob([]).stream()

    const raw = deferredStream(() => this.sliceStream(entry, { start: 0, end: entry.compressedSize - 1 }))
    return inflated(raw, entry.method, entry.compressedSize)
  }

  private async readDataRange(entry: IndexedEntry): Promise<ByteRange> {
    if (entry.dataStart !== undefined) {
      return { start: entry.dataStart, end: entry.dataStart + entry.compressedSize - 1 }
    }
    if (!entry.zip) throw new PlayerError('bad-archive', `${entry.name} has no known location`)

    const start = await readDataStart(this.handle, entry.zip.offset, entry.name)

    return { start, end: start + entry.compressedSize - 1 }
  }

  /** Streams a range of an entry's compressed bytes straight out of the source. No storage. */
  async sliceStream(entry: IndexedEntry, range: ByteRange): Promise<ReadableStream<Uint8Array>> {
    const data = await this.dataRange(entry)
    return this.handle.stream({
      start: data.start + range.start,
      end: data.start + range.end
    })
  }
}

/**
 * Where an entry's compressed bytes are, for a job that extracts it without an index of its own: a
 * central-directory entry by its local header, a forward entry by where its data begins.
 */
export function locationOf(entry: IndexedEntry): EntryLocation {
  return {
    header: entry.zip?.offset,
    dataStart: entry.dataStart,
    compressedSize: entry.compressedSize,
    size: entry.size,
    method: entry.method
  }
}

/**
 * Serving strategy: text is always inline, then size, then method, as only a large deflated entry
 * is worth a background extraction. Media has a lower bar (`MEDIA_INLINE_MAX_SIZE`).
 */
export function chooseStrategy(
  name: string,
  entry: { uncompressedSize: number; compressionMethod: number }
): Strategy {
  if (isTextEntry(name)) return { kind: 'inline' }
  const limit = isMediaEntry(name) ? MEDIA_INLINE_MAX_SIZE : INLINE_MAX_SIZE
  if (entry.uncompressedSize <= limit) return { kind: 'inline' }
  if (entry.compressionMethod === STORED) return { kind: 'slice' }
  if (entry.compressionMethod === DEFLATE) return { kind: 'chunked' }
  // Anything else (zstd, bzip2, an encrypted entry) still works through zip.js if a codec is
  // registered, so it takes the inline path rather than being refused outright.
  return { kind: 'inline' }
}

/* ------------------------------------------------------------------ manifest and libraries */

function entryFromForward(name: string, forward: ForwardEntry): IndexedEntry {
  return {
    name,
    size: forward.uncompressedSize,
    compressedSize: forward.compressedSize,
    method: forward.method,
    strategy: chooseStrategy(name, {
      uncompressedSize: forward.uncompressedSize,
      compressionMethod: forward.method
    }),
    dataStart: forward.dataStart,
    encrypted: forward.encrypted
  }
}

function topFolderOf(name: string): string | null {
  const slash = name.indexOf('/')
  return slash < 0 ? null : name.slice(0, slash)
}

/** `h5p.json` parsed; an unreadable one, or one that is not an object, is a `bad-archive` error. */
async function readManifest(reader: PackageReader): Promise<PackageManifest> {
  const { entry } = reader.get('h5p.json')!

  try {
    const parsed = (await new Response(reader.inflate(entry)).json()) as PackageManifest
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object')
    return parsed
  } catch (error) {
    throw new PlayerError('bad-archive', 'h5p.json is not readable JSON', { cause: error })
  }
}

/**
 * A dependency served at an older minor than asked, as `checkDependencies` reports it: only from a
 * versioned folder of the same major, the one a downgrade picks. An unversioned folder is not one.
 */
function olderThanAsked(dependency: LibraryDependency, located: LocatedEntry, library: unknown): DowngradedLibrary | null {
  const folder = located.entry.name.slice(0, located.entry.name.indexOf('/'))
  const served = parseLibraryFolder(folder)
  const wanted = { major: Number(dependency.majorVersion), minor: Number(dependency.minorVersion) }
  if (!served || served.machineName !== dependency.machineName || served.major !== wanted.major || served.minor >= wanted.minor) return null
  const patch = (library as { patchVersion?: unknown } | null)?.patchVersion
  const patchVersion = typeof patch === 'number' && Number.isInteger(patch) && patch >= 0 ? patch : typeof patch === 'string' && /^\d+$/.test(patch) ? Number(patch) : 0
  return { library: dependency.machineName, from: `${wanted.major}.${wanted.minor}`, to: `${served.major}.${served.minor}.${patchVersion}` }
}

/**
 * What a package declares but does not carry, or `null` when it carries all. Exports from h5p.com
 * and h5p.org leave libraries out, so elsewhere the runtime 404s on its main library.
 */
export function describeMissingLibraries(
  entryNames: ReadonlySet<string>,
  manifest: PackageManifest,
  downgrade = false
): MissingLibraries | null {
  const dependencies = manifest.preloadedDependencies

  if (!Array.isArray(dependencies) || dependencies.length === 0) {
    return { mainLibrary: manifest.mainLibrary, folders: [], all: true }
  }

  const missing = findMissingLibraries(entryNames, manifest, downgrade)
  if (missing.length === 0) return null

  return {
    mainLibrary: manifest.mainLibrary,
    // An old export lists a library once for each library that needs it, so it is named once.
    folders: [...new Set(missing.map((dependency) => libraryFolderNames(dependency)[0]))],
    all: missing.length === dependencies.length
  }
}

export function explainMissingLibraries(missing: MissingLibraries): string {
  if (missing.folders.length === 0) {
    return 'h5p.json lists no preloadedDependencies, so there is nothing to run'
  }

  const names = missing.folders.join(', ')

  if (missing.carried) {
    return (
      `This package is played untrusted, so its own copy of ${names} does not run, and the ` +
      `library sources do not have ${missing.folders.length === 1 ? 'it' : 'them'}. Play it trusted only if you trust ` +
      `where it came from.`
    )
  }

  return missing.all
    ? `This package contains no libraries, only content. Exports from h5p.com and h5p.org ` +
        `often leave them out because the site they came from already has them. ` +
        `Set the "libraries" attribute to fetch them, or re-export with them included. ` +
        `Missing: ${names}`
    : `This package is missing ${missing.folders.length} of its libraries: ${names}. ` +
        `Set the "libraries" attribute to fetch them, or re-export with them included.`
}
