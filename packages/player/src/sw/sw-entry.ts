/// <reference lib="webworker" />
import { configure } from '@zip.js/zip.js'
import { mountH5P } from './mount.js'

/**
 * The standalone Service Worker, a self-contained IIFE at `dist/h5p-sw.js` for sites with no build.
 * A host that enforces a single worker imports `mountH5P` from the package's `/sw` export instead.
 */

// A Service Worker cannot spawn a nested Worker, so zip.js has to inflate in place. It uses the
// platform's own `DecompressionStream` for deflate, which is where the work would have gone anyway.
configure({ useWebWorkers: false })

mountH5P(self as unknown as ServiceWorkerGlobalScope)
