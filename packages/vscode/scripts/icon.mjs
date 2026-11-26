import { readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'

/**
 * Renders `icon.png` from the demo's `demo/favicon.svg`, so no logo drifts: 256 px square, as the
 * Marketplace takes 128 at least. Rasterized in Chromium, as the repo has no image tooling.
 */

const SIZE = 256

const svg = await readFile(new URL('../../../apps/demo/demo/favicon.svg', import.meta.url), 'utf8')
const browser = await chromium.launch()
try {
  const tab = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 })
  await tab.setContent(`<!doctype html>
<html><head><meta charset="utf-8" /><style>
  html, body { margin: 0; background: transparent; }
  svg { display: block; width: ${SIZE}px; height: ${SIZE}px; }
</style></head><body>${svg}</body></html>`)
  const png = await tab.screenshot({ type: 'png', omitBackground: true })
  await writeFile(new URL('../icon.png', import.meta.url), png)
  console.log(`icon.png: ${SIZE} px, ${(png.length / 1024).toFixed(1)} kB`)
} finally {
  await browser.close()
}
