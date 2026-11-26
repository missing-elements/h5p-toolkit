# cmi5

cmi5 is xAPI with a launch contract: the LMS opens content by URL, hands it a one-time token
and an LRS, and the content sends its statements there. It suits this player: the package stays
on a static host and the LMS imports only a small course structure. An LMS that speaks only SCORM
takes the zip [`h5p-embed --scorm`](https://github.com/missing-elements/h5p-toolkit/tree/main/packages/embed#a-scorm-package-for-an-lms)
writes instead, which carries the player and the package into the LMS.

The element does not change for it. The wiring is a package of its own with no dependencies,
[`@missing-elements/h5p-cmi5`](https://github.com/missing-elements/h5p-toolkit/tree/main/packages/cmi5):
its README has the install, the page, the options and the session's methods. The demo's
`/demo/cmi5.html` (`apps/demo/demo/cmi5-page.js`) is a page on it. Opened with `?simulate`, it
runs the same code against an LMS simulated inside the page, with a mastery score of 0.8, and
shows every statement in its log instead of sending it.

## Credentials

An H5P package's scripts run on the page's origin and can read browser storage, so by default
the LRS token is kept only in memory. A refresh is not a resumable launch: the `fetch` URL
answers once, and the learner returns to the LMS for a new launch. Pass `storage` only when both
the package and the origin are trusted; a kept session is reused only for the endpoint,
registration and activity it was made under.

## The launch

The course structure names the page and the package:

```xml
<?xml version="1.0" encoding="utf-8"?>
<courseStructure xmlns="https://w3id.org/xapi/profiles/cmi5/v1/CourseStructure.xsd">
  <course id="https://your-site.example/courses/quiz">
    <title><langstring lang="en-US">Quiz</langstring></title>
    <description><langstring lang="en-US">A question set</langstring></description>
  </course>
  <au id="https://your-site.example/courses/quiz/au" moveOn="CompletedAndPassed" masteryScore="0.8">
    <title><langstring lang="en-US">Quiz</langstring></title>
    <description><langstring lang="en-US">A question set</langstring></description>
    <url>https://player.example/demo/cmi5.html?src=https://host.example/course.h5p</url>
  </au>
</courseStructure>
```

Zip it as `cmi5.xml` and import the zip. For the demo's page and quiz the zip is ready at
`/demo/cmi5-course.zip` (`apps/demo/demo/cmi5-course.zip`; `zip cmi5-course.zip cmi5.xml`
rebuilds it). The LMS appends `endpoint`, `fetch`, `actor`, `registration` and `activityId` to
the URL. Instead of `?src=`, the AU may name the package in `<launchParameters>`. The package URL
needs CORS headers, as in every setup.

With no `launchMethod`, the LMS chooses where the page opens, usually a frame of the course page;
the player runs there in Chrome, Safari and iOS alike. Set `launchMethod="OwnWindow"` when:

- the LMS serves its pages over plain `http`, which leaves a frame with no Service Worker;
- the content needs fullscreen and the LMS's iframe has no `allow="fullscreen"`.

On Exit the page goes to the launch's `returnURL`, followed only if it is an `http` or `https`
address. With none, a top-level window closes and a framed page stays where it is, so tell the
learner to go back to the course.

## What the page sends

1. **`initialized`**, once the token, launch data and learner preferences are in. Statements the
   content emits earlier wait for it.
2. **Every Activity statement the player emits**, as a cmi5 allowed statement: the launch actor,
   the registration, and the LMS's context template merged in (the template wins on a conflict),
   with `context.revision` and `context.platform` kept, and a UUID id. A statement not about an
   Activity, or without `context.platform` (which the player sets on every statement it passes
   on), is reported and dropped. One with the platform but no revision is sent: the player
   releases held statements without one, on a host without `Range`, when the load ends or the page
   is hidden before the archive's index answered.
3. **On the content's result** (the `finished` event: its own `completed` or `answered`, never a
   part's): `passed` or `failed`, then `completed`. A mastery score in the launch decides, and
   a result with no score then gets neither `passed` nor `failed`; without a mastery score, H5P's
   own verdict decides. The score, with `min: 0`, `max` and `raw`, rides on `passed` or `failed`
   only. `completed` and `passed` go out once per registration (an earlier session's is not sent
   again), and `failed` at most once per session, never after `passed`. If the LRS cannot be
   asked, the session counts for itself and reports `registration-unread`. In `Browse` or `Review`
   mode no result is recorded. A unit holding Interactive Book completes only when the book's
   report is submitted, which needs `reporting` on the element; without it the book reports no
   result of its own and the unit never completes. Nor does a unit holding a Virtual Tour, which
   reports none.
4. **`terminated`** from Exit. A closed tab sends nothing; the LMS records the session as
   `abandoned`.

The content's later statements are relayed until Exit. If the LRS rejects the completion,
`session.retry()` sends it again. A refused statement's `rejected` event carries the LMS's reason.

## Checking it

`pnpm cmi5:catapult` runs the page against ADL's
[CATAPULT](https://github.com/adlnet/CATAPULT), the reference cmi5 launching system, which
rejects any statement that breaks a cmi5 requirement and names it. It needs Docker; the first
run builds the player's image, which takes a few minutes.

```bash
pnpm cmi5:catapult                  # headless: two sessions of the quiz, then the verdict
pnpm cmi5:catapult --open           # prints a launch URL for your own browser, waits for Exit
pnpm cmi5:catapult --au '<AU URL>'  # launches another page instead of the dev server's
pnpm cmi5:catapult --down           # removes the stack and its data
```

The LRS's admin UI is at `http://localhost:63390/admin`, user `admin`, password
`admin-password-1`. A page launched with `--au` must be allowed by its own CSP to reach
`http://localhost:63398`, and Chrome asks before a public site reaches a local address.

The unit tests are in `packages/cmi5/tests/`; `requirements.test.ts` places every AU requirement
of `@cmi5/requirements`.

## What it does not do

- It does not turn H5P's interactions into cmi5 interaction statements; H5P's own statements
  carry the answers.
- It does not apply the learner's audio preference; it is on the session as
  `learnerPreferences.audioPreference` for the page to act on.
- It does not keep the content's own progress; the element's [`resume`](resume.md) does that,
  alongside.
