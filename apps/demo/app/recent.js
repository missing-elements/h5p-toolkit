/**
 * The files opened in the app, for the home list, and what reopens each: a file handle where the
 * browser gives one, else a copy; a link as its address. Any package played here can read it.
 */

const DB_NAME = 'h5p-app'
const DB_VERSION = 1
/** One record per file or link: see `remember`. */
const ENTRIES = 'recent'
/** The copies, by the same key, apart from the list so that reading the list reads no file. */
const COPIES = 'copies'
/** How many the list keeps; the oldest goes, with its copy, when one more is opened. */
const RECENT_LIMIT = 20

/** A picked file's key: what the player knows a file by, so its saved place comes back with it. */
export const fileKey = (file) => `file:${file.name}:${file.size}:${file.lastModified}`
export const linkKey = (url) => `link:${url}`

let connection = null

function database() {
  connection ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(ENTRIES)) db.createObjectStore(ENTRIES, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(COPIES)) db.createObjectStore(COPIES)
    }
    request.onsuccess = () => {
      const db = request.result
      // Clearing site data closes the connection under the page: open another next time.
      db.onclose = () => (connection = null)
      db.onversionchange = () => {
        db.close()
        connection = null
      }
      resolve(db)
    }
    request.onerror = () => reject(request.error)
  }).catch((error) => {
    connection = null
    throw error
  })
  return connection
}

const settled = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

/**
 * Resolves once the transaction has committed, not when its request succeeded: a large copy that
 * does not fit fails as the transaction commits, after `put` has already reported success.
 */
const committed = (transaction) =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error ?? new DOMException('The write was abandoned', 'AbortError'))
  })

async function read(store, query) {
  const db = await database()
  return settled(query(db.transaction(store).objectStore(store)))
}

async function write(stores, change) {
  const db = await database()
  const transaction = db.transaction(stores, 'readwrite')
  change(transaction)
  await committed(transaction)
}

const newestFirst = (a, b) => b.openedAt - a.openedAt

/** The list, the file opened last first; empty where there is no database. */
export async function recentFiles() {
  try {
    return (await read(ENTRIES, (store) => store.getAll())).sort(newestFirst)
  } catch (error) {
    console.warn('[app] the list of recent files could not be read', error)
    return []
  }
}

/**
 * Records an open whose content came up. `file`, with no handle, is kept as a copy unless one is
 * kept; a handle makes an earlier copy unnecessary, so it goes.
 */
export async function remember(entry, file) {
  try {
    let copySize = null
    if (entry.handle) await write(COPIES, (transaction) => transaction.objectStore(COPIES).delete(entry.id))
    else if (file) copySize = await keepCopy(entry.id, file)
    await write(ENTRIES, (transaction) => transaction.objectStore(ENTRIES).put({ ...entry, copySize, openedAt: Date.now() }))
    const entries = (await read(ENTRIES, (store) => store.getAll())).sort(newestFirst)
    for (const old of entries.slice(RECENT_LIMIT)) await forget(old.id)
  } catch (error) {
    console.warn('[app] the list of recent files was not updated', error)
  }
}

/** The size of the copy kept of `file`, or `null` when there was no room for it. */
async function keepCopy(id, file) {
  try {
    if (!(await read(COPIES, (store) => store.count(id)))) await write(COPIES, (transaction) => transaction.objectStore(COPIES).put(file, id))
    return file.size
  } catch (error) {
    console.warn(`[app] no copy of ${file.name} was kept`, error)
    return null
  }
}

/**
 * The copy kept of a file, or `null` when none is kept, cleared or unreadable. A private profile
 * may keep only a reference to the file on disk, so a byte read finds a moved file out first.
 */
export async function copyOf(entry) {
  try {
    const blob = await read(COPIES, (store) => store.get(entry.id))
    if (!blob) return null
    await blob.slice(0, 1).arrayBuffer()
    return new File([blob], entry.name, { lastModified: entry.lastModified, type: blob.type })
  } catch (error) {
    console.warn(`[app] the copy of ${entry.name} could not be read`, error)
    return null
  }
}

/** Takes one off the list, and its copy with it. */
export async function forget(id) {
  try {
    await write([ENTRIES, COPIES], (transaction) => {
      transaction.objectStore(ENTRIES).delete(id)
      transaction.objectStore(COPIES).delete(id)
    })
  } catch (error) {
    console.warn('[app] a recent file was not removed', error)
  }
}

/** Empties the list, and every copy with it. */
export async function forgetAll() {
  try {
    await write([ENTRIES, COPIES], (transaction) => {
      transaction.objectStore(ENTRIES).clear()
      transaction.objectStore(COPIES).clear()
    })
  } catch (error) {
    console.warn('[app] the list of recent files was not cleared', error)
  }
}
