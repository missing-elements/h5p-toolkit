import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { preview } from 'vite'

/**
 * Renders the app's screenshots into `app/screenshots/`, named by the manifest for Chrome's install
 * dialog, from the built site: run `pnpm build:demo` first. Run this when the look changes.
 */

const rootDir = resolve(import.meta.dirname, '..')
const outDir = resolve(rootDir, 'app', 'screenshots')

const shots = [
  { name: 'narrow-home.png', width: 390, height: 844, scale: 2, modes: ['standalone'] },
  { name: 'narrow-quiz.png', width: 390, height: 844, scale: 2, modes: ['standalone'], src: '/demo/content/quiz.h5p' },
  // A JPEG, since most of it is a frame of video: a fifth of the PNG's size.
  { name: 'wide-video.jpg', width: 1280, height: 800, scale: 1, modes: ['standalone', 'window-controls-overlay'], src: '/demo/content/video.h5p' }
]

await mkdir(outDir, { recursive: true })
const server = await preview({ root: rootDir, logLevel: 'warn', preview: { port: 4398, strictPort: false } })
const base = server.resolvedUrls.local[0].replace(/\/$/, '')
const browser = await chromium.launch()
try {
  for (const { name, width, height, scale, modes, src } of shots) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, isMobile: scale > 1, hasTouch: scale > 1, colorScheme: 'light' })
    const page = await context.newPage()
    await page.goto(`${base}/app/${src ? `?src=${encodeURIComponent(src)}` : ''}`)
    // Chromium will not emulate `display-mode`, so the installed-app rules go on through the CSSOM.
    await page.evaluate((modes) => {
      for (const sheet of document.styleSheets) {
        for (const rule of sheet.cssRules) {
          if (rule instanceof CSSMediaRule && modes.some((mode) => rule.conditionText.includes(`display-mode: ${mode}`))) rule.media.mediaText = 'all'
        }
      }
    }, modes)
    await page.waitForFunction(() => document.querySelector('#offline')?.dataset.state === 'ready', null, { timeout: 60_000 })
    if (src) await page.waitForFunction(() => document.querySelector('h5p-player')?.state === 'ready', null, { timeout: 60_000 })
    // The content's fonts and a video's first frame, waited for rather than guessed at; capped,
    // so a video that never loads does not hold the render.
    const frame = page.frames().find((candidate) => candidate.url().includes('/h5p/frame/'))
    await Promise.race([
      Promise.all([
        page.evaluate(() => document.fonts.ready),
        frame?.evaluate(() =>
          Promise.all([
            document.fonts.ready,
            ...[...document.querySelectorAll('video')].map(
              (video) =>
                video.readyState >= 2 ||
                new Promise((resolve) => {
                  video.addEventListener('loadeddata', resolve, { once: true })
                  video.addEventListener('error', resolve, { once: true })
                })
            )
          ])
        )
      ]),
      page.waitForTimeout(5000)
    ])
    // One frame more, for what `loadeddata` and the fonts have yet to paint.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.screenshot({ path: resolve(outDir, name), ...(name.endsWith('.jpg') ? { type: 'jpeg', quality: 85 } : {}) })
    console.log(`[app-screenshots] ${name} ${width * scale}x${height * scale}`)
    await context.close()
  }
} finally {
  await browser.close()
  await server.close()
}
