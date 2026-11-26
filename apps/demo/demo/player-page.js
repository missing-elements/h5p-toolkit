/**
 * The hosted player page's own logic. That split is the point of the demo: the element reports what
 * happened and this decides what to show (no URL field, picker, progress bar or banner).
 */

import { foreignHost, logInto, messageIn, packageUrl, trustPrompt } from './page-common.js'
import { pack } from '@missing-elements/h5p-libraries'

const player = document.querySelector('h5p-player')
const form = document.querySelector('#load-form')
const urlInput = document.querySelector('#url')
const fileInput = document.querySelector('#file')
const status = document.querySelector('#status')
const stateBadge = document.querySelector('#state')
const timer = document.querySelector('#timer')
const bar = document.querySelector('#progress')
const message = document.querySelector('#message')
const log = document.querySelector('#log')
const refreshToggle = document.querySelector('#refresh')
const downgradeToggle = document.querySelector('#downgrade')
const confirmBox = document.querySelector('#confirm-src')
const modeNote = document.querySelector('#mode-note')
const modeTag = document.querySelector('#mode-tag')
const reportRow = document.querySelector('#report-row')
const reportButton = document.querySelector('#report')

const write = logInto(log)
const show = messageIn(message)
/** The question before a link from another site plays with its own code; any other load dismisses it. */
const trust = trustPrompt(confirmBox, document.querySelector('#confirm-open'))

/**
 * What a host page can usefully say about each failure. Only codes whose own message is technical
 * get a canned one; `bad-archive`, `runtime` and `quota` already arrive as a sentence for a person.
 */
const EXPLANATIONS = {
  'no-cors':
    'That host does not send CORS headers, so no browser can read the file from this page. ' +
    'Download the .h5p and open it with "Choose file".',
  'no-worker':
    'This page needs a Service Worker. Open it over https:// or localhost in Safari, Chrome, ' +
    'Firefox or Edge — an in-app browser will not do.',
  network: 'The package could not be fetched. Check the URL.'
}

/**
 * The clock, from the load asked for until the player is ready or failed. Each state is logged
 * with its time: a long `probing` is a slow host, a long `indexing` a slow package or libraries.
 */
let loadStarted = null
let ticking = null

const seconds = (ms) => `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
const elapsed = () => (loadStarted === null ? null : performance.now() - loadStarted)

const startClock = () => {
  loadStarted = performance.now()
  clearInterval(ticking)
  ticking = setInterval(() => {
    timer.textContent = seconds(elapsed())
  }, 100)
  timer.textContent = '0.00 s'
  timer.hidden = false
}

const stopClock = (label) => {
  clearInterval(ticking)
  ticking = null
  const ms = elapsed()
  if (ms === null) return null
  timer.textContent = `${label} ${seconds(ms)}`
  return ms
}

player.addEventListener('statechange', (event) => {
  const { state } = event.detail
  stateBadge.textContent = state
  stateBadge.dataset.state = state
  status.dataset.state = state
  if (state !== 'error') show('')
  bar.hidden = state !== 'downloading'
  modeTag.hidden = state !== 'ready'

  if (state === 'ready') {
    const ms = stopClock('ready in')
    write(ms === null ? 'ready' : `ready  ${seconds(ms)}`)
  } else if (state === 'error') {
    stopClock('failed after')
  } else if (state === 'idle') {
    stopClock('')
    timer.hidden = true
    loadStarted = null
  } else if (loadStarted !== null) {
    write(`${state}  ${seconds(elapsed())}`)
  }
})

player.addEventListener('progress', (event) => {
  const { fraction, phase, entry } = event.detail
  // A download from a host that ignores Range keeps going after the content is up: the bar shows
  // it, and goes away when it is done.
  bar.hidden = fraction === 1
  if (fraction === null) bar.removeAttribute('value')
  else bar.value = fraction

  if (phase === 'warm') {
    // The libraries being pulled into the cache in a few requests, before the frame boots.
    show('Loading the libraries')
  }
  if (phase === 'extract') {
    // Deliberately not "playback starts before it finishes": whether it does depends on where
    // the mp4 keeps its index, and a file with it at the end plays nothing until the last byte.
    show(`Extracting ${entry}`)
  }
})

player.addEventListener('ready', () => {
  bar.hidden = true
  const refreshed = player.libraryBundle?.refreshed ?? []
  const downgraded = player.downgradedLibraries
  const libraries = (count) => (count === 1 ? 'one library' : `${count} libraries`)
  modeTag.textContent =
    (player.untrusted
      ? "Untrusted · libraries from this site's pack · content checked"
      : refreshed.length > 0
        ? `Trusted · ${libraries(refreshed.length)} at the pack's newer version`
        : player.libraryBundle
          ? "Trusted · its own libraries, the rest from this site's pack"
          : 'Trusted · its own libraries') + (downgraded.length > 0 ? ` · ${libraries(downgraded.length)} older than the content` : '')
  write(`mode  ${modeTag.textContent}`)
  for (const { library, from, to } of refreshed) write(`refreshed  ${library} ${from} → ${to}`)
  for (const { library, from, to } of downgraded) write(`older  ${library} ${to}, made for ${from}`)
  // Made for a version this site's pack has not got yet, and played at its older one: most of the
  // time all of it works, but what the newer version added is not there, so the visitor is told.
  if (downgraded.length > 0) {
    show(
      "Made for newer library versions than this site's pack has, so it plays at older ones: " +
        `${downgraded.map(({ library, from, to }) => `${library} ${from} at ${to}`).join(', ')}. ` +
        'What the newer versions added is left out. Turn off Older if needed to refuse such packages instead.',
      'warning'
    )
  }
  // The build every statement will name in `context.revision`. On a host without Range the frame
  // can boot before the index that yields it, and the statements wait for it instead.
  if (player.revision) write(`revision  ${player.revision}`)
})

