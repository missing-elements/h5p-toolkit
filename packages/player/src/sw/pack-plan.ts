import type { PackDependency, PackLibrary, PackPart, PackPlan, RefreshedLibrary } from '../shared/protocol.js'
import { addonPatterns, dependenciesIn, textMatches } from '../shared/content-libraries.js'
import { parseLibraryFolder } from '../shared/library-folders.js'

/**
 * Which parts of the library pack a package needs, and which of its own library folders the pack's
 * newer version of the same major replaces. Pure, so Node tests the rules; the worker feeds it.
 */

/** A library folder the package carries, as its `library.json` says, when that was read. */
export interface OwnLibrary {
  folder: string
  machineName: string
  /**
   * `null` for an unversioned folder whose `library.json` was not read: the library at a version
   * unknown, which satisfies any request for it, as the runtime's fallback to the bare name does.
   */
  major: number | null
  minor: number | null
  /** `null` when the `library.json` was not read and the version is the folder name's: no refresh then. */
  patch: number | null
  /** `null` when the `library.json` was not read: its dependencies are followed later. */
  dependencies: PackDependency[] | null
}

/** A library folder an archive already attached provides: a part, or a bundle. */
export interface ProvidedLibrary {
  folder: string
  machineName: string
  major: number
  minor: number
}

/**
 * What a package carries of its libraries, from its top-level folders holding a `library.json`.
 * With `read` the version and dependencies come from it, else from the folder name (cheaper).
 */
export async function ownLibraries(
  folders: Iterable<string>,
  read?: (folder: string) => Promise<unknown>,
  readable?: (folder: string) => boolean
): Promise<OwnLibrary[]> {
  const version = (part: unknown) => (typeof part === 'number' && Number.isInteger(part) && part >= 0 ? part : typeof part === 'string' && /^\d+$/.test(part) ? Number(part) : null)
  const libraries: OwnLibrary[] = []
  for (const folder of folders) {
    const parsed = parseLibraryFolder(folder)
    if (!read || (readable && !readable(folder))) {
      libraries.push(
        parsed
          ? { folder, machineName: parsed.machineName, major: parsed.major, minor: parsed.minor, patch: null, dependencies: null }
          : { folder, machineName: folder, major: null, minor: null, patch: null, dependencies: null }
      )
      continue
    }
    const library = (await Promise.resolve()
      .then(() => read(folder))
      .catch(() => null)) as Record<string, unknown> | null
    const major = version(library?.majorVersion)
    const minor = version(library?.minorVersion)
    const machineName = library?.machineName
    if (typeof machineName !== 'string' || major === null || minor === null) continue
    if (parsed ? parsed.machineName !== machineName || parsed.major !== major : folder !== machineName) continue
    libraries.push({
      folder,
      machineName,
      major,
      minor,
      patch: version(library?.patchVersion) ?? 0,
      dependencies: dependenciesIn(library).map(({ machineName: name, majorVersion, minorVersion }) => ({
        machineName: name,
        majorVersion: Number(majorVersion),
        minorVersion: Number(minorVersion)
      }))
    })
  }
  return libraries
}

export interface PlanInput {
  own: OwnLibrary[]
  provided: ProvidedLibrary[]
  /** What `h5p.json` declares and the parameters name as sub-content. */
  roots: PackDependency[]
  /** The content's parameters, for the addons' patterns; `undefined` when not read. */
  params: unknown
  pack: ReadonlyArray<PackLibrary & { url: string }>
  refresh: boolean
  fill: boolean
  /** Supply the pack's older minor of what nothing has at the minor named. */
  downgrade?: boolean
}

interface Request {
  dependency: PackDependency
  /** Asked for by the content or the package's own libraries, rather than by a part. */
  fromContent: boolean
}

