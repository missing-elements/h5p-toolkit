# Video that cannot stream

A video cannot start until it has arrived whole when the package has both of these:

- the media is **deflated** in the zip rather than stored, so no `Range` request can reach a byte
  without the whole stream before it;
- the mp4 is **not faststart**, so its `moov` index is at the end and nothing decodes until the
  last byte.

The player cannot shorten that wait, only start it earlier: with `preload="auto"` it extracts
large deflated entries in archive order, one at a time, once the content is up (`progress`
events, `phase: 'extract'`). It is off by default because it spends bandwidth on media the learner
may never reach.

```html
<h5p-player src="course.h5p" preload="auto"></h5p-player>
```

The fix is to the package, with
[`@missing-elements/h5p-normalize`](https://github.com/missing-elements/h5p-toolkit/tree/main/packages/normalize)
(Node 22 or later):

```bash
npx @missing-elements/h5p-normalize@latest course.h5p                     # writes course.normalized.h5p beside it
npx @missing-elements/h5p-normalize@latest https://…/course.h5p --dry-run  # inspect only
```

It rewrites the container and leaves the content alone: media stored, mp4 index moved to the
front, libraries ordered before media, stored text deflated. The package grows by a percent or
two and any H5P host still accepts it; the video then starts after a few hundred kilobytes and
seeks at once.

It also cuts the bandwidth a video costs, on a host that honours `Range`. A deflated video is
downloaded whole as soon as the browser asks for any of it, however little the learner watches; a
stored one only as far as the browser buffers ahead of the learner.
