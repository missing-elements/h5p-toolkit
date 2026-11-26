/** Version of the element/worker pair. Kept in sync with package.json by scripts/sync-h5p-assets.mjs. */
export const VERSION = '1.7.1'

/** Major version. Cache names carry it, so a major bump discards every cached package. */
export const MAJOR_VERSION = 1

/**
 * The version of `@missing-elements/h5p-libraries` that `libraries="pack"` plays against. Stamped
 * from the checkout by scripts/sync-h5p-assets.mjs, so each player release pins one pack.
 */
export const LIBRARY_PACK_VERSION = '1.1.1'

/**
 * `libraries="pack"` with no copy of the host's own: one archive per hub library under `parts/`
 * on a CORS-enabled CDN. The hub is not asked: its one CORS host serves an outdated catalogue.
 */
export const LIBRARY_PACK_BASE = `https://cdn.jsdelivr.net/npm/@missing-elements/h5p-libraries@${LIBRARY_PACK_VERSION}/parts/`

/**
 * Where the element keeps the index of a `pack-base` copy as last read, so planning works offline.
 * Not under `CACHE_PREFIX`: eviction works by package and leaves it alone (a few kilobytes).
 */
export const PACK_INDEX_CACHE = 'h5p-pack-index'

/** One cache per package: `h5p-pkg-v<major>-<pkgId>`. */
export const CACHE_PREFIX = `h5p-pkg-v${MAJOR_VERSION}-`

/**
 * Chunk size for archives and extracted media: the unit of storage, and the ceiling on what one
 * read or write holds in memory. The segment window in `source.ts` is the one deliberate exception.
 */
export const CHUNK_SIZE = 8 * 1024 * 1024

/**
 * Non-text entries at or below this size are inflated whole into the cache on first request. Above
 * it a deflated entry goes to the Jobs worker and a stored one is sliced out of the source.
 */
export const INLINE_MAX_SIZE = 16 * 1024 * 1024

/**
 * Media's lower bar: a media element wants only the head, and an inline copy cost a 7 MB video 7 MB
 * at boot, watched or not. Above this, media is sliced or extracted and serves its head on demand.
 */
export const MEDIA_INLINE_MAX_SIZE = 1024 * 1024

/**
 * A large span is pulled as ranged requests of this size, `SEGMENT_CONCURRENCY` at once, in order.
 * Up to 16 MB is held, a deliberate loosening of one chunk in memory, so 4 MB and not 8.
 */
export const SEGMENT_SIZE = 4 * 1024 * 1024
// One connection is capped below the link: 2.0 MB/s on one, 2.6 on four, no gain at 8 (link 3.5).
export const SEGMENT_CONCURRENCY = 4

/** Below this, one request is better: the overlap cannot pay back its own latency. */
export const SEGMENT_MIN_SPAN = 8 * 1024 * 1024

/**
 * Small HTTP reads of an archive go through `BLOCK_SIZE` blocks (pdf.js's size, zip.js's own step).
 * Up to `BLOCK_CACHE_MAX_BYTES` per worker; a read over `BLOCK_CACHE_MAX_READ` bypasses it, so media does.
 */
export const BLOCK_SIZE = 64 * 1024
export const BLOCK_CACHE_MAX_BYTES = 4 * 1024 * 1024
export const BLOCK_CACHE_MAX_READ = 1024 * 1024

/** Reserved chunk-store entry name for the archive itself (chunked adapter). */
export const ARCHIVE_ENTRY = '__archive__'

/**
 * Reserved chunk-store entry name for the warm marker: its meta says the archive's inline spans
 * have been pulled into the cache, so a later load boots without asking the host.
 */
export const WARM_ENTRY = '__warm__'

/**
 * Warming, on a `Range` host: runs holding the declared libraries are pulled whole before boot, 2 requests
 * instead of 156. On a host serving one request at a time: 128 s to 9 s. Editor ones stay on demand (#148).
 */