export function planPack(input: PlanInput): PackPlan | null {
  // What the pack carries for an H5P site's upload check only, the editor libraries and the older
  // minors (#146), is never planned: the player serves the newest of each major, as before.
  const served = input.pack.filter((library) => !library.installOnly)
  const byLibrary = new Map(served.map((library) => [libraryKey(library.machineName, library.majorVersion), library]))
  const providedFolders = new Set(input.provided.map(({ folder }) => folder))
  const planned = new Map<string, PackLibrary & { url: string }>()
  const superseded: string[] = []
  const refreshed: RefreshedLibrary[] = []
  let own = [...input.own]

  const supersede = (library: OwnLibrary, by: PackLibrary) => {
    own = own.filter((each) => each !== library)
    superseded.push(library.folder)
    refreshed.push({ library: library.machineName, from: ownVersion(library), to: packVersion(by) })
  }

  /** Plans a part, and returns its own requests, which come from a part. */
  const plan = (library: PackLibrary & { url: string }): Request[] => {
    if (planned.has(library.folder) || providedFolders.has(library.folder)) return []
    planned.set(library.folder, library)
    return (library.preloadedDependencies ?? []).map((dependency) => ({ dependency, fromContent: false }))
  }

  const queue: Request[] = []

  if (input.refresh) {
    for (const library of input.own) {
      // Only a library read from its `library.json` has a patch: one nothing plays stays (#148).
      if (library.patch === null || library.major === null) continue
      const candidate = byLibrary.get(libraryKey(library.machineName, library.major))
      if (!candidate || !newer(candidate, library)) continue
      // A bundle listed before the pack with this major would answer for the withheld folder: the
      // package keeps its own, as a bundle fills gaps only and must not pass for the pack's (#58).
      if (input.provided.some((each) => each.machineName === library.machineName && each.major === library.major)) continue
      supersede(library, candidate)
      queue.push(...plan(candidate))
    }
  }

  const satisfies = (version: { machineName: string; major: number | null; minor: number | null }, dependency: PackDependency) =>
    version.machineName === dependency.machineName &&
    (version.major === null || (version.major === dependency.majorVersion && version.minor !== null && version.minor >= dependency.minorVersion))

  const seen = new Set<string>()
  const resolve = () => {
    while (queue.length > 0) {
      const { dependency, fromContent } = queue.shift()!
      const key = `${libraryKey(dependency.machineName, dependency.majorVersion)}.${dependency.minorVersion}:${fromContent}`
      if (seen.has(key)) continue
      seen.add(key)

      const carried = own.find((library) => satisfies(library, dependency))
      if (carried) {
        for (const each of carried.dependencies ?? []) queue.push({ dependency: each, fromContent: true })
        continue
      }
      const ready = [...planned.values()].some((library) =>
        satisfies({ machineName: library.machineName, major: library.majorVersion, minor: library.minorVersion }, dependency)
      )
      if (ready || input.provided.some((library) => satisfies(library, dependency))) continue

      if (fromContent && !input.fill) continue
      const candidate = byLibrary.get(libraryKey(dependency.machineName, dependency.majorVersion))
      if (!candidate) continue
      if (candidate.minorVersion < dependency.minorVersion) {
        if (!input.downgrade) continue
        // Nothing has the minor named: the newest older one plays it. What the package carries or
        // a source provides may already be as new as the pack's, and is then the one served.
        const here = [
          ...own.flatMap((library) => (library.major === null || library.minor === null ? [] : [{ ...library, major: library.major, minor: library.minor }])),
          ...[...planned.values()].map((library) => ({ machineName: library.machineName, major: library.majorVersion, minor: library.minorVersion })),
          ...input.provided
        ].filter((library) => library.machineName === dependency.machineName && library.major === dependency.majorVersion)
        const newest = here.reduce<(typeof here)[number] | undefined>((best, library) => (!best || library.minor > best.minor ? library : best), undefined)
        if (newest && newest.minor >= candidate.minorVersion) {
          const carriedOlder = own.find((library) => library.machineName === newest.machineName && library.major === newest.major && library.minor === newest.minor)
          for (const each of carriedOlder?.dependencies ?? []) queue.push({ dependency: each, fromContent: true })
          continue
        }
      }
      // An older minor the package carries gives way to the version that satisfies both, or that
      // comes closest to what the content names.
      const older = own.find((library) => library.machineName === dependency.machineName && library.major === dependency.majorVersion)
      if (older) supersede(older, candidate)
      queue.push(...plan(candidate))
    }
  }

  queue.push(...input.roots.map((dependency) => ({ dependency, fromContent: true })))
  resolve()

  // Addons, as platforms add them on save, when refreshing or when a part is planned: a package
  // played as exported, with nothing from the pack, gets none.
  if (input.refresh || planned.size > 0) {
    for (const addon of served) {
      if (addon.addTo === undefined) continue
      const present = (machineName: string) => machineName === addon.machineName
      if (own.some((library) => present(library.machineName)) || input.provided.some((library) => present(library.machineName))) continue
      if (!textMatches(input.params, addonPatterns({ addTo: addon.addTo }))) continue
      queue.push(...plan(addon))
    }
    resolve()
  }

  if (planned.size === 0 && superseded.length === 0) return null
  return {
    parts: [...planned.values()].map(({ folder, url, size, sha256 }): PackPart => ({ folder, url, size, sha256 })),
    superseded,
    refreshed
  }
}

function libraryKey(machineName: string, major: number): string {
  return `${machineName} ${major}`
}

function newer(candidate: PackLibrary, library: OwnLibrary): boolean {
  if (library.minor === null) return false
  if (candidate.minorVersion !== library.minor) return candidate.minorVersion > library.minor
  return candidate.patchVersion > (library.patch ?? Number.POSITIVE_INFINITY)
}

function ownVersion(library: OwnLibrary): string {
  if (library.major === null) return 'unknown'
  return `${library.major}.${library.minor}${library.patch === null ? '' : `.${library.patch}`}`
}

function packVersion(library: PackLibrary): string {
  return `${library.majorVersion}.${library.minorVersion}.${library.patchVersion}`
}
