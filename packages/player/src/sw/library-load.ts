import type { LibraryLoad } from '../shared/protocol.js'
import { dependenciesIn, type LibraryDependency, type PackageManifest } from '../shared/content-libraries.js'

/**
 * What the frame loads and in what order, on the `boot` route: every library the content needs,
 * dependencies first. The order is h5p-standalone's, the one every content type was played in.
 */

/** One library as the walk found it: the folder that answered, and what its `library.json` says. */
export interface WalkedLibrary {
  folder: string
  machineName: string
  major: number
  minor: number
  /** Its `preloadedDependencies`, as the dependencies were written. */
  dependencies: LibraryDependency[]
  /** Its `preloadedJs` and `preloadedCss`, as entry names under the package's root. */
  scripts: string[]
  styles: string[]
}

/** How the walk finds a library: the folder that answers for it and its parsed `library.json`, or null. */
export type LibraryLookup = (dependency: LibraryDependency) => Promise<{ folder: string; library: unknown } | null>

/** A dependency by name and version, as a map key; a folder may answer for more than one. */
const keyOf = (dependency: LibraryDependency) => `${dependency.machineName} ${dependency.majorVersion}.${dependency.minorVersion}`

/**
 * The libraries `roots` need, in the order h5p-standalone's `loadDependencies` found them: roots
 * first, then a level at a time. A library nothing answers for goes to `missing`, its own unwalked.
 */
export async function walkLibraries(
  roots: readonly LibraryDependency[],
  lookup: LibraryLookup
): Promise<{ libraries: WalkedLibrary[]; folderOf: Map<string, string>; missing: string[] }> {
  const libraries: WalkedLibrary[] = []
  const byFolder = new Map<string, WalkedLibrary>()
  /** Which folder answered for each dependency, by `keyOf`. */
  const folderOf = new Map<string, string>()
  const missing: string[] = []
  const asked = new Set<string>()
  /** Those not asked for yet, each once, and from now on asked. */
  const unasked = (dependencies: LibraryDependency[]) =>
    dependencies.filter((dependency) => {
      const key = keyOf(dependency)
      if (asked.has(key)) return false
      asked.add(key)
      return true
    })

  let level = unasked([...roots])
  while (level.length > 0) {
    const answers = await Promise.all(level.map((dependency) => lookup(dependency)))
    const found: WalkedLibrary[] = []
    answers.forEach((answer, index) => {
      const dependency = level[index]
      if (!answer) {
        missing.push(`${dependency.machineName}-${dependency.majorVersion}.${dependency.minorVersion}`)
        return
      }
      folderOf.set(keyOf(dependency), answer.folder)
      // One folder can answer two requests (1.0 asked, 1.1 served): it loads once.
      if (byFolder.has(answer.folder)) return
      const library = walkedLibrary(answer.folder, answer.library, dependency)
      byFolder.set(answer.folder, library)
      libraries.push(library)
      found.push(library)
    })
    level = unasked(found.flatMap((library) => library.dependencies))
  }
  return { libraries, folderOf, missing }
}

/**
 * The scripts and stylesheets of `libraries`, dependencies first, edge for edge as h5p-standalone's
 * `sortDependencies`. A library with no dependencies keeps its edge to `undefined`, for the ties.
 */
export function loadOrder(libraries: readonly WalkedLibrary[], folderOf: ReadonlyMap<string, string>): { scripts: string[]; styles: string[] } {
  const edges: Array<[string, string | undefined]> = []
  const byFolder = new Map(libraries.map((library) => [library.folder, library]))
  for (const library of libraries) {
    const dependencies = library.dependencies.flatMap((dependency) => folderOf.get(keyOf(dependency)) ?? [])
    if (dependencies.length === 0) edges.push([library.folder, undefined])
    for (const dependency of dependencies) edges.push([library.folder, dependency])
  }

  const scripts: string[] = []
  const styles: string[] = []
  for (const folder of toposort(edges).reverse()) {
    const library = folder === undefined ? undefined : byFolder.get(folder)
    if (!library) continue
    scripts.push(...library.scripts)
    styles.push(...library.styles)
  }
  return { scripts, styles }
}

