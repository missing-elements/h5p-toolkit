/**
 * `@missing-elements/h5p-offline-player/plan`: the library rules for author (#106) and embed (#109),
 * free of zip.js, for Node and a page. Not in docs/compatibility.md: depend on an exact version.
 */

export { addonPatterns, dependenciesIn, librariesNamedIn, textMatches, type LibraryDependency, type PackageManifest } from './shared/content-libraries.js'
export {
  findMissingLibraries,
  indexLibraryFolders,
  libraryFolderNames,
  parseLibraryFolder,
  reachableFolder,
  resolveLibraryFolder,
  walkDependencies,
  type LibraryFolder
} from './shared/library-folders.js'
export { packLibrariesIn } from './shared/pack.js'
export { ownLibraries, planPack, type OwnLibrary, type PlanInput, type ProvidedLibrary } from './sw/pack-plan.js'
export type { PackDependency, PackLibrary, PackPart, PackPlan, RefreshedLibrary } from './shared/protocol.js'
