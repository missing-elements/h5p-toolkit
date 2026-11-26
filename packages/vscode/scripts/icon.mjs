import { readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'

/**
 * Renders `icon.png` from `demo/favicon.svg` in Chromium (no image tooling), so no logo drifts: 256 px,
 * not the Marketplace's 128, to stay sharp on dense screens. Committed; rerun when the logo changes.
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
