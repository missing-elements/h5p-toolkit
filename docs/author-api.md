# h5p-author: the API

What [`@missing-elements/h5p-author`](https://github.com/missing-elements/h5p-toolkit/tree/main/packages/author#readme)
exports, for a program that builds, reads or checks packages itself. Its command line and the
source's fields are in the package's README.

## In Node

```js
import { join, resolve } from 'node:path'
import { buildPackage, publicFetch, SourceError } from '@missing-elements/h5p-author'

// A build run on what a model wrote: files only from `folder`, nothing from a local network.
const folder = resolve('work')
try {
  const { notes, outline } = await buildPackage(source, join(folder, 'rivers.h5p'), { base: folder, within: [folder], fetch: publicFetch })
} catch (error) {
  if (!(error instanceof SourceError)) throw error // an existing output, a file outside `within`
  console.log(error.problems) // [{ path, message }]
}
```

| Export | What it does |
|---|---|
| `buildPackage(source, output, options)` | Builds a package and writes it. It refuses an existing output, and throws a `SourceError` with the source's `problems` |
| `readPackage(file, folder, { libraries, within })` | Reads a package into its source, as `read` does: `{ output, source, files, notes }`. With `within`, the package and the folder must be inside those folders |
| `describeMedia(sources, { base, within, fetch })` | Says what files are, as `media` does: for each, `{ source, kind, format, width, height, seconds, host, notes, problem }` with only what was read |
| `schemaOf(machineName, { markdown, all, libraries })` | A content type's field list, as `schema` prints it |
| `writeBundle(type, output, { libraries })`, `writeBundles(folder, { libraries })` | Write bundles: each `{ output, type, parts, size }` |
| `sourceSchema` | A source's own fields as a zod/mini schema. For JSON Schema, call `toJSONSchema(sourceSchema, { io: 'input' })` from a zod 4.2 or later of your own. A build reads a source more loosely: check one with `check`, not with the schema alone |
| `sourceType(source, names)` | The content type a source means, of the machine names given, as a build reads it; `null` where none can be meant, and for the quiz format |
| `publicFetch` | A `fetch` that refuses an address on a local network, redirects included |
| `inside(path, folders)` | Whether a path, links followed, is in one of the folders: the check `within` applies |
| `coreApiLine(coreApi)`, `lengthLine(length)`, `mediaLine(facts)` | One line each, as the command line says them |
| `missingForInstall(libraries)` | What a site with no library installed would refuse a package for, from its `library.json` files |
| `contentTypes(pack)`, `bundleLibraries(pack, type)` | The pack's content types, and a bundle's parts |

`buildPackage`'s options:

| Option | Meaning |
|---|---|
| `base` | The folder a source's file paths start from |
| `libraries` | Another copy of the pack's `parts/` folder |
| `within` | The folders the output and every local file the source names must be inside, on their real paths. Problems then name no path but the one the source wrote |
| `fetch` | For media named by web address, and for asking YouTube and Vimeo; the global one by default |
| `check` | Builds and writes no package; pass `undefined` as the output. A file named by web address is still downloaded, to a temporary folder removed after |
| `unread` | With `check`, for a source whose files are elsewhere: no file is looked for, none downloaded and no site asked. A file is judged by its name alone |

Its result:

| Field | Meaning |
|---|---|
| `output` | The package's path |
| `source`, `builtWith` | The source as built, and the content type's version it names, `H5P.Blanks 1.14`. `buildPackage` writes the package alone: write the source beside it, as the command line does |
| `manifest`, `content` | The package's `h5p.json` and `content.json` |
| `libraries`, `install` | The library folders the package plays with, and those carried for a site's upload check |
| `coreApi` | The newest H5P core they ask for, `{ majorVersion, minorVersion }` |
| `translations` | For each library, the translation its interface texts came from, and what stayed English |
| `notes` | The build's notes, each `{ path, message }`: what is almost surely a mistake, what was placed by numbers alone |
| `media`, `unread` | The files copied in, and with `unread` the names judged unread |
| `lengths` | The length each Interactive Video's times were held to: `{ file, seconds, host }`, with `host` only for a hosted video |
| `outline` | The content as plain lines for a review: what the author wrote, right answers marked, slides and questions numbered, interface texts left out |

## For a tool beside the build

| Export | What it does |
|---|---|
| `openPack(libraries)` | Opens the pinned pack, or another copy's `parts/` folder; `close()` it after |
| `loadLibraries(pack, { type, language, params })` | Loads what a content brings in, with semantics in its language: `{ entries, main, translations }` |
| `packageLibraries({ names, read }, pack)` | A package's own libraries where it carries them, and the pack's for the rest |
| `checkContent(libraries, content)` | The check a build runs last on what it writes: `{ params, problems, notes }` |
| `outlineOf(libraries, content, { limit })` | The outline of a content, cut at `limit` lines |
| `ContentGenerator` | The engine underneath: `new ContentGenerator(entries).generate(main, params)` |
| `markupText(value, field, report)`, `plainText(value, note)`, `allowedTags(field)` | The build's rules for one text value against its field |

A tool that changes a saved package checks what it is about to write with `checkContent`:

```js
import { checkContent, loadLibraries, openPack, packageLibraries } from '@missing-elements/h5p-author'

// `names`, the package's entry names; `read(name)`, an entry's text: from zip.js, or any reader.
const manifest = JSON.parse(await read('h5p.json'))
const main = manifest.preloadedDependencies.find((each) => each.machineName === manifest.mainLibrary)
const params = edited(JSON.parse(await read('content/content.json')))
const content = { type: `${main.machineName} ${main.majorVersion}.${main.minorVersion}`, language: manifest.language, params }
const pack = await openPack()
try {
  const libraries = await loadLibraries(await packageLibraries({ names, read }, pack), content)
  const { params: checked, problems, notes } = checkContent(libraries, content)
} finally {
  await pack.close()
}
```

- It takes what H5P saves as it is, and keeps each part's `subContentId`, so a learner's record
  stays the part's after an edit. A part without one, or with another part's, gets a new one.
- Where the content names an older minor of a library, a field only that minor has is a note:
  the player upgrades such content as it plays.
- Content saved by the platforms can hold what the build does not allow, such as a required text
  left empty. A tool that changes one part keeps the problems under the paths it changed.

## In a page

`@missing-elements/h5p-author/browser` is the same build in a page, or in a Tauri window. The
libraries come from a pack the page can reach, a source's files are `File`s or `Blob`s, and the
package comes back as a `Blob`.

```js
import { pack } from '@missing-elements/h5p-libraries/install'
import { buildPackage, openPack, SourceError } from '@missing-elements/h5p-author/browser'

const libraries = await openPack(pack) // once, for the page's builds
const { blob, notes } = await buildPackage(source, { libraries, files: { 'volga.png': input.files[0] } })
```

- **`openPack(pack)`** takes the `pack` export of `@missing-elements/h5p-libraries/install`, or
  the address of a copy of the pack's `parts/` folder, as a site serves it to `<h5p-player>`'s
  `pack-base`. The libraries package's main `pack` export lacks the libraries a site's upload
  check wants, so a build from it is refused. Each part is fetched when a build first needs it,
  and checked against the index's SHA-256. `close()` the pack when the page is done.
- **`buildPackage(source, { libraries, files, linked, fetch })`** returns the same fields as in
  Node, with `blob` in place of `output` and `linked` in place of `unread`.
  - `libraries`: a pack that `openPack` opened, or what to open one from for this build alone.
  - `files`: the files a source names, by the names it gives them, as an object or a `Map`.
  - `linked`: videos and recordings that stay where they are, each by its name and its http(s)
    address. Nothing is downloaded or checked, so a large video plays at once. Such a package is
    a preview, not a file to keep, since the address may stop answering; the result's `linked`
    lists the names. A YouTube, Vimeo, Panopto or Echo360 address is refused here: the source
    names such a video itself.
  - `fetch`: for media named by web address.
- **Two limits**: a page needs a secure context (https, `localhost` or a Tauri window), and it
  gets another site's file only where that site allows it (CORS). Most image hosts do not, so
  give the file itself, or a `fetch` that may fetch it, such as Tauri's HTTP plugin's.

`@missing-elements/h5p-author/core` is the part that needs neither Node nor a page: the
generator, `loadLibraries`, `packageLibraries`, `checkContent` and the rules for text.
