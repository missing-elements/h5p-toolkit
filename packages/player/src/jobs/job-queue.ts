import type { EntryLocation, SourceDescriptor } from '../shared/protocol.js'

/**
 * Extraction order, one at a time (two inflates slow the visible video): demands before
 * prefetches, a repeat first. Never interrupt the running job: a deflate stream cannot resume.
 */

export interface ExtractJob {
  pkgId: string
  entry: string
  location: EntryLocation
  source: SourceDescriptor
  prefetch: boolean
}

export type Placement = 'added' | 'promoted' | 'unchanged'

export class JobQueue {
  private readonly items: ExtractJob[] = []

  request(job: ExtractJob): Placement {
    const index = this.items.findIndex((item) => item.pkgId === job.pkgId && item.entry === job.entry)
    if (index >= 0) {
      if (job.prefetch || index === 0) return 'unchanged'
      const [waiting] = this.items.splice(index, 1)
      this.items.unshift({ ...waiting, prefetch: false })
      return 'promoted'
    }
    if (job.prefetch) {
      this.items.push(job)
    } else {
      const firstPrefetch = this.items.findIndex((item) => item.prefetch)
      this.items.splice(firstPrefetch === -1 ? this.items.length : firstPrefetch, 0, job)
    }
    return 'added'
  }

  next(): ExtractJob | undefined {
    return this.items.shift()
  }

  /** Drops every queued job of a package; the running one is not here and is aborted separately. */
  drop(pkgId: string): void {
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      if (this.items[i].pkgId === pkgId) this.items.splice(i, 1)
    }
  }

  get size(): number {
    return this.items.length
  }

  waiting(): ReadonlyArray<ExtractJob> {
    return this.items
  }
}
