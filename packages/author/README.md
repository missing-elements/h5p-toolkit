# @missing-elements/h5p-author

Builds a playable `.h5p` of any content type in the H5P hub from a short JSON source: the content
type, and only the fields that differ from its defaults. `read` turns a package back into its
source, to change it and build it again. No H5P server, no editor, no telemetry, and no network
but for media named by web address. Needs Node 22 or later; write `@latest`, since without it npx
on an older Node installs an older release.

```bash
npx @missing-elements/h5p-author@latest build rivers.json rivers.h5p
```

```json
{
  "type": "H5P.Blanks",
  "title": "Rivers of Europe",
  "language": "de",
  "license": "CC BY",
  "authors": [{ "name": "Ann Author", "role": "Author" }],
  "params": {
    "questions": ["Die *Donau* fließt ins Schwarze Meer.", "Paris liegt an der *Seine*."]
  }
}
```

```
Built /work/rivers.h5p: H5P.Blanks, 9 libraries from the library pack 1.1.1, 3 more for installing on an H5P site.
Needs H5P core 1.28 or newer on a site it is uploaded to: Moodle 4.5.11, 5.0.7 or 5.1.4 and later, or the WordPress H5P plugin 1.17 and later. An older site refuses it.
Its source, naming H5P.Blanks 1.14 as what it was built with, is /work/rivers.source.json: hand it over with the package.
H5P.Blanks 1.14: interface texts from its translation language/de.json.
Not verified: run npx @missing-elements/h5p-verify@latest on it and look at its screenshot before handing it over.
```

- **The package carries its libraries.** They come from the library pack this release pins,
  [@missing-elements/h5p-libraries](https://www.npmjs.com/package/@missing-elements/h5p-libraries),
  each part checked against the pack's SHA-256 index. What the source leaves out comes from the
  libraries' own defaults, and their translation for the content's language.
- **An H5P site takes it.** It carries the editor libraries a site's upload check asks for: a
  Moodle 4.5.15 with no library installed accepted every type's example (Moodle was the one
  site tried; WordPress and Drupal run the same check). They add 120 kB to a Question Set and
  several MB to a Course Presentation. The site needs the H5P core that the
  build's second line names.
- **The source is written beside it**, as `rivers.source.json`, with one field more: `builtWith`,
  the content type's version. Keep it to change the package later. A build with a newer version
  of the type says so, since a field may have changed.
- **No file is written over.** An existing output is refused. The one exception is the source
  file being built, which is kept up to date.

