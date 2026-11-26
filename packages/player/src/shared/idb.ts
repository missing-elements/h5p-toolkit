import { DB_NAME, DB_VERSION, PACKAGES_STORE } from './constants.js'
import type { PackageRecord } from './protocol.js'

/**
 * The `packages` table, opened by the page (descriptor before indexing) and the Service Worker
 * (adapters after a restart). Indexed on `lastPlayed` so eviction finds the coldest package.
 */

let dbPromise: Promise<IDBDatabase> | null = null

/**
 * Drops the cached handle so the next call opens a fresh one, only if it is still the current one:
 * a long-closed connection must not discard its replacement.
 */
function forget(db: IDBDatabase, opened: Promise<IDBDatabase>): void {
  if (dbPromise === opened) dbPromise = null
  db.close()
}

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise

  const opened: Promise<IDBDatabase> = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(PACKAGES_STORE)) {
        const store = db.createObjectStore(PACKAGES_STORE, { keyPath: 'pkgId' })
        store.createIndex('lastPlayed', 'lastPlayed')
      }
    }

    request.onsuccess = () => {
      const db = request.result

      // Long-lived, so it must survive the database going away: clearing site data closes it, and
      // a `deleteDatabase` elsewhere blocks until it is closed here. Else every call fails.
      db.onversionchange = () => forget(db, opened)
      db.onclose = () => forget(db, opened)

      resolve(db)
    }

    request.onerror = () => reject(request.error)
  })

  dbPromise = opened

  // A failed open must not be cached: the next call should try again.
  opened.catch(() => {
    if (dbPromise === opened) dbPromise = null
  })

  return opened
}

/** True for the errors a handle raises once the database beneath it is gone. */
function isConnectionGone(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'InvalidStateError' ||
      error.name === 'NotFoundError' ||
      error.name === 'TransactionInactiveError')
  )
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function runTransaction<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T>
): Promise<T> {
  const db = await openDatabase()
  const transaction = db.transaction(PACKAGES_STORE, mode)
  const result = await run(transaction.objectStore(PACKAGES_STORE))

  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })

  return result
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T>
): Promise<T> {
  try {
    return await runTransaction(mode, run)
  } catch (error) {
    if (!isConnectionGone(error)) throw error

    // The handle died between being handed out and used (site data cleared mid-request). Reopening
    // recreates the store, so the retry starts from an empty table, not failing for good.
    dbPromise = null
    return runTransaction(mode, run)
  }
}

export function getPackage(pkgId: string): Promise<PackageRecord | undefined> {
  return withStore('readonly', (store) => promisify(store.get(pkgId) as IDBRequest<PackageRecord | undefined>))
}

export function putPackage(record: PackageRecord): Promise<void> {
  return withStore('readwrite', async (store) => {
    await promisify(store.put(record))
  })
}

export function deletePackage(pkgId: string): Promise<void> {
  return withStore('readwrite', async (store) => {
    await promisify(store.delete(pkgId))
  })
}

export function allPackages(): Promise<PackageRecord[]> {
  return withStore('readonly', (store) => promisify(store.getAll() as IDBRequest<PackageRecord[]>))
}

/**
 * Reads a row and writes what `change` makes of it in one transaction, so two loads writing their
 * settings into the row's `views` at once cannot lose either. `undefined` writes nothing.
 */
export function changePackage(
  pkgId: string,
  change: (record: PackageRecord | undefined) => PackageRecord | undefined
): Promise<PackageRecord | undefined> {
  return withStore('readwrite', async (store) => {
    const next = change(await promisify(store.get(pkgId) as IDBRequest<PackageRecord | undefined>))
    if (next) await promisify(store.put(next))
    return next
  })
}

export async function touchPackage(pkgId: string): Promise<void> {
  await changePackage(pkgId, (record) => record && { ...record, lastPlayed: Date.now() })
}

export function updatePackage(
  pkgId: string,
  patch: Partial<PackageRecord>
): Promise<PackageRecord | undefined> {
  return changePackage(pkgId, (record) => record && { ...record, ...patch })
}

/** Packages ordered coldest first. Eviction walks this list. */
export async function packagesByAge(): Promise<PackageRecord[]> {
  const records = await allPackages()
  return records.sort((a, b) => a.lastPlayed - b.lastPlayed)
}
