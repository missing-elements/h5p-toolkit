import { setEvictionListener, setEvictionPolicy } from './chunk-store.js'
import * as db from './idb.js'
import { busyPackages } from './locks.js'

/**
 * Which package a quota squeeze may drop: the coldest by `lastPlayed` that is neither the one being
 * written nor under a lock on the origin. Both workers install it: either can hit the wall.
 */
export async function coldestIdlePackage(
  exceptPkgId: string,
  lookups: {
    packagesByAge?: () => Promise<Array<{ pkgId: string }>>
    busyPackages?: () => Promise<Set<string>>
  } = {}
): Promise<string | null> {
  const [byAge, busy] = await Promise.all([
    (lookups.packagesByAge ?? db.packagesByAge)(),
    (lookups.busyPackages ?? busyPackages)()
  ])
  return byAge.find((record) => record.pkgId !== exceptPkgId && !busy.has(record.pkgId))?.pkgId ?? null
}

/** Points the chunk store's eviction at the `packages` table, and cleans the table up after it. */
export function installEvictionPolicy(onEvicted?: (pkgId: string) => void): void {
  setEvictionPolicy((exceptPkgId) => coldestIdlePackage(exceptPkgId))
  setEvictionListener(async (pkgId) => {
    onEvicted?.(pkgId)
    await db.deletePackage(pkgId)
  })
}
