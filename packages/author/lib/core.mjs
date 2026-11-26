/**
 * @missing-elements/h5p-author/core: what needs neither Node nor a page, for a tool that runs
 * beside a build in either. `.` and `./browser` carry all of it, each with its own `buildPackage`.
 */

export { bundleLibraries, contentTypes } from './bundle.mjs'
export { checkContent } from './check.mjs'
export { outlineOf } from './outline.mjs'
export { ContentGenerator, librariesIn, libraryString } from './generator.mjs'
export { coreApiLine, coreApiOf, missingForInstall } from './install.mjs'
export { loadLibraries, packageLibraries } from './libraries.mjs'
export { lengthLine, mediaLine } from './media.mjs'
export { sourceType } from './names.mjs'
export { GENERATED_END, GENERATED_START } from './schema.mjs'
export { SourceError } from './source-error.mjs'
export { sourceSchema } from './source-schema.mjs'
export { allowedTags, editorWidget, markupText, plainText, takesMarkup } from './text.mjs'

/**
 * @typedef {import('./build.mjs').Source} Source
 * @typedef {import('./check.mjs').CheckedContent} CheckedContent
 * @typedef {import('./install.mjs').CoreApi} CoreApi
 * @typedef {import('./generator.mjs').GeneratorOptions} GeneratorOptions
 * @typedef {import('./generator.mjs').PackEntry} PackEntry
 * @typedef {import('./libraries.mjs').LibraryRecord} LibraryRecord
 * @typedef {import('./libraries.mjs').LibrarySource} LibrarySource
 * @typedef {import('./libraries.mjs').LoadedLibraries} LoadedLibraries
 * @typedef {import('./libraries.mjs').PackageFiles} PackageFiles
 * @typedef {import('./translate.mjs').TranslationReport} TranslationReport
 * @typedef {import('./pack.mjs').IndexEntry} IndexEntry
 * @typedef {import('./pack.mjs').PartLibrary} PartLibrary
 */
