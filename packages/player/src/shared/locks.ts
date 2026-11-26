/**
 * Web Lock names, `h5p:<pkgId>:<what>`: the Jobs worker holds one per write, the element `playing`
 * (shared). Eviction spares any package with a lock held: only locks know what is in use right now.
 */

export function packageLockName(pkgId: string, what: string): string {
  return `h5p:${pkgId}:${what}`
}

export function packageLockPrefix(pkgId: string): string {
  return `h5p:${pkgId}:`
}

const PACKAGE_LOCK = /^h5p:([^:]+):/

/** Packages with a lock held under their prefix right now, from every tab and worker on the origin. */
export async function busyPackages(): Promise<Set<string>> {
  const busy = new Set<string>()
  const locks = typeof navigator === 'undefined' ? undefined : (navigator as { locks?: LockManager }).locks
  if (!locks?.query) return busy

  try {
    const { held = [] } = await locks.query()
    for (const lock of held) {
      const match = lock.name ? PACKAGE_LOCK.exec(lock.name) : null
      if (match) busy.add(match[1])
    }
  } catch {
    // A platform that cannot answer is treated as having nothing in flight.
  }
  return busy
}
