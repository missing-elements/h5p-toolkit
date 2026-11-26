# Contributing

Thank you for contributing to `h5p-toolkit`.

## Before you start

This is a pnpm workspace of the player, the H5P runtime, the library pack and the packages around
them, the demo site and the tests of the agent skills. The
[development guide](./docs/development.md) lists the workspace and its commands.

The player handles untrusted archives across a page, Service Worker and dedicated worker. For
architectural constraints and security boundaries, read [AGENTS.md](./AGENTS.md) and the files in
[design/](./design/) it points to.

## Prerequisites

- Node.js 22 LTS or 24 LTS (22.12 or later; CI tests on 22)
- pnpm 10
- Chromium for browser tests

## Local setup

```bash
git clone https://github.com/missing-elements/h5p-toolkit.git
cd h5p-toolkit
pnpm install --frozen-lockfile
pnpm --filter @missing-elements/h5p-offline-player exec playwright install chromium
```

`pnpm dev` then starts the demo's development server.

## Checks

Run the smallest relevant check first, then widen it when the change reaches more than one
package:

```bash
pnpm test:unit
pnpm test:browser
pnpm typecheck
pnpm build
```

`pnpm test:browser` exercises the player in Chromium, including its Service Worker and Jobs
worker. Run it for changes to playback, storage, workers, network or browser-facing behaviour.

A pull request's CI run tests, in Chromium, only the packages it changes and those that depend on
them; a change outside the packages, such as the lockfile or a workflow, tests every package.
Firefox, WebKit and three slow browser files run only in CI's weekly run and when it is run by
hand. So for a change to the Service Worker, the Jobs worker, storage or the demo's pages, run
Firefox and WebKit yourself, one engine at a time:

```bash
pnpm --filter @missing-elements/h5p-offline-player exec playwright install firefox webkit
H5P_TEST_BROWSER=firefox pnpm test:engine
H5P_TEST_BROWSER=webkit pnpm test:engine
```

Do not commit generated `dist`, `public/frame-assets`, the runtime's `index.js` or fixture output,
unless the repository's release or asset-generation workflow requires it.

## Pull requests

Before opening one:

1. Keep the change focused, and add or update tests for behaviour changes.
2. Run the relevant checks and state the commands and results in the pull request.
3. Update documentation when a public API, deployment requirement, security boundary or
   user-visible behaviour changes. A change to anything
   [docs/compatibility.md](./docs/compatibility.md) covers is a version decision: say so in the
   pull request.
4. Preserve streaming: do not introduce whole-archive or whole-media buffering.
5. Preserve archive-name validation, origin checks, Service Worker boundaries and the frame
   Content Security Policy.
6. Preserve keyboard accessibility and visible focus when changing the player, frame, demo or
   installable app.
7. Do not disclose security vulnerabilities in public issues or pull requests; follow
   [SECURITY.md](./SECURITY.md) instead.

Describe the problem, the solution and how you verified the change. Include a screenshot,
recording or minimal reproduction when it helps reviewers assess a user-visible change.
