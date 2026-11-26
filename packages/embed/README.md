# @missing-elements/h5p-embed

Writes the H5P embed page as a static site for a player domain of your own. Any site then embeds
a package with an iframe and one script line. No H5P server, no backend, no third-party service.
With `--scorm` it writes one package as a SCORM zip for an LMS instead
([below](#a-scorm-package-for-an-lms)); the site also carries a page that builds the same zip in
the browser.

Needs Node 22 or later. Write `@latest`: on an older Node, npm otherwise installs the last release
that supported it, which writes a player from before 1.0.

```bash
npx @missing-elements/h5p-embed@latest h5p-player     # the folder defaults to ./h5p-player
```

Deploy it to any static host, then embed:

```html
<iframe src="https://h5p-player.example.net/?src=https://cdn.example.org/course.h5p"
        allow="fullscreen; microphone; camera" style="width: 100%; border: 0"></iframe>
<script src="https://h5p-player.example.net/resizer.js"></script>
```

The script sizes the iframe to the content; a page that already loads h5p.org's `h5p-resizer.js`
needs no second one. `microphone` is for Audio Recorder and Speak the Words, `camera` for content
that films: a frame from another site gets neither unless the page allows it.

**Use a separate registrable domain** (`h5p-player.example.net`, not `h5p.example.com`) and put
nothing else on it: no accounts, no cookies. A package is JavaScript and runs as that origin, and
a subdomain shares your site's cookies.

## Options

| Option | Effect |
|---|---|
| `--packages <origins>` | Play packages and fetch library bundles only from these origins; the site's own is always allowed. Default: any https host |
| `--ancestors <origins>` | Only these sites may frame the page (`frame-ancestors`, sent as a header). Default: any site |
| `--default-libraries <sources>` | The `libraries` value for addresses that name none: `pack` or URLs, checked against `--packages`. Default: none, so exports without libraries are refused unless the address asks |
| `--no-libraries` | Leave out the library pack (about 14 MB, `libraries/`). `libraries=pack` then fetches it from jsDelivr, which a `--packages` list must include as `https://cdn.jsdelivr.net`. The SCORM page then refuses a package that lacks its libraries |
| `--force` | Write into a non-empty folder, replacing only this tool's files; with `--scorm`, replace the zip |
| `--scorm <package.h5p> [zip]` | Write a SCORM zip of one `.h5p` instead of the site, with none of the site's options above (`--force` still applies). The zip defaults to `./<package>.scorm.zip`; its folder must exist |
| `--title`, `--scorm-version`, `--pass-mark`, `--completion-score` | With `--scorm` only: [Options of the zip](#options-of-the-zip) |
| `-h`, `--help` / `-v`, `--version` | |

Exit codes: 0 written, 1 refused (reason on stderr), 2 wrong options.

Origins are `https://host.example`, comma or space separated, each host on its own: no path,
trailing slash or wildcard. `http://localhost` is accepted for local trials. **List every host a
package URL redirects through:** the browser's policy applies to each hop, and a redirect off the
list fails as a plain network error.

```bash
npx @missing-elements/h5p-embed@latest h5p-player \
  --packages https://cdn.example.org \
  --ancestors "https://www.example.org https://lms.example.org"
```

## Hosting

Any static host, over https, at a domain's root or under a path. The page carries its policy in a
`<meta>` tag, so it is protected wherever it is served; the header files add `frame-ancestors` and
caching. Use the one your host reads and ignore the rest:

| Host | File |
|---|---|
| A server of your own | `Caddyfile` (replace the domain and root, then `caddy run`; Caddy fetches the certificate), `nginx.conf` (include it in the server block), `.htaccess` (Apache with `mod_headers`) |
| Netlify, Cloudflare Pages | `_headers` |
| Vercel | `vercel.json` |
| GitHub Pages, S3, other object storage | none can set headers: the `<meta>` policy applies, `--ancestors` does not, and `h5p-sw.js` is cached by the host's default |

For another host, set these: on every path the `Content-Security-Policy` in `_headers` (with
`frame-ancestors` from `--ancestors`), `X-Content-Type-Options: nosniff` and
`Referrer-Policy: strict-origin-when-cross-origin`; `Cache-Control: no-cache` on `/h5p-sw.js`
(an update reaches learners on their next visit) and on `/frame-assets/*` and `/libraries/*` (they
keep their file names between versions, so a copy from before an update must not be used after
it); `public, max-age=3600, stale-while-revalidate=86400` on `/resizer.js`.

To update, run the command again with `--force` and redeploy.

## The address

| Parameter | Effect |
|---|---|
| `src=<url>` | The package, required: an `http` or `https` URL, or a path on the player domain. Encode `&`, `#`, `+`, `%` and spaces |
| `libraries=pack`, `<url>` or `none` | Where libraries come from; several are tried in order. `pack` is this domain's copy, or jsDelivr's without one: a package gets the libraries it lacks from it, and those it carries at the pack's newer versions. `none` turns off `--default-libraries` |
| `refresh-libraries=off` | Play the libraries a package carries as exported; `pack` then only fills gaps |
| `downgrade-libraries=off` | Refuse content made for a newer version of a library than any source has, instead of playing it at the newest older one |
| `frame`, `copyright`, `export`, `icon`, `reporting` | H5P's action bar and its buttons |
| `fullscreen=off` | No fullscreen button |
| `preload=auto` | Start fetching media at once |
| `activity-id=<IRI>` | The xAPI object id, instead of the package URL |
| `custom-css=<url>` | A stylesheet loaded into the content |
| `lang=<tag>` | The language of H5P's own buttons and dialogs, such as `de` or `pt-BR`, for a package that does not name its own; one that does gets them in its language. Default: English |
| `xapi=<origin>` | Relay statements to the embedding page ([Messages](#messages)) |

A custom script and a learner's name cannot be set on the address. Opened unframed, the page plays
a package from another origin `untrusted` unless `--packages` names it: none of the package's own
code runs, its libraries come from this domain's pack or `--default-libraries` (never from the
address's `libraries=`), and a button offers to play it with its own scripts, only when it needs
them.

## Messages

With `&xapi=<embedding page's origin>` the frame posts statements to that origin only:

```js
const frame = document.querySelector('iframe')
addEventListener('message', ({ source, origin, data }) => {
  if (source !== frame.contentWindow || origin !== 'https://h5p-player.example.net') return
  if (data?.context !== 'h5p-offline-player') return
  if (data.action === 'xapi') send(data.statement)      // every statement
  if (data.action === 'finished') send(data.statement)  // the final one, with result.score
})
```

A package can post any statement, so treat relayed results as the learner's report, not proof for
a grade. A statement carries `context.revision`, the package build's fingerprint, once the build
is known.

Whatever `xapi=` says, the frame also posts to its parent:

```js
{ context: 'h5p-offline-player', action: 'report',
  source,               // { type: 'range-http' | 'chunked' | 'file', size }
  metadata,             // { title, license, licenseVersion, authors, mainLibrary }, from h5p.json; show as text
  libraryBundle,        // { url, origin, fromCache, refreshed? }, or null; refreshed: [{ library, from, to }]
  downgradedLibraries,  // [{ library, from, to }]: content played at an older library version
  elapsedMs }
{ context: 'h5p-offline-player', action: 'error', code, message }  // code 'refused', 'no-src' or the load's
```

## A SCORM package, for an LMS

```bash
npx @missing-elements/h5p-embed@latest --scorm course.h5p     # writes ./course.scorm.zip
```

Writes one package as a SCORM 1.2 zip, or 2004 with an [option](#options-of-the-zip): the package,
the player, the H5P runtime and a launch page that reports to the LMS. Add it to a course as a
SCORM activity in a [supported LMS](#supported-lmss) or another that takes SCORM 1.2. The LMS has
to be served over https, since the player needs its Service Worker. The package plays trusted: its
own code runs on the LMS's origin, as every SCORM package's does. The LMS records:

- **The score** out of 100, and `passed` or `failed` when the content says whether it was passed,
  `completed` when it does not. The content's last result counts, as on an H5P site.
- **Each question's answer**, as `cmi.interactions`, one per question, written over when it is
  answered again. In 1.2 the id is the question's number and first words, such as
  `Q3_which_rivers_cross_germany`; with it go the type, the result (`correct`, `wrong`, or the marks
  for a partial answer), the marks the question was worth, and the time it took. A fill-in
  answer, or a numeric one that is a number, also carries the answer given and the right one, as
  plain text up to 255 characters (`stored, Range` where H5P
  writes `{case_matters=false}stored[,]Range`). A choice, true-false, matching or sequencing
  answer carries its result alone in 1.2, since LMSs read its form differently.
- **The time** spent in each session.
- **The learner's place.** The content's saved state goes into `cmi.suspend_data`, compressed, and
  the next launch continues from it, for a content type that saves one: Question Set, Course
  Presentation, Interactive Book, Interactive Video and most single questions do; an Accordion,
  Image Hotspots, Flashcards or a Timeline starts over. SCORM 1.2 keeps 4,096
  characters; compressed, a quiz's state takes about 200 and a twelve-chapter Interactive Book
  about 1,000. A state that does not fit is not saved, the last that fitted stays, and the page
  says so once under the content. Moodle keeps 64,000 when its administrator turns "SCORM 1.2
  standard mode" off.

An export from h5p.com or h5p.org, which leaves the libraries out, works: the zip carries the ones
it needs from the library pack, and only those. A package that carries its libraries, as exports
from Lumi and the H5P plugins of Moodle, WordPress and Drupal do, plays with its own. One that
needs a library neither it nor the pack has, or a newer version than the pack's, is refused with
what is missing named.

Content that reports no result of its own, such as an Accordion, a Virtual Tour, or a presentation
or book with no questions in it, stays `incomplete`: complete such an activity on viewing it in the
LMS. A zip written from another `.h5p`, or with other libraries from the pack, starts learners
over, since their saved state belongs to what it was saved in.

An [agent skill](https://github.com/missing-elements/h5p-toolkit/tree/main/skills/h5p-to-scorm)
takes an agent through it, from checking the package to the setting each LMS needs:
`npx skills add missing-elements/h5p-toolkit --skill h5p-to-scorm`.

### Options of the zip

A zip written with none of these is the SCORM 1.2 zip above, titled as its `h5p.json` is.

- **`--title <text>`**: the title the LMS lists the package by. Default: the title in `h5p.json`.
- **SCORM 2004 4th Edition** (`--scorm-version 2004`), checked in Moodle 4.5 and SCORM Cloud. The
  LMS keeps completion and the pass apart, so a failed attempt still counts as completed; the
  score is scaled as well as out of 100; each answer carries the question's words as its
  description, and its answer and the right one for every type; and the saved state may run to
  64,000 characters. A learner who comes back to a finished activity finds it as they left it,
  with its result kept.
- **A pass mark** (`--pass-mark 80`, 0 to 100): a score at or above it passes, whatever the
  content says, and below it fails. The LMS gets it as the mastery score (1.2) or the passing
  score (2004), and a mark the LMS holds of its own wins. Content that reports no score gets no
  pass or fail from it.
- **Completion as 100** (`--completion-score`): content that finishes without a score, such as a
  questionnaire or a branching scenario without scoring, is recorded as 100, for a gradebook that
  needs a number; with a pass mark, that passes. Content that never finishes stays `incomplete`.

### In the browser

The written site's `scorm.html` builds the same zip from the site's own copies of the player, the
runtime and the library pack. Nothing is uploaded and no `npx` is needed; it wants https or
localhost. Choose or drop `.h5p` files; review each (its main library and version, its size,
whether it carries its libraries or how many it takes from the pack, or why it cannot be built,
and the title the LMS will list it by, which you can change); choose the
[options](#options-of-the-zip) for all of them; build, and download each zip or all in one. The
demo site has it at [/demo/scorm.html](https://h5p-offline-player.vercel.app/demo/scorm.html).

### Supported LMSs

Checked at these versions, as a learner in Chrome. Other LMSs have not been tried yet.

| LMS | Add the zip as | Change from the defaults | The package is read | SCORM 2004 and the grading options |
|---|---|---|---|---|
| Moodle 4.5 | a SCORM package activity | nothing; keep the maximum grade at 100 | in ranges | checked |
| ILIAS 11 | a SCORM learning module | turn Learning Progress on | whole | not yet |
| OpenOLAT 21.1 | a "SCORM 1.2" course element | the pass mark; in a learning path, the completion criterion | in ranges | not yet |
| Chamilo 3.0 | an imported learning path | publish the learning path | whole | not yet |
| SCORM Cloud | a course | nothing | in ranges | checked |
| Frappe LMS, `develop` | a SCORM chapter | nothing; the content needs a pass mark | whole | not yet |

All of them record the score, whether it passed, the time and the learner's place, except Frappe
LMS, which records only a pass and the place. Where the package is read whole, it is downloaded in
full when it opens: a large video in it starts once the download has reached it, and a quiz does
not notice. Whether a pass mark written into the zip replaces the one OpenOLAT and Frappe LMS ask
for has not been checked yet.

- **Moodle.** The score goes to the gradebook as the grade, out of the activity's maximum grade, so
  keep that at 100, its default. Moodle has to serve files by path, which it does by default
  (`slasharguments`).
- **ILIAS.** Learning Progress is off in a fresh ILIAS, and without it ILIAS's SCORM player keeps
  the learner's place and drops every score and status. Turn it on in Administration, then in the
  module's Learning Progress settings choose "Collection of SCORM Items" and tick the item.
- **OpenOLAT.** Its grading takes the score with a pass mark of 0, so every result counts as
  passed, a failed quiz too: set "Score needed to pass" to the quiz's own pass mark, or choose
  "Transfer passed value", which takes pass or fail from the content and no score. In a
  learning-path course the element counts as done only once the learner confirms it: choose
  "Passed" as its completion criterion.
- **Chamilo.** It imports a learning path unpublished: publish it before learners can see it.
  Chamilo 1.11 has not been tried.
- **Frappe LMS.** It marks the lesson done only when the content reports a pass, so a quiz needs a
  pass mark; a failed attempt, or content that reports only `completed`, leaves the lesson open.
  It keeps no score.

Write again any zip made by embed 1.3.0 or earlier: SCORM Cloud cannot import it ("IO Error
processing zip"), nor, likely, can some other Java-based LMSs; ILIAS loses the time of a session
the learner ends by closing the tab, and Chamilo does not record that it was left unfinished.

## As a library

```js
import { buildSite } from '@missing-elements/h5p-embed'
await buildSite({ out: 'public/player', packages: ['https://cdn.example.org'] })
```

`buildSite` takes `out`, `libraries` (default `true`), `packages`, `ancestors`, `defaultLibraries`
and `force`, as the flags. The JS entries ship TypeScript declarations, which document the rest:

- **`startEmbed(options)`**, from `@missing-elements/h5p-embed/embed.js`, is the page's script. It
  reads the page's `<h5p-player>`, `#loader` and `#notice` (see `site/index.html` and
  `site/embed.css`). Options: `pack` (the `@missing-elements/h5p-libraries` export, which
  `libraries=pack` then plays from) or `packBase` (the folder of a copy of its `parts/`),
  `packages` (allowed origins, `null` for any), `defaultLibraries`, `runtime` (the
  `@missing-elements/h5p-runtime` export, for a bundled element) and `askInOwnFrame` (default
  `true`; `false` plays a package from another origin as it is when a same-origin page frames it).
- **`buildScorm`**, from `@missing-elements/h5p-embed/scorm`, is `--scorm`: `h5p`, `out`, `force`,
  `title`, `scormVersion` (`'1.2'` or `'2004'`), `passMark` (0 to 100, or `null`) and
  `completionScore`. It returns the zip's path (`out`), its `title`, the options as written,
  `size`, the `libraries` carried from the pack, and `build`, the stamp saved state is kept
  against.
- **`buildScormInPage`** and **`planScormInPage`**, from `@missing-elements/h5p-embed/scorm/browser`,
  are the same build in a page, from a `File` or `Blob`, the player's files at `base` and the
  pack as `startEmbed` takes it. The plan stops before writing, to show what the zip will hold;
  its `write()` writes it.
- **`startScormPage()`**, from `@missing-elements/h5p-embed/scorm-page.js`, is the SCORM page's
  script (see `site/scorm.html` for the elements it reads). The written site loads it bundled,
  with zip.js inside; a page that bundles imports the source.

```js
import '@missing-elements/h5p-offline-player'
import { runtime } from '@missing-elements/h5p-runtime'
import { pack } from '@missing-elements/h5p-libraries'
import '@missing-elements/h5p-embed/embed.css'
import { startEmbed } from '@missing-elements/h5p-embed/embed.js'

startEmbed({ runtime, pack, defaultLibraries: 'pack' })
```

## Privacy

The site sets no cookies and sends nothing anywhere of its own. Learners' browsers contact your
player domain, the package hosts and, only for `pack` on a site built with `--no-libraries`,
`cdn.jsdelivr.net`. A SCORM package contacts only the LMS it was uploaded to, plus any address
its content names, such as a video host or the CDN an old library loads MathJax from; the LMS gets the score, the result, the time spent and the
learner's saved state. For a privacy notice or a GDPR review:
[Privacy and data protection](https://github.com/missing-elements/h5p-toolkit/blob/main/docs/privacy.md).

## Licences

MIT. The written folder also carries
[`@missing-elements/h5p-runtime`](https://www.npmjs.com/package/@missing-elements/h5p-runtime)
under the GPL-3.0 (`frame-assets/`, with its `LICENSE.txt` and `NOTICE.txt`) and, unless
`--no-libraries`, the hub's libraries under their own licences, listed in `libraries.txt`. The
folder's `NOTICE.txt` says which file is what. A SCORM zip carries the runtime and any pack
libraries the same way, and the package under its own licences. `scorm-page.js` carries zip.js,
BSD-3-Clause, with its licence in its header.