// A span is a run of inline entries; a larger gap (a video between library folders) splits it.
export const WARM_GAP = 256 * 1024
export const WARM_ENTRY_MAX_SIZE = 1024 * 1024
export const WARM_MAX_BYTES = 16 * 1024 * 1024
// A span silent this long is given up, and the frame boots against whatever landed.
export const WARM_STALL_MS = 20_000

/**
 * How long the watermark may sit still before the virtual server concludes its job is gone. Not a
 * budget for the extraction: inflating a few hundred megabytes over a network takes minutes.
 */
export const COLD_ENTRY_WAIT_MS = 15_000

/**
 * How often a waiting response re-reads the watermark when no notice has arrived. Progress is sent
 * on a `BroadcastChannel` at once, so this only keeps stall detection honest.
 */
export const WATERMARK_POLL_MS = 500

/**
 * How long one job request suppresses the next for the same entry, so a media element's burst of
 * range requests is not a burst of messages. Short, as a job can die with its tab.
 */
export const JOB_REQUEST_DEDUPE_MS = 2_000

/**
 * How long a storage failure is taken at its word before the cache is tried again, as space may
 * have come back. Long enough that a probing media element does not recopy 10 MB per range request.
 */
export const FAILURE_BACKOFF_MS = 10_000

/**
 * How often a job announces the bytes it has taken from the network: the watermark cannot move
 * before the first inflate flush, so these tell a waiter slow from dead. Nothing is written.
 */
export const INPUT_LIVENESS_MS = 1_000

/**
 * A silent ranged read is aborted after `READ_STALL_MS` and reopened from the byte it reached; 30 s
 * clears the slowest first answer measured (14 s); a retry joins the back of that host's queue.
 */
export const READ_STALL_MS = 30_000
export const READ_RETRIES = 6
export const READ_RETRY_DELAY_MS = 1_000

/**
 * How long the Service Worker holds a fetch event open for a streaming body, as Firefox stops a
 * worker 30 s after its last event and cuts the body. Bounded below the 5 min where events end.
 */
export const STREAM_KEEPALIVE_MS = 240_000

/** IndexedDB database and store names. */
export const DB_NAME = 'h5p-player'
export const DB_VERSION = 1
export const PACKAGES_STORE = 'packages'

/**
 * Synthetic origin for chunk-store keys. The Cache API needs absolute http(s) URLs; these are
 * never fetched, so an unresolvable TLD keeps them from ever reaching the network.
 */
export const CHUNK_KEY_ORIGIN = 'https://chunks.h5p-player.invalid/'

/**
 * The learner's saved state, for `resume`, in its own database: a page bumping `DB_VERSION` would
 * leave a Service Worker on older code unable to open `DB_NAME`. Only the page opens this one.
 */
export const USER_DATA_DB_NAME = 'h5p-player-userdata'
export const USER_DATA_STORE = 'states'

/**
 * Seconds between the runtime's state saves while `resume` is on. H5P also saves 3 s after a
 * `completed` or `progressed` statement and on unload; unchanged state is not sent on.
 */
export const SAVE_INTERVAL_S = 10

/**
 * How long the first load after an update may spend bringing the Service Worker to the element's
 * version (a script fetch and an install); past it, the load goes ahead with the running worker.
 */
export const WORKER_UPDATE_TIMEOUT_MS = 3_000

/**
 * The same for a running worker of another major, which cannot serve the element: going ahead
 * failed 0.10 to 1.0, the new worker taking over mid-load, and the load never left `indexing`.
 */
export const WORKER_MAJOR_UPDATE_TIMEOUT_MS = 30_000

/** How long the element waits for the Service Worker to answer on the control channel. */
export const CONTROL_TIMEOUT_MS = 30_000
/**
 * How long the element waits for an answer a worker older than the question never gives — a
 * `find-downloaded-libraries` to an `h5p-sw.js` copied before it was added — where silence is a no.
 */
export const SILENT_ANSWER_TIMEOUT_MS = 3_000

/**
 * How long the virtual server waits for the page to hand over a picked `File` it asked for
 * (`need-file`) before the request for the entry is answered as unavailable.
 */
export const FILE_HANDOVER_TIMEOUT_MS = 15_000
