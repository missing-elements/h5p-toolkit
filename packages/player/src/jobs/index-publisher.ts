import type { ForwardIndexSnapshot } from '../shared/forward-index.js'

/**
 * What a no-`Range` download publishes as it goes: the entries found so far, and progress reports.
 * A report goes out after its snapshot is stored, or the worker answers from the old one (#144).
 */
export class IndexPublisher {
  private published = -1
  private chain: Promise<void> = Promise.resolve()
  private refused = false

  constructor(
    private readonly scanner: { snapshot(): ForwardIndexSnapshot; finish(): void },
    private readonly write: (snapshot: ForwardIndexSnapshot) => Promise<void>
  ) {}

  /**
   * Stores what the scanner has found, when it is more than was stored; `final` stores it anyway.
   * Serialised so an older snapshot cannot land last; a refused write costs an early boot only.
   */
  publish(final: boolean): Promise<void> {
    if (final) this.scanner.finish()
    const snapshot = this.scanner.snapshot()
    if (!final && snapshot.entries.length === this.published) return this.chain
    this.published = snapshot.entries.length
    // Caught on each link: a rejected one would skip the rest and fail the download at the end.
    this.chain = this.chain
      .then(() => this.write(snapshot))
      .catch((error: unknown) => {
        if (this.refused) return
        this.refused = true
        console.warn('[h5p-player] the forward index could not be written; the frame boots once the download is whole:', error)
      })
    return this.chain
  }

  /**
   * Sends a progress report once the snapshot of what has arrived is stored, or refused. With
   * nothing new to store it waits for the writes under way, so reports keep their order.
   */
  report(send: () => void): void {
    void this.publish(false).then(send)
  }
}
