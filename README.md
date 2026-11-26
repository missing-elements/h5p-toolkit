# H5P Toolkit by Missing Elements

Play, build, check and package [H5P](https://h5p.org) content without an H5P server.

H5P is an open-source framework for interactive learning content (quizzes, interactive videos,
presentations), shipped as `.h5p` files. Playing one usually takes Moodle, WordPress or Drupal with
the H5P plugin, an h5p.com account, or Lumi on a desktop. This toolkit does those jobs with static
files on your own site, command-line tools on your computer, and skills for your AI agent.

**[Live player demo](https://h5p-offline-player.vercel.app/)** ·
[Build with AI](https://missing-elements.github.io/h5p/build/) ·
[Offline app](https://h5p-offline-player.vercel.app/app/) ·
[H5P to SCORM](https://h5p-offline-player.vercel.app/demo/scorm.html) ·
[VS Code extension](https://marketplace.visualstudio.com/items?itemName=MissingElements.h5p-preview)

## What it does

| To | Use | Agent skill |
|---|---|---|
| Play `.h5p` files on your own site, from a URL or from disk | The `<h5p-player>` web component: [`h5p-offline-player`](packages/player/README.md) with [`h5p-runtime`](packages/runtime/README.md) | [`h5p-player-setup`](skills/h5p-player-setup/SKILL.md) |
| Play exports that lack their libraries | [`h5p-libraries`](packages/libraries/README.md), the library pack | |
| Keep the player on a separate domain and embed it by iframe | [`h5p-embed`](packages/embed/README.md) | [`h5p-player-setup`](skills/h5p-player-setup/SKILL.md) |
| Put a package into an LMS | [`h5p-embed --scorm`](packages/embed/README.md#a-scorm-package-for-an-lms) for a SCORM zip, [`h5p-cmi5`](packages/cmi5/README.md) for a cmi5 unit | [`h5p-to-scorm`](skills/h5p-to-scorm/SKILL.md) |
| Build an activity from a prompt or a short JSON source | [`h5p-author`](packages/author/README.md); [`h5p-mcp`](packages/mcp/README.md) in Claude Desktop and other MCP apps; [the build page](https://missing-elements.github.io/h5p/build/) in a chat app | [`h5p-author`](skills/h5p-author/SKILL.md) |
| Check that a package plays, or preview it in your browser | [`h5p-verify`](packages/verify/README.md) | [`h5p-verify`](skills/h5p-verify/SKILL.md) |
| Make a package's video start at once, not after a full download | [`h5p-normalize`](packages/normalize/README.md) | [`h5p-normalize`](skills/h5p-normalize/SKILL.md) |
| Play `.h5p` files with no network, or in your editor | [The offline app](https://h5p-offline-player.vercel.app/app/); [H5P Preview](https://marketplace.visualstudio.com/items?itemName=MissingElements.h5p-preview) for VS Code, and on [Open VSX](https://open-vsx.org/extension/MissingElements/h5p-preview) for Cursor and VSCodium | |

The tools named `h5p-…` are on npm as `@missing-elements/h5p-…`, and each name links to its README.

## Terms

- **Package:** a `.h5p` file, not an npm package: a zip of the content and, usually, its
  *libraries*, the code of its content types. Exports from h5p.com and h5p.org often leave the
  libraries out.
- **Library pack:** the libraries of every content type the H5P hub serves. With
  `libraries="pack"`, the player downloads those a package lacks, and newer versions of those it
  carries.
- **Runtime:** the H5P core, which runs the content in the player's frame. It is an npm package of
  its own because it is GPL-3.0 and the player is MIT.
- **`untrusted`:** played as it is, a package's code runs as your site. `untrusted` runs none of
  it: the libraries come from the pack, or a bundle you name, and the content is checked as the
  H5P plugins for Moodle, WordPress and Drupal check an upload.

## Quick start

### Play a package on your site

With Vite or webpack 5:

```bash
npm install @missing-elements/h5p-offline-player @missing-elements/h5p-runtime
```

```html
<h5p-player src="https://host.example/course.h5p"></h5p-player>
```

```js
import '@missing-elements/h5p-offline-player'
import { runtime } from '@missing-elements/h5p-runtime'

const player = document.querySelector('h5p-player')
player.runtime = runtime
player.addEventListener('xapi', (e) => console.log(e.detail.statement)) // results arrive as events
```

- The page must be on `https://` or `localhost`, and a package on another origin needs CORS
  headers on its host.
- An export without its libraries needs `libraries="pack"` on the element.
- Play a package you did not make with `untrusted`. On a site with signed-in users, play every
  package `untrusted`, or embed the player from a separate domain with `h5p-embed`.

[Setting up the player](docs/setup.md) covers pages without a bundler, other bundlers, and the
choice between installing and embedding. [The element's API](docs/api.md) lists every attribute,
property and event.

### Build an activity with AI

In Claude Code or another agent that runs commands:

```bash
npx skills add missing-elements/h5p-toolkit --skill h5p-author
```

Then ask for an activity, such as "a five-question quiz on the water cycle, as H5P". The skill
asks which content type, builds the `.h5p`, checks it and opens it for you to play.

Where no command can run, [the build page](https://missing-elements.github.io/h5p/build/) turns
what a chat app wrote into the file, in your browser, and [`h5p-mcp`](packages/mcp/README.md)
builds it onto your disk from Claude Desktop or another MCP app.

### Use the command-line tools

```bash
npx @missing-elements/h5p-verify@latest course.h5p              # does it play? exit code 0 yes, 1 no
npx @missing-elements/h5p-verify@latest course.h5p --preview    # play it in your own browser
npx @missing-elements/h5p-embed@latest --scorm course.h5p       # write course.scorm.zip for an LMS
npx @missing-elements/h5p-normalize@latest course.h5p           # write course.normalized.h5p, which streams
npx @missing-elements/h5p-author@latest build quiz.json quiz.h5p  # build a package from a JSON source
```

They need Node 22 or later, and `h5p-verify` a Chromium-based browser such as Chrome or Edge. Keep
`@latest`: without it, npm on an older Node quietly installs an old release.

## Why this one

- **No H5P server anywhere.** A `.h5p` plays from a URL on static hosting, with nothing unzipped
  and no backend. [The comparison](https://h5p-offline-player.vercel.app/demo/compare.html) goes
  through h5p-standalone, Lumi, h5p.com and the H5P plugins.
- **It plays the files people actually have:** exports without their libraries, against the
  [library pack](docs/libraries.md), and packages you did not make,
  [`untrusted`](docs/untrusted.md).
- **What a model builds is checked.** `h5p-author` writes a package that carries its libraries,
  which Moodle accepts as an upload, and `h5p-verify` plays it in the real H5P runtime in a
  headless browser before anyone hands it over.
- **Nothing you play passes through a server of ours.** The packages have no account, cookies or
  telemetry. The library pack comes from jsDelivr unless you serve a copy, and the hosted demo
  counts page views, with no cookies ([privacy](docs/privacy.md)).

It is not an editor, so content comes from the tools above or from an H5P site. It stores no
results either: the player raises xAPI events, and your page decides where they go.

## Agent skills

The five skills in the table are for Claude Code and other agents that read files and run
commands, installed with [skills](https://skills.sh/); add `--skill <name>` for one. None needs a
provider API key or an H5P server.

```bash
npx skills add missing-elements/h5p-toolkit
```

A chat app takes `h5p-author` as a zip to upload instead:
[download it](https://missing-elements.github.io/h5p/create-with-ai/#install) from the page that
says where it goes in each app.

## Documentation

- **Set up:** [Setting up the player](docs/setup.md) ·
  [The element's API](docs/api.md) ·
  [Troubleshooting](docs/troubleshooting.md) ·
  [Single-worker hosts and upgrades](docs/single-worker.md) ·
  [Coming from h5p-standalone](docs/h5p-standalone.md)
- **`.h5p` packages:** [Libraries](docs/libraries.md) ·
  [Packages you did not make](docs/untrusted.md) ·
  [Video that cannot stream](docs/streaming-video.md) ·
  [Verifying a package](docs/verify.md) ·
  [h5p-author's API](docs/author-api.md) ·
  [The frame's CSP](docs/frame-csp.md)
- **Results:** [Resume](docs/resume.md) ·
  [Which build a learner completed](docs/revision.md) ·
  [cmi5](docs/cmi5.md) ·
  [A SCORM package](packages/embed/README.md#a-scorm-package-for-an-lms)
- **Policies:** [Compatibility](docs/compatibility.md) ·
  [Privacy and data protection](docs/privacy.md) ·
  [Accessibility](ACCESSIBILITY.md) ·
  [Security](SECURITY.md)

## Status

Every npm package is at version 1, except `h5p-mcp` and the H5P Preview extension, which are 0.x;
[Compatibility](docs/compatibility.md) says what a version number promises. Every week, CI rebuilds
the library pack from the H5P hub and H5P's interface strings from Moodle's translations, opens a
pull request when either changed, and plays every content type in the pack, trusted and untrusted.

## Contributing

A pnpm workspace: see [CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/development.md](docs/development.md). [AGENTS.md](AGENTS.md) and [design/](design) hold the
design and the reasons behind it. Report vulnerabilities privately, as [SECURITY.md](SECURITY.md)
describes.

## Licence

Everything is MIT ([LICENSE](LICENSE)) except two npm packages:

- **[`h5p-runtime`](https://www.npmjs.com/package/@missing-elements/h5p-runtime) is GPL-3.0.** It
  holds the H5P core from [h5p-php-library](https://github.com/h5p/h5p-php-library) and the script
  that boots it. The player talks to it only over HTTP and `postMessage`, and its
  [NOTICE.md](packages/runtime/NOTICE.md) says what serving it entails.
- **`h5p-libraries` holds H5P's own libraries,** each under its own licence, most of them MIT, as
  [`libraries.txt`](packages/libraries/libraries.txt) lists.

Bundled third-party code keeps its licence too: the player's Service Worker carries
[zip.js](https://github.com/gildas-lormeau/zip.js), BSD-3-Clause
([NOTICE.md](packages/player/NOTICE.md)). Whether the GPL's copyleft reaches the page around the
player is a legal question this README does not answer.

H5P is a trademark of H5P Group. This toolkit is made by Missing Elements and is not affiliated
with or endorsed by H5P Group.
