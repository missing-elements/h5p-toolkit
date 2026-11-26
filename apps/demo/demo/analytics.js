import { inject } from '@vercel/analytics'

// Page views for the hosted demo (Vercel Web Analytics): no cookies, reports to this site's own
// origin, so no CSP change. Loaded by `partials/head.html`, so not on the app page.
inject()
