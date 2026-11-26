# @missing-elements/h5p-cmi5

cmi5 for [h5p-offline-player](https://github.com/missing-elements/h5p-toolkit): turns a page
holding `<h5p-player>` into a cmi5 assignable unit, so an LMS can launch an `.h5p` package and
record the result. The package stays on your static host; the LMS imports a small course structure
naming your page. No dependencies.

Once launched it sends `initialized`, relays the player's statements to the LMS's LRS with the
launch's actor, registration and context template, sends `passed` or `failed` and `completed` when
the content finishes, and sends `terminated` on `session.exit()`.

## Usage

```bash
npm i @missing-elements/h5p-offline-player @missing-elements/h5p-runtime @missing-elements/h5p-cmi5
```

```html
<p id="status" role="status"></p>
<h5p-player></h5p-player>
<button id="exit">Exit</button>
```

```js
import '@missing-elements/h5p-offline-player'
import { runtime } from '@missing-elements/h5p-runtime'
import { isCmi5Launch, startCmi5 } from '@missing-elements/h5p-cmi5'

const player = document.querySelector('h5p-player')
player.runtime = runtime

if (isCmi5Launch()) {
  startCmi5(player)
    .then((session) => {
      document.querySelector('#exit').onclick = () => session.exit()
    })
    .catch((error) => {
      document.querySelector('#status').textContent = `The LMS did not answer the launch: ${error.message}`
    })
}
```

`startCmi5` resolves once `initialized` is sent and rejects with the LMS's reason when the launch
fails. It plays the package named by `?src=` in the page's address, or by `launchParameters`.
The course structure the LMS imports, the launch options and what the page sends are in the
[guide](https://github.com/missing-elements/h5p-toolkit/blob/main/docs/cmi5.md); a working page
with a simulated LMS is the demo's
[cmi5 example](https://github.com/missing-elements/h5p-toolkit/blob/main/apps/demo/demo/cmi5-page.js).

## Options

`startCmi5(player, options)`:

| Option | Default | What it is for |
|---|---|---|
| `onEvent(event)` | none | Each step, called synchronously (a throw in it is ignored): `initialized`, `sent`, `rejected` (with the LMS's reason), `recorded`, `skipped` (Browse or Review mode, or already recorded), `registration-unread`, `terminated`, `unsafe-return-url`, `unsafe-src` |
| `src` | the address's `src`, then `launchParameters` | The package. Only an `http` or `https` address is played, resolved against the page's; anything else is an `unsafe-src` event and the next source is tried. `false` leaves `src` to you: do that on a page anyone can link to, and check the package's origin before setting it |
| `url` | `location.href` | The page's address, which the launch parameters and the default `src` are read from |
| `storage` | `null` | Keeps the session across a reload; only for a trusted package and origin (see Credentials in the guide) |
| `client` | `createCmi5Client()` | A client of your own, such as a simulated LMS or a test double |

The session has `terminate()`, `retry()` (for a completion the LRS rejected), `exit()` and
`stop()` (stops listening to the element without sending `terminated`). `exit()` sends
`terminated`, then goes to the launch's `returnURL` (see The launch in the guide). The session
also has, read only, `launchParameters`, `launchData`, `learnerPreferences` (the LMS's language and
audio preferences, for the page to apply), `resumed` (a reload picked the session up), `src`,
`returnURL` and `terminated`. `createCmi5Client()` is exported for use without the element:
`initialize()`, `sendXapiStatement()`, `moveOn()` and `terminate()`.

## Licence

MIT.