/**
 * What the frame loads: the main library as served, the files in order, and `directories` for the
 * folders `H5P.getLibraryPath` cannot name by version. `null` when the main library was not found.
 */
export function libraryLoad(
  manifest: PackageManifest,
  walk: { libraries: readonly WalkedLibrary[]; folderOf: ReadonlyMap<string, string> }
): Omit<LibraryLoad, 'upgrades'> | null {
  const main = (manifest.preloadedDependencies ?? []).find((dependency) => dependency.machineName === manifest.mainLibrary)
  const mainFolder = main && walk.folderOf.get(keyOf(main))
  const served = mainFolder === undefined ? undefined : walk.libraries.find((library) => library.folder === mainFolder)
  if (!served) return null

  const directories: Record<string, string> = {}
  for (const library of walk.libraries) {
    const named = `${library.machineName}-${library.major}.${library.minor}`
    if (library.folder !== named) directories[named] = library.folder
  }
  return { library: `${served.machineName} ${served.major}.${served.minor}`, ...loadOrder(walk.libraries, walk.folderOf), directories }
}

/** A `library.json` as the walk needs it; untrusted, so every field is held to its shape. */
function walkedLibrary(folder: string, library: unknown, asked: LibraryDependency): WalkedLibrary {
  const json = (library ?? {}) as Record<string, unknown>
  const version = (part: unknown, fallback: number) =>
    typeof part === 'number' && Number.isInteger(part) && part >= 0 ? part : typeof part === 'string' && /^\d+$/.test(part) ? Number(part) : fallback
  return {
    folder,
    machineName: typeof json.machineName === 'string' ? json.machineName : asked.machineName,
    major: version(json.majorVersion, Number(asked.majorVersion)),
    minor: version(json.minorVersion, Number(asked.minorVersion)),
    dependencies: dependenciesIn(json),
    scripts: filesIn(folder, json.preloadedJs),
    styles: filesIn(folder, json.preloadedCss)
  }
}

/**
 * A `preloadedJs` or `preloadedCss` as entry names `<folder>/<path>`, in order. A path that leaves
 * the folder (absolute, with a scheme, or with `..`) is dropped: the archive is untrusted.
 */
export function filesIn(folder: string, files: unknown): string[] {
  if (!Array.isArray(files)) return []
  return files.flatMap((file) => {
    const path = (file as { path?: unknown } | null)?.path
    if (typeof path !== 'string' || !path || /^[\\/]|^[a-z][a-z\d+.-]*:|(?:^|[\\/])\.\.(?:[\\/]|$)/i.test(path)) return []
    return [`${folder}/${path}`]
  })
}

/**
 * `toposort` 2.0.2 by Marcel Klehr (MIT), as h5p-standalone bundles it, but for a cycle: the edge
 * that closes one is passed over instead of thrown on, and the rest still sorts.
 */
export function toposort<T>(edges: ReadonlyArray<readonly [T, T]>): T[] {
  const nodes = [...new Set(edges.flatMap(([from, to]) => [from, to]))]
  const outgoing = new Map<T, Set<T>>()
  for (const [from, to] of edges) {
    if (!outgoing.has(from)) outgoing.set(from, new Set())
    if (!outgoing.has(to)) outgoing.set(to, new Set())
    outgoing.get(from)!.add(to)
  }

  let cursor = nodes.length
  const sorted = new Array<T>(cursor)
  const visited = new Set<T>()
  const visit = (node: T) => {
    if (visited.has(node)) return
    visited.add(node)
    const children = [...(outgoing.get(node) ?? [])]
    for (let child = children.length - 1; child >= 0; child--) visit(children[child])
    sorted[--cursor] = node
  }
  for (let index = nodes.length - 1; index >= 0; index--) visit(nodes[index])
  return sorted
}
