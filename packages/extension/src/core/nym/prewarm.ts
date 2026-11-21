export interface NymPrewarmTriggerOptions {
  now(): number
  minIntervalMs: number
  /** Destinations the next broadcast will use; empty while Nym routing is off. */
  loadOrigins(): Promise<readonly string[]>
  prewarm(origins: readonly string[]): Promise<void>
}

/**
 * Returns a trigger for "a send is being prepared". It readies the tunnel at most once per
 * interval, so repeated fee estimates keep one tunnel proven without a request each time.
 */
export function createNymPrewarmTrigger(options: NymPrewarmTriggerOptions): () => void {
  let lastStartedAt = Number.NEGATIVE_INFINITY
  return () => {
    const now = options.now()
    if (now - lastStartedAt < options.minIntervalMs) return
    lastStartedAt = now
    void options
      .loadOrigins()
      .then(origins => (origins.length > 0 ? options.prewarm(origins) : undefined))
      .catch(() => {
        // Let the next preparation try again; the broadcast reports tunnel failures itself.
        lastStartedAt = Number.NEGATIVE_INFINITY
      })
  }
}
