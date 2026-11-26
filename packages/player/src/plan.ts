/**
 * `@missing-elements/h5p-offline-player/plan`: the library rules, shared with the packages that
 * write what it plays. Not in docs/compatibility.md: depend on an exact version (#106).
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
