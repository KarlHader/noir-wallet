/**
 * Routing Zcash broadcasts through the Nym mixnet. `available` is the build-time switch that
 * packages the tunnel (`NYM_PRIVATE_BROADCAST=1`, isolated builds only; release builds leave it
 * off). In a build that has it, the user's wallet setting decides whether requests are routed.
 */
export const NYM_PRIVATE_BROADCAST = Object.freeze({
  available: typeof __NYM_PRIVATE_BROADCAST__ === 'boolean' && __NYM_PRIVATE_BROADCAST__,
  /** Per-endpoint ZeroIndexer send timeout; mixnet sends of ~10 KiB were measured up to 80 s. */
  zeroIndexerSendTimeoutMs: 150_000,
  /** Worker-side bound on one routed request, above the WASM's own per-endpoint timeout. */
  workerRequestTimeoutMs: 160_000,
  /** Worker-side bound on learning the user's routing choice before a broadcast. */
  workerModeTimeoutMs: 10_000,
  /**
   * Requests other than the broadcast that follow the user's routing choice. Each has its
   * own switch, so one can go back to a direct request without touching the others.
   */
  routes: Object.freeze({
    /**
     * lightwalletd GetStandardFee, asked only while a send is being prepared: sent directly,
     * it would show the node the sender's network address seconds before the broadcast.
     */
    feeQuote: true
  }),
  /**
   * Worker-side bound on a routed fee quote. Covers a warm tunnel and a tunnel build already
   * under way, and stays under the Worker RPC's 60 s LIGHT bound so a slow tunnel yields the
   * fallback rate instead of an RPC error.
   */
  feeQuoteTimeoutMs: 45_000,
  tunnelSetupTimeoutMs: 90_000,
  healthCheckTimeoutMs: 60_000,
  /** Re-check of a destination the tunnel already reached; such answers arrive within seconds. */
  recheckTimeoutMs: 20_000,
  /** A tunnel idle for longer than this is re-checked before it carries a request. */
  healthFreshMs: 60_000,
  /** While a send is being prepared, the tunnel is re-proven at most this often. */
  prewarmIntervalMs: 30_000,
  fetchTimeoutMs: 150_000,
  maxTunnelBuildAttempts: 3,
  /**
   * Background wait for one txid status lookup. A lookup that outlasts a tunnel rebuild
   * reports an error and the monitor retries on its next poll; the rebuild continues.
   */
  relayTimeoutMs: 240_000
})
