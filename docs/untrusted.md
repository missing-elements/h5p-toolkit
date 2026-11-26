# Packages you did not make

An H5P package is code as well as content: its library folders hold the JavaScript that draws it.
Played as it is, that code runs on your site's origin, where it can read your page's storage and
cookies. `untrusted` plays a package as data instead, which is how the H5P plugins for Moodle,
WordPress and Drupal treat an author's upload:

```html
<h5p-player src="https://elsewhere.example/course.h5p" untrusted></h5p-player>
```

Played as it is suits packages your own team made. `untrusted` is for everything else: uploads,
links from users, a marketplace, exports from another site.

## The two modes, and the H5P plugins

| | Played as it is | `untrusted` | An H5P plugin: Moodle, WordPress, Drupal |
|---|---|---|---|
| The package's own scripts | Run, as your site | Never served | Installed from an upload only for a user who may update libraries |
| Where the libraries come from | The package, at the pack's newer version where `libraries` names the pack, then `libraries` for what it lacks | `libraries` only: the pack's libraries it needs, or a bundle you name | The libraries installed on the site |
| Files in `content/` | All of them | H5P's list of content file types | H5P's list of content file types |
| The content's fields | As written | Checked against each library's `semantics.json` | Checked the same way, on upload |
| Scripts the frame allows | Your origin, and the hosts the runtime needs | Exact paths only | Whatever the site's own policy allows |
| A package carrying a newer library than the site has | Plays with its own copy | A newer minor plays at the site's older one. A newer major, or a newer minor with `downgrade-libraries="off"`, is refused with `missingLibraries.carried` set, so you can offer to play it as it is | Refused, unless the uploader may update libraries |

## What is withheld

- **The package's own library folders.** The libraries come from `libraries` (`pack` unless you
  name another source): code you chose. See [Libraries](libraries.md).
- **Every file in `content/` that is not one of H5P's content types.** Images, audio, video,
  fonts, office documents, subtitles and JSON are served; scripts, stylesheets, HTML, SVG and XML
  are not. Every file is served with `X-Content-Type-Options: nosniff`, whatever its name.
- **Your whole origin in the script policy.** It names exact paths instead; see
  [The frame's CSP](frame-csp.md).

## The content check

Before the runtime reads the content, it checks every field against the `semantics.json` of the
library the field belongs to. This is a port of `H5PContentValidator`, the check the H5P plugins
run before they show content:

- text keeps only the tags its field allows, with their attributes written anew;
- plain text is escaped;
- numbers are held to their range, and choices to their options;
- sub-content must be a library its field names;
- anything the semantics do not name is removed.

The check matters even with every library folder withheld. Markup needs no script to do harm: a
form asking for a password, a frame, a style laid over the page, a tracking image. And content
types put field values into class names and selectors without escaping them, so a field's type
matters too.

Content whose main library has no `semantics.json` does not play. The pack carries them; a bundle
of your own has to carry them too.

The port was run side by side with the PHP original on 98 cases (78 XSS vectors, every field
type, real packages): 96 came out identical. The other two keep a cleaner shape: a multi-select
with an invalid option removed, and a number clamped to a maximum the semantics write as a string.
Real content came through unchanged, apart from empty lists and one unknown translation key,
which the original removes too. Its other departures, each stricter or forced, are listed in
[`content-check.ts`](https://github.com/missing-elements/h5p-toolkit/blob/main/packages/runtime/src/content-check.ts).

The check fails closed. The Service Worker hands an untrusted package's content only to a runtime
that runs the check, 0.2 or later. An older runtime plays nothing.

## When a package is refused

A package that needs a library your sources do not have is refused with `bad-archive`, naming the
missing libraries: a content type the pack does not serve, a newer major version than the pack's,
or, with `downgrade-libraries="off"`, a newer minor. Without that attribute a newer minor plays at
the pack's older one; see [Content newer than the pack](libraries.md#content-newer-than-the-pack).

If the package carries that library itself, `missingLibraries.carried` is `true`. Playing it
without `untrusted` would run the package's own copy. That is a decision for your site, so ask
the visitor, naming the package's host:

```js
player.addEventListener('error', (e) => {
  const missing = e.detail.missingLibraries
  if (missing?.carried && player.untrusted && userAgreesToRunCodeFrom(new URL(player.src, location.href).host)) {
    const src = player.src
    player.untrusted = false
    player.removeAttribute('src')
    player.src = src
  }
})
```

## Checks every package gets

With or without `untrusted`:

- **Entry names.** An entry whose name is not a plain relative path, such as `../index.html`, is
  rejected, and the rest of the package still plays.
- **Libraries.** Every library the package declares, and every library those depend on, must be
  carried or come from `libraries`, at the minor named or, unless `downgrade-libraries="off"`, an
  older one of the same major. Otherwise the package is refused before the content starts.

## What it does not cover

- **The libraries are your code.** The pack, or a bundle you name, runs as your site.
- **Firefox.** The exact script paths narrow less there. Firefox checks a script the Service Worker
  builds against the worker's own URL, so the worker's URL has to be in the policy, and with it
  every answer the worker gives. The package's folders are still withheld, and `nosniff` still
  holds.
- **Media the content names.** A field that takes a URL, such as a video on YouTube or an image on
  another host, loads from that host in the learner's browser, in either mode: the frame's policy
  allows images, media and frames from anywhere, as content types need. Script requests stay on
  your origin (`connect-src`), with the two exceptions in [The frame's CSP](frame-csp.md).
- **Your origin.** `untrusted` keeps a package's code off your origin, but its content still plays
  there. For a site with signed-in users, [Embed](setup.md#embed) puts the player on a separate
  domain as well.
- **Correctness.** The check is about safety. Whether a package works at all is what
  [`h5p-verify`](verify.md) answers; `h5p-verify --untrusted` plays it the way your site will, and
  lists what the check removes from it.
