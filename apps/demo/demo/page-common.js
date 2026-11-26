/**
 * What the demo's pages share: a message box, a log, whether a package is from another site, and
 * the question before it plays with its own code. A fix once reached one page in three.
 */

/** How much of a page's log is kept, newest first. */
const LOG_LIMIT = 20_000

/** `show(text, kind)` for a page's message box: `hint` or `error`; empty text hides it. */
export const messageIn = (message) => (text, kind = 'hint') => {
  message.textContent = text
  message.className = `message ${kind}`
  message.hidden = !text
}

/** `write(line)` for a page's log: stamped, newest first, cut at `LOG_LIMIT`. */
export const logInto = (log) => (line) => {
  const stamp = new Date().toLocaleTimeString([], { hour12: false })
  log.textContent = `${stamp}  ${line}\n${log.textContent}`.slice(0, LOG_LIMIT)
}

/**
 * The host of a package on another site, or `null` for this site's own or a non-URL. A package's
 * own code runs with this origin's storage, so a link's `?src=` on another site plays `untrusted`.
 */
export const foreignHost = (src) => {
  try {
    const url = new URL(src, location.href)
    // A `data:` URL has no host and an opaque origin: name its scheme, so it counts as another site's.
    return url.origin === location.origin ? null : url.host || url.protocol
  } catch {
    return null
  }
}

/**
 * A package's address for the element: resolved against this page, only `http` or `https`, else
 * `null`. The element gets the parsed `href`, never the text, so `src` holds what was checked.
 */
export const packageUrl = (src) => {
  try {
    const url = new URL(src, location.href)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

/**
 * The question before another site's package plays with its own code: `ask(host, go)` runs `go` on
 * the one click, a later `ask` replaces it, `dismiss()` hides the box when moot.
 */
export const trustPrompt = (confirmBox, confirmButton) => {
  let pending = null
  confirmButton.addEventListener('click', () => {
    confirmBox.hidden = true
    const go = pending
    pending = null
    go?.()
  })
  return {
    ask(host, go) {
      confirmBox.querySelector('.host').textContent = host
      confirmBox.hidden = false
      pending = go
    },
    dismiss() {
      confirmBox.hidden = true
      pending = null
    }
  }
}
