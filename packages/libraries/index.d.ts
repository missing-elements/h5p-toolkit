// Written by scripts/parts.mjs. Do not edit; run `pnpm parts` in packages/libraries.

export interface PackDependency {
  machineName: string
  majorVersion: number
  minorVersion: number
}

/** One library of the pack, as `parts/index.json` describes it, and where its part is. */
export interface PackLibrary {
  /** `<machineName>-<major>.<minor>`, the folder the part holds. */
  folder: string
  machineName: string
  majorVersion: number
  minorVersion: number
  patchVersion: number
  /** The dependencies its `library.json` declares. */
  preloadedDependencies?: PackDependency[]
  dynamicDependencies?: PackDependency[]
  editorDependencies?: PackDependency[]
  /** For an addon, the content it is added to, as its `library.json` says. */
  addTo?: unknown
  /**
   * Carried for an H5P site's upload check only (it wants a carried library's dependencies at
   * their exact major.minor): an editor library or an older minor. Only `install.js` has these.
   */
  installOnly?: true
  /** The part's size in bytes. */
  size: number
  /** The part's SHA-256, in hex. */
  sha256: string
  url: string
}

/** For `<h5p-player>`'s `pack` property. */
export declare const pack: { libraries: PackLibrary[] }
