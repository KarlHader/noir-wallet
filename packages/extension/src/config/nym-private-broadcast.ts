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
   * Zcash request categories that follow the user's Nym choice. A disabled category uses
   * its original transport; enabled categories never fall back to direct requests on failure.
   */
  routes: Object.freeze({
    broadcast: true,
    /**
     * lightwalletd GetStandardFee, asked only while a send is being prepared: sent directly,
     * it would show the node the sender's network address seconds before the broadcast.
     */
    feeQuote: true,
    transactionLookup: true,
    transparentHistory: true,
    // Includes address balance reads and the streaming UTXO endpoint used during sync.
    transparentUtxos: true,
    /**
     * Intents quotes and status reads for swaps that spend ZEC: they hand the swap service the
     * refund and deposit addresses seconds before and after the routed broadcast. Confidential
     * quotes stay direct because their signed session already identifies the account there.
     */
    zecSwap: true
  }),
  /**
   * Off: wallet sync's own transaction, transparent history and UTXO reads go direct, since
   * routed they held every sync on the mixnet and failed it whenever the tunnel failed. The
   * same reads outside sync, and any read while a send is queued or running, stay routed.
   */
  routeWalletSync: false,
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
   * Wait for one relayed request (txid status lookup, ZEC swap quote or status). A request
   * that outlasts a tunnel rebuild reports an error and its caller retries on its next poll
   * or quote; the rebuild continues.
   */
  relayTimeoutMs: 240_000
})