player.addEventListener('xapi', (event) => {
  write(`xapi  ${event.detail.verb ?? '(no verb)'}`)
})

player.addEventListener('finished', (event) => {
  const result = event.detail.statement?.result
  write(`finished  score ${result?.score?.raw ?? '?'} / ${result?.score?.max ?? '?'}`)
})

player.addEventListener('error', (event) => {
  const { code, message: detail, missingLibraries } = event.detail
  lastError = { code, message: detail, mainLibrary: missingLibraries?.mainLibrary, late: code === 'runtime' && player.state === 'ready' }
  bar.hidden = true
  // Played untrusted, the package needs its own copy of a library. From another site the visitor
  // decides, naming the host; otherwise the switch is the way back.
  if (missingLibraries?.carried && player.untrusted) {
    write(`refused  its own code: ${missingLibraries.folders.join(', ')}`)
    const host = currentLink && foreignHost(currentLink)
    if (host) {
      const link = currentLink
      show('')
      askBeforeOpening(host, () => {
        setMode('trusted')
        loadUrl(link)
      })
    } else {
      show(
        `Played untrusted, this package is refused: it needs its own copy of ${missingLibraries.folders.join(', ')}, ` +
          "newer than this site's library pack. Switch to Trusted to play it with its own scripts.",
        'warning'
      )
    }
    return
  }
  // A runtime error once the content is up does not stop it — content types throw non-fatal
  // exceptions routinely — so it is shown as a note, not as the player failing.
  const late = code === 'runtime' && player.state === 'ready'
  show(late ? `The content reported an error and kept running: ${detail}` : (EXPLANATIONS[code] ?? detail), late ? 'hint' : 'error')
  write(`error  ${code}: ${detail}`)

  // Missing with the pack offered: neither the package nor this site's pack has it (a newer major,
  // a missing type, a newer minor with Older if needed off). The element's text is for developers.
  if (missingLibraries) {
    show(
      `This package needs ${missingLibraries.folders.join(', ')}, which neither it nor this site's library pack has: ` +
        'a newer version than the pack, or a content type the pack does not serve.',
      'warning'
    )
  }
})

/**
 * The library pack, as Vite emits it, one archive per library: `libraries="pack"` takes from it the
 * libraries a package lacks and newer versions of those it carries, fetching only what is needed.
 */
player.pack = pack
player.setAttribute('libraries', 'pack')

/**
 * Replays the last load. A closure, not a URL: a package picked from disk has no URL to re-set, and
 * that is where the retry is wanted.
 */
let reload = null

/**
 * Where the embed snippets point: this site's own `/embed` and `/resizer.js`, never a third party,
 * as a snippet offered here is pasted into live pages and should send learners nowhere else.
 */
const EMBED_ORIGIN = location.origin

/**
 * What the H5P embed button offers: this site's page around the package, with H5P's `:w` and `:h`
 * for the size the visitor picks. Set per load; a picked file has no URL, so the button stays off.
 */
const embedCodeFor = (url) =>
  `<iframe src="${EMBED_ORIGIN}/embed?src=${encodeURIComponent(new URL(url, location.href).href)}" width=":w" height=":h" allow="fullscreen; microphone; camera" style="border: 0"></iframe>`

// The sizing script the embed dialog offers under "advanced": `/resizer.js` is the page-side half
// of H5P's resizer protocol, so the embedding page sends nothing to h5p.org.
player.setAttribute('resize-code', `<script src="${EMBED_ORIGIN}/resizer.js"></script>`)

