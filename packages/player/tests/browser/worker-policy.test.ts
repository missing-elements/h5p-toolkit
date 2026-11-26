import { beforeAll, describe, expect, it } from 'vitest'
import '../../src/h5p-offline-player'
import { FIXTURES, clearPackageCaches, play } from './utils'

/**
 * A page whose policy refuses a `blob:` worker (`worker-src 'self'`, or `script-src 'self'`
 * alone): the element must fall back to `h5p-jobs.js`; a host without `Range` proves it.
 */
describe('a page that refuses blob: workers', () => {
  const blocked: string[] = []

  beforeAll(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      if (event.effectiveDirective === 'worker-src') blocked.push(event.blockedURI)
    })
    const policy = document.createElement('meta')
    policy.httpEquiv = 'Content-Security-Policy'
    policy.content = "worker-src 'self'"
    document.head.append(policy)
  })

  it('downloads through h5p-jobs.js after the blob: URL is refused', async () => {
    await clearPackageCaches()
    blocked.length = 0

    await play(FIXTURES.noRangeBasic)

    expect(blocked.some((uri) => uri.startsWith('blob'))).toBe(true)
  })

  it('never tries the blob: URL when `jobs` names the file', async () => {
    await clearPackageCaches()
    blocked.length = 0

    // Where the element finds it on this dev server: beside its own source.
    await play(FIXTURES.noRangeBasic, { jobs: '/src/h5p-jobs.js' })

    expect(blocked).toEqual([])
  })
})