It is written for an AI agent: the agent writes what only an author can know, and code writes
what can be derived. The
[h5p-author skill](https://github.com/missing-elements/h5p-toolkit/tree/main/skills/h5p-author)
is the workflow around it.

## The source

| Field | Meaning |
|---|---|
| `type` | The content type's machine name, such as `H5P.Blanks`; the pack's newest version is used |
| `title` | The title, at most 255 characters |
| `language` | A BCP 47 tag, `en`, `de-AT`; it picks the libraries' translation of their interface texts |
| `license` | An H5P licence code: `U` (undisclosed), `CC BY`, `CC BY-SA`, `CC BY-ND`, `CC BY-NC`, `CC BY-NC-SA`, `CC BY-NC-ND`, `CC0 1.0`, `CC PDM`, `GNU GPL`, `PD`, `ODC PDDL`, `C`; `licenseVersion` for a CC BY one |
| `authors` | `[{ "name": "…", "role": "Author" }]`, the role one of Author, Editor, Licensee, Originator |
| `params` | The content type's fields that differ from their defaults |
| `builtWith` | Written by a build, never by hand: `H5P.Blanks 1.14` |

`params` takes what H5P's editor would let an author save in the same form:

- **Text**: plain text in a plain field. In a field with tags, markup with those tags only, or
  plain text, which is wrapped in paragraphs. A tag the field does not take, an event handler or
  a script address is refused.
- **Choices, numbers, lists**: a select's options, a number's range and a list's size are
  checked. A field the content type does not have is refused, so a misspelt one is never dropped
  in silence.
- **Sub-content**: `{ "library": "H5P.MultiChoice", "params": { … }, "metadata": { "title": "…" } }`,
  filled in the same way, at the pack's version.
- **Files**: `{ "path": "photo.jpg" }`, a file beside the source or an `http(s)` address, with an
  optional `copyright`. Each is copied into the package. A video or a recording is read from its
  first bytes, and one that is not what its field takes is refused, a web page at a file's
  address among them. The package is laid out to stream.
- **Hosted video**: a YouTube, Vimeo, Panopto or Echo360 address stays an address. YouTube and
  Vimeo are asked whether they have the video (oEmbed, which is sent its address): one they do
  not have is refused, a private one is a note, and with no answer in ten seconds the build goes
  on.
- **Times and places**: an Interactive Video's times are held to the video's length, where an
  mp4 or Vimeo gives one. An interaction that ends after the last whole second is refused, since
  Interactive Video would play it earlier: ending at that second, its start moved by as much,
  its length kept. Hotspots, areas, stages and interactions placed by
  numbers alone are noted: only a look at the preview says whether one sits on what it names.
- **Interface texts** (Check, Retry…): leave them out. They come from the libraries'
  translations, and the build lists what stayed English. A source may still set one by name.
- **Layout**: the build does what the editor's own widgets do. It lays out a Course
  Presentation's slides and a Drag and Drop's words and zones, places Interactive Video
  interactions, joins Game Map stages, numbers Branching Scenario end screens and names untitled
  Question Set questions. It refuses what they would: a scenario path with no end, a map with no
  start, a hotspot question with no right area.

The quiz format the skill published first (`{ "kind": "question-set", "questions": [ … ] }`) is
still taken.

## Problems

A source with problems writes nothing, lists every problem by its path at once, and exits with 1:

```
h5p-author: The source has 2 problems:
  params.correct: "yes" is not an option; the options are "true", "false"
  params.behaviour.sideways: is not a field here; the fields are enableRetry, enableSolutionsButton, …
```

What is written in the wrong place is named with what to write, and still checked, so what is
wrong inside it comes in the same round:

```
h5p-author: The source has 3 problems:
  params.slides: is a field of presentation, not of this level: write params.presentation.slides
  params.slides[0].elements[0]: is sub-content, but here it goes inside an object, in its field action: write params.slides[0].elements[0] as { "action": { "library": "H5P.AdvancedText", "params": { … } } }
  params.slides[0].elements[0].params.text: has <h1>, which this field does not take; it takes <a> <br> …
```

A source's own fields are read as loosely: the type under `contentType` or `library`, or named
as it is spoken of (`"interactive-book"`), and the title, licence and authors in a `metadata`
object, are each taken and named once with what to write.

## Commands

| Command | What it does |
|---|---|
| `build <source.json> <output.h5p>` | Builds the package, and writes `<output>.source.json` beside it |
| `build --check <source.json>` | Lists the source's problems and notes; writes no package |
| `read <package.h5p> <folder>` | Writes the package's source into the folder, its media beside it |
| `media <file or address>…` | Says what each file is, before a source names it |
| `schema <machine name>` | Prints a content type's fields; `--all` adds the interface texts, `--markdown` prints the section the skill's type files carry |
| `bundle <machine name> <output.zip>` | Writes the libraries one content type builds from; `--all <folder>` writes one per type |

`--libraries <folder>` names another copy of the pack's `parts/` folder, in place of the pinned
one. `-h` shows the help, and `-v` this package's version and the pack's.

**`read`** writes what a build takes to make the package again: the content type, the metadata,
and of the content only what differs from the defaults. Positions and sizes are kept, and each
part gets a new id when it is built again.

- It reads content made for the pack's versions of its libraries, and refuses any other, naming
  both versions. H5P moves content to a newer version as it plays it, so a package saved again on
  a site that has the pack's versions reads.
- What a source has no field for is said and left out: a part's own licence or authors, and a
  file's licence that H5P does not list. A picture's, a video's or a recording's part's licence is
  read as its file's copyright.
- The source is built again in memory before it is written. What would not come back as it is,
  or what a build would refuse, such as styles pasted from Word, is said.
- An archive is untrusted: only the files its content names are written, and only under the
  folder.

**`media`** reads each file as a build reads it. It needs no libraries.

```
clip.mp4: an MP4 video, 10 s long
delta.png: a PNG picture, 1200 by 800 pixels
https://vimeo.com/76979871: a video on Vimeo, about 62 s long
```

It reads a picture's size, an mp4's length and whether it has sound, and a Vimeo video's length
in whole seconds. It does not read the length of a WebM, an Ogg, a WAV or an MP3, and YouTube
gives none. A file that no source can name is said on standard error, and the command exits
with 1.

**`schema`** prints the fields as a source writes them. An unknown name lists the pack's content
types.

```
H5P.TrueFalse 1.8: True/False Question
- `media` group — Media
  - `type` sub-content: H5P.Image | H5P.Video | H5P.Audio — Type: Optional media to display above the question.
…
- `question` html: strong em sub sup h2 h3 pre code, required — Question
- `correct` one of "true" | "false" = "true" — Correct answer
…
```

**`bundle`** is for a build where the pack cannot be installed, such as a chat's sandbox that
reaches no npm registry. Unzip it beside a source and build with `--libraries parts`: the package
is the one the pack would give.

- The zip holds `parts/`, with the pack's index, and `libraries.txt`, the libraries' licences.
- A question type's bundle is about 1 MB, a Question Set's 2.6 MB, the largest 8 MB; all 55 are
  99 MB.
- No addon is in it. Where a source's text calls for one, H5P.MathDisplay for math, the build
  names the missing part, to copy from the pack's own `parts/` folder.

## What else the package ships

- **The skill's text**, as this release has it, for a site that serves the skill or hands a chat
  a type's notes: `SKILL.md`, `references/authoring.md`, `references/change.md`,
  `references/build/<route>.md` and `references/types/<machine name>.md`. The
  [organisation's site](https://missing-elements.github.io/h5p/create-with-ai/#install) packs
  them as the zips chat apps install.
- **The command line as one file**, `dist/h5p-author.mjs`, everything it imports bundled in, with
  those packages' licences in `dist/h5p-author-LICENSES.txt`.

## API

```js
import { buildPackage, SourceError } from '@missing-elements/h5p-author'

try {
  const { notes, outline } = await buildPackage(source, 'rivers.h5p', { base: process.cwd() })
} catch (error) {
  if (!(error instanceof SourceError)) throw error
  console.log(error.problems) // [{ path, message }]
}
```

Every command is a function too: `buildPackage`, `readPackage`, `describeMedia`, `schemaOf`,
`writeBundle`. `checkContent` is the check for a tool that changes a saved package, and
`@missing-elements/h5p-author/browser` is the same build in a page, the package a `Blob`.
[The API](https://github.com/missing-elements/h5p-toolkit/blob/main/docs/author-api.md) has the
options, the results, and how to confine a build run on what a model wrote.

## What it does not do

It checks structure, not pedagogy. It notes what H5P allows and is almost surely a mistake: no
answer marked correct, two answers alike, a text with no gap, an alt text left blank beside a
picture. Whether the answers are right, the questions fair, or the pictures placed well is for a
person to judge, in
[h5p-verify](https://www.npmjs.com/package/@missing-elements/h5p-verify)'s `--preview`. It
changes an existing package only by way of its source, read and built again. The licence of each
library is in the pack's `libraries.txt`.

MIT.