/** The link being played, for the question a refusal of its own code asks. */
let currentLink = null

/** What the load being shown played, `{ url }` or `{ file }`, and its last error: for the report. */
let playing = null
let lastError = null

const startReport = (what) => {
  playing = what
  lastError = null
  reportRow.hidden = false
}

/**
 * Trusted runs a package's own libraries, Untrusted plays it as data with this site's. The switch
 * holds for the next load; foreign links and the content-only sample set it too.
 */
const NOTES = {
  trusted: "The package's own scripts run on this site. What it lacks comes from this site's library pack, only the libraries it needs.",
  untrusted:
    "None of the package's own scripts run. Its libraries come from this site's pack, only the ones it needs, " +
    'and every field is checked against its library\'s definition, as the H5P plugins for Moodle, WordPress and Drupal check an upload.'
}
const REFRESH_NOTES = {
  on: ' Where the pack has a newer version of a library the package carries, that version plays.',
  off: ' The libraries the package carries play as exported.'
}
const DOWNGRADE_NOTES = {
  on: ' Content made for a newer version than anything here has plays at the newest older one, without what the newer version added.',
  off: ' Content made for a newer version than anything here has is refused.'
}
const playsUntrusted = () => form.elements.mode.value === 'untrusted'
const describeMode = () => {
  const mode = form.elements.mode.value
  modeNote.textContent =
    NOTES[mode] + (mode === 'trusted' ? REFRESH_NOTES[refreshToggle.checked ? 'on' : 'off'] : '') + DOWNGRADE_NOTES[downgradeToggle.checked ? 'on' : 'off']
  // Untrusted, none of the package's own libraries play, so there is nothing to refresh.
  refreshToggle.disabled = mode === 'untrusted'
}
const setMode = (mode) => {
  form.elements.mode.value = mode
  describeMode()
}
setMode(form.elements.mode.value)

const applyMode = () => {
  const untrusted = playsUntrusted()
  player.untrusted = untrusted
  if (refreshToggle.checked) player.removeAttribute('refresh-libraries')
  else player.setAttribute('refresh-libraries', 'off')
  if (downgradeToggle.checked) player.removeAttribute('downgrade-libraries')
  else player.setAttribute('downgrade-libraries', 'off')
  return (
    (untrusted ? '  (untrusted: none of its own code runs)' : refreshToggle.checked ? '' : '  (libraries as exported)') +
    (downgradeToggle.checked ? '' : '  (no older versions)')
  )
}

/** Plays a package at a URL, in the switch's mode. */
const loadUrl = (url) => {
  const address = packageUrl(url)
  if (!address) {
    show(`That is not an http or https address: ${url}`, 'error')
    return
  }
  log.textContent = ''
  trust.dismiss()
  reload = () => loadUrl(url)
  currentLink = url
  startReport({ url })
  write(`loading  ${url}${applyMode()}`)
  // The embed code is read with the load, like `libraries`, so it goes on before `src`.
  player.setAttribute('embed-code', embedCodeFor(url))
  // Removed first so re-setting the same URL still counts as a change. Removing it empties the
  // player at once, through `idle`, which stops the clock: so the clock starts after it.
  player.removeAttribute('src')
  startClock()
  player.setAttribute('src', address.href)
}

const loadFile = (file) => {
  log.textContent = ''
  trust.dismiss()
  reload = () => loadFile(file)
  currentLink = null
  startReport({ file })
  write(`loading  ${file.name} (${(file.size / 1024).toFixed(0)} kB, from disk)${applyMode()}`)
  startClock()
  urlInput.value = ''
  player.removeAttribute('embed-code')
  player.file = file
}

form.addEventListener('submit', (event) => {
  event.preventDefault()
  const url = urlInput.value.trim()
  if (url) loadUrl(url)
})


fileInput.addEventListener('change', () => {
  const [file] = fileInput.files
  if (file) loadFile(file)
})

// The same package again in the other mode, which is the quickest way to see the difference.
for (const input of form.elements.mode) {
  input.addEventListener('change', () => {
    setMode(input.value)
    reload?.()
  })
}

// And with its libraries as exported, or at the pack's newer versions: an older export's look
// against the current one.
refreshToggle.addEventListener('change', () => {
  describeMode()
  reload?.()
})

// And content made for a newer version than the pack has: played at its older one, or refused.
downgradeToggle.addEventListener('change', () => {
  describeMode()
  reload?.()
})

