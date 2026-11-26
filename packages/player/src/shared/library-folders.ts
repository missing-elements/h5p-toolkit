/**
 * Which folder serves a library, and the walk through what libraries need in turn. Pure, no zip.js,
 * so the reader, the plan and `./plan` users decide by one rule (#109).
 */

import { dependenciesIn, type LibraryDependency, type PackageManifest } from './content-libraries.js'

export interface LibraryFolder {
  machineName: string
  major: number
  minor: number
  folder: string
}

/** Splits `H5P.Text-1.1` into its parts, or returns `null` for a folder that is not a library. */
export function parseLibraryFolder(folder: string): LibraryFolder | null {
  const match = /^(.+)-(\d+)\.(\d+)$/.exec(folder)
  if (!match) return null
  return {
    machineName: match[1],
    major: Number(match[2]),
    minor: Number(match[3]),
    folder
  }
}

/** Every library folder in a set of entry names, grouped by machine name. */
export function indexLibraryFolders(entryNames: Iterable<string>): Map<string, LibraryFolder[]> {
  const byName = new Map<string, LibraryFolder[]>()

  for (const name of entryNames) {
    const slash = name.indexOf('/')
    if (slash < 0 || name.slice(slash + 1) !== 'library.json') continue

    const parsed = parseLibraryFolder(name.slice(0, slash))
    if (!parsed) continue

    const existing = byName.get(parsed.machineName)
    if (existing) existing.push(parsed)
    else byName.set(parsed.machineName, [parsed])
  }

  return byName
}

/**
 * The two folder names a library may be stored under, tried in this order: the versioned one, and
 * the bare machine name older packages use.
 */
export function libraryFolderNames(dependency: LibraryDependency): string[] {
  return [
    `${dependency.machineName}-${dependency.majorVersion}.${dependency.minorVersion}`,
    dependency.machineName
  ]
}

/**
 * Picks the folder satisfying a dependency: the same major, a minor at least as high, the lowest
 * winning. `downgrade` (#85) is the last resort: only once every source was tried, never for an archive still arriving.
 */
export function resolveLibraryFolder(
  available: Map<string, LibraryFolder[]>,
  dependency: { machineName: string; major: number; minor: number },
  downgrade = false
): string | undefined {
  const sameMajor = (available.get(dependency.machineName) ?? []).filter((candidate) => candidate.major === dependency.major)
  // Content for an older minor is upgraded by the frame (`content-upgrade.ts` in the runtime).
  const satisfying = sameMajor.filter((candidate) => candidate.minor >= dependency.minor).sort((a, b) => a.minor - b.minor)
  if (satisfying.length > 0 || !downgrade) return satisfying[0]?.folder

  // The newest older minor, for h5p.com content past the pack's: one bump in four moves fields.
  return [...sameMajor].sort((a, b) => b.minor - a.minor)[0]?.folder
}

/**
 * The folder a dependency is served from: as written or the bare machine name, if its
 * `library.json` is in `names`; else a compatible minor of `available`, or older with `downgrade`.
 */
export function reachableFolder(
  dependency: LibraryDependency,
  names: ReadonlySet<string>,
  available: Map<string, LibraryFolder[]>,
  downgrade = false
): string | undefined {
  return (
    libraryFolderNames(dependency).find((folder) => names.has(`${folder}/library.json`)) ??
    resolveLibraryFolder(
      available,
      {
        machineName: dependency.machineName,
        major: Number(dependency.majorVersion),
        minor: Number(dependency.minorVersion)
      },
      downgrade
    )
  )
}

/**
 * The dependencies `h5p.json` declares that the archive does not actually carry. Pure, so the
 * rule can be checked without building a zip.
 */
export function findMissingLibraries(
  entryNames: ReadonlySet<string>,
  manifest: PackageManifest,
  downgrade = false
): LibraryDependency[] {
  const dependencies = manifest.preloadedDependencies
  if (!Array.isArray(dependencies)) return []

  const available = indexLibraryFolders(entryNames)

  return dependencies.filter((dependency) => reachableFolder(dependency, entryNames, available, downgrade) === undefined)
}

/**
 * The walk before boot (`PackageReader.checkDependencies`) and the SCORM write, a level at a time
 * from `roots`, so a server answers each level from cache. Returns `missing` and `found`, once each.
 */
export async function walkDependencies<T>(
  roots: Iterable<LibraryDependency>,
  locate: (dependency: LibraryDependency) => T | undefined,
  read: (located: T, dependency: LibraryDependency) => Promise<unknown>
): Promise<{ missing: LibraryDependency[]; found: Array<{ dependency: LibraryDependency; located: T; library: unknown }> }> {
  const missing: LibraryDependency[] = []
  const found: Array<{ dependency: LibraryDependency; located: T; library: unknown }> = []
  const seen = new Set<string>()
  let level = [...roots]

  while (level.length > 0) {
    const next: LibraryDependency[] = []
    await Promise.all(
      level.map(async (dependency) => {
        const key = libraryFolderNames(dependency)[0]
        if (seen.has(key)) return
        seen.add(key)
        const located = locate(dependency)
        if (located === undefined) {
          missing.push(dependency)
          return
        }
        // A `read` that throws ends the walk: counted as none, it would pass a tree it never saw.
        const library = await read(located, dependency)
        found.push({ dependency, located, library })
        next.push(...dependenciesIn(library))
      })
    )
    level = next
  }

  return { missing, found }
}
