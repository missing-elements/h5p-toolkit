# What the frame is allowed to reach

The content runs under a generated Content Security Policy. Images, media and frames are open to
any origin. Scripts and script requests are narrower:

| | Played as it is | `untrusted` |
|---|---|---|
| Scripts | Same origin; MathJax's CDNs (jsDelivr, cdnjs); Google's WebFont loader; the YouTube, Vimeo and Panopto player APIs; and, by path, the endpoints Timeline reads its Wikipedia, Vimeo, SoundCloud and Flickr items from | Exact paths only: the package's own path, which serves library code only from the `libraries` bundle; the runtime's files and your `custom-js`, each by exact URL; the player APIs and Timeline endpoints, each by path |
| Requests from script | Same origin, and by path the oEmbed record Vimeo's player reads before it can start | The same |

The origins of your `runtime` or `assets-base`, `custom-js` and `custom-css` are added to the
directives they load under; played `untrusted`, their scripts are allowed by exact URL, not by
origin. For any other origin the list cannot know about, such as a tenant's
Panopto or Echo360 server or an in-house CDN, `allow-origins` adds it to the script, style, font
and connect directives:

```html
<h5p-player src="…" allow-origins="https://tenant.panopto.com https://cdn.corp.example"></h5p-player>
```

It only adds hosts; anything else is dropped. A blocked resource names its directive and origin
in the console.

**Inline scripts never run, in either policy.** Every script the frame loads carries a nonce, so a
`<script>` in content markup is refused, and so is an `onerror` handler or a `javascript:` link.
One content type is refused with it: AR Scavenger injects A-Frame and AR.js as inline scripts of
its own making, so it shows its title and nothing more. See [Troubleshooting](troubleshooting.md).

**`'unsafe-eval'` is allowed**, because packages that bundle EmbeddedJS render nothing without it.
Played as it is, it adds no reach: the package's own scripts already run as `'self'`.

## An untrusted package

`'self'` is not in the script policy: the frame shares your origin, and `'self'` would let markup
a package injects load any script on your site. Nor are jsDelivr, cdnjs and Google's WebFont
loader, since a CDN serves any file on npm or GitHub: an old Arithmetic Quiz falls back to its own
fonts, and H5P.MathDisplay has carried MathJax in its own folder since 1.0.

The worker serves such a package's `content/` only in H5P's own list of content file types, never
scripts, stylesheets, HTML, SVG or XML, and every response carries
`X-Content-Type-Options: nosniff`. Markup needs no script to do harm, though: a form asking for a
password, a frame, a style laid over the page. So the runtime also checks the content against each
library's `semantics.json` before it is shown. [Packages you did not make](untrusted.md) describes
both.