// A sample marked `data-untrusted` plays as data against this site's bundle: a content-only export,
// as h5p.com and h5p.org make them. The others play in whichever mode the switch is in.
for (const button of document.querySelectorAll('.samples button')) {
  button.addEventListener('click', () => {
    urlInput.value = button.dataset.src
    if ('untrusted' in button.dataset) setMode('untrusted')
    loadUrl(button.dataset.src)
  })
}

/**
 * "My file does not play": GitHub's bug report form, filled in from the load. Addresses lose their
 * query and fragment, as a signed URL carries credentials and an issue is public.
 */
const REPORT_FORM = 'https://github.com/missing-elements/h5p-toolkit/issues/new'
/** GitHub answers a longer address with a 414, so the log is cut from its middle to fit. */
const REPORT_MAX_LENGTH = 7000

const withoutQuery = (text) => {
  try {
    const url = new URL(text, location.href)
    url.search = ''
    url.hash = ''
    return url.href
  } catch {
    return text
  }
}
const scrub = (text) => text.replace(/https?:\/\/[^\s"'<>]+/g, (address) => withoutQuery(address))

/** The file's name, or the last part of the link's path. */
const packageName = () => {
  if (playing?.file) return playing.file.name
  const url = new URL(playing.url, location.href)
  const last = url.pathname.split('/').filter(Boolean).pop()
  try {
    return last ? decodeURIComponent(last) : url.host
  } catch {
    return last
  }
}

const reportUrl = () => {
  const name = packageName()
  const on = (toggle) => (toggle.checked ? 'on' : 'off')
  const link = playing.url ? withoutQuery(playing.url) : null
  const queryLeftOut = link !== null && link !== new URL(playing.url, location.href).href
  const what = lastError
    ? `${lastError.late ? 'It started, then the content reported an error' : 'The player stopped with an error'}: ` +
      `${lastError.code}: ${scrub(lastError.message ?? '').slice(0, 600)}`
    : `The player reached "${player.state}" and reported no error.`

  const description =
    `${name} does not play on the demo's player page, ${location.origin}/.\n\n` +
    `${what}\n` +
    `Content type: ${player.metadata?.mainLibrary ?? lastError?.mainLibrary ?? 'not known'}\n\n` +
    'What I expected, and what I see instead:\n'
  const reproduction =
    (link ? `1. Open ${location.origin}/?src=${encodeURIComponent(link)}\n` : `1. Open ${location.origin}/ and choose the file from disk.\n`) +
    `2. It plays ${playsUntrusted() ? 'Untrusted' : 'Trusted'}, with Newest libraries ${on(refreshToggle)} and Older if needed ${on(downgradeToggle)}.\n\n` +
    `The package: ${link ? `${link}${queryLeftOut ? ' (its query left out)' : ''}` : `${name}, ${(playing.file.size / 1024).toFixed(0)} kB, from disk`}.\n` +
    'Attach it here only if it may be shared publicly: GitHub takes it renamed to .zip, up to 25 MB.'
  const environment =
    `Package version: h5p-offline-player ${__PLAYER_VERSION__}, on ${location.host}\n` +
    `Browser and version: ${navigator.userAgent}\n` +
    `Operating system: ${navigator.userAgentData?.platform ?? ''}`

  // Oldest first, as it happened, without the statements, which say nothing about a failure.
  const events = log.textContent
    .split('\n')
    .filter((line) => line && !/^\S+ {2}xapi /.test(line))
    .reverse()
    .map(scrub)
  const address = (lines) =>
    `${REPORT_FORM}?${new URLSearchParams({
      template: 'bug_report.yml',
      title: `[Bug]: ${name} does not play`,
      component: 'h5p-offline-player',
      description,
      reproduction,
      environment,
      logs: `The page's event log:\n\n\`\`\`text\n${lines.join('\n')}\n\`\`\``
    })}`
  // The load and its first states are at the start, the failure at the end: both are kept.
  for (let keep = events.length; ; keep = Math.floor(keep * 0.7)) {
    const lines = keep >= events.length ? events : [...events.slice(0, Math.ceil(keep / 2)), `… ${events.length - keep} lines left out`, ...events.slice(events.length - Math.floor(keep / 2))]
    const result = address(lines)
    if (result.length <= REPORT_MAX_LENGTH || keep < 4) return result
  }
}

reportButton.addEventListener('click', () => {
  window.open(reportUrl(), '_blank', 'noopener')
})

const askBeforeOpening = trust.ask

// `?src=` makes the page linkable.
const initial = new URLSearchParams(location.search).get('src')
if (initial) {
  urlInput.value = initial
  if (foreignHost(initial)) setMode('untrusted')
  loadUrl(initial)
}
