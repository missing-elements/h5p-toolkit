// The Star button's count. A classic script in <head>, like theme.js: the last count is on <html>
// before the first paint, so the button does not grow under the reader.
;(() => {
  // Hidden in an installed window (app.css), so nothing is asked: an offline app should not reach a
  // third party.
  if (matchMedia('(display-mode: standalone), (display-mode: window-controls-overlay)').matches) return

  const API = 'https://api.github.com/repos/missing-elements/h5p-toolkit'
  const KEY = 'h5p-demo-stars'
  // At most one request an hour (GitHub allows 60 per address, and a school is one); after a rate
  // limit, when GitHub says it lifts (`X-RateLimit-Reset`). Stored before asking.
  const FRESH_MS = 60 * 60 * 1000
  const RETRY_MS = 10 * 60 * 1000
  const root = document.documentElement
  const format = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })

  const stored = () => {
    try {
      // A record without `next` is the first cut's, which could hold a visitor back for an hour
      // after a limit had lifted: it counts as nothing, and the page asks again.
      const kept = JSON.parse(localStorage.getItem(KEY) ?? 'null')
      return kept && typeof kept.next === 'number' ? kept : null
    } catch {
      return null
    }
  }
  const store = (kept) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(kept))
    } catch {
      // No storage: the next page asks again.
    }
  }

  // The label says the count too, since the drawn one is generated content the label replaces.
  const label = () => {
    const count = Number(root.dataset.stars)
    if (!Number.isInteger(count)) return
    for (const button of document.querySelectorAll('.star-button')) {
      button.setAttribute('aria-label', `Star on GitHub, ${count} ${count === 1 ? 'star' : 'stars'}`)
    }
  }
  const show = (count) => {
    root.dataset.stars = String(count)
    root.style.setProperty('--star-count', JSON.stringify(format.format(count)))
    label()
  }

  const kept = stored()
  if (Number.isInteger(kept?.count)) show(kept.count)
  addEventListener('DOMContentLoaded', label)

  if (kept && Date.now() < kept.next) return
  const last = kept?.count ?? null
  store({ count: last, next: Date.now() + RETRY_MS })
  fetch(API, { referrerPolicy: 'no-referrer' })
    .then((response) => {
      if (response.ok) return response.json()
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000
      if (reset > Date.now()) store({ count: last, next: reset })
      return null
    })
    .then((repository) => {
      const count = repository?.stargazers_count
      if (!Number.isInteger(count)) return
      store({ count, next: Date.now() + FRESH_MS })
      show(count)
    })
    .catch(() => {})
})()
