import { NYM_PRIVATE_BROADCAST } from '@/config/nym-private-broadcast'
import {
  installNymPrivateBroadcastFetch,
  type PrivateBroadcastFetchController
} from '../nym/worker-private-broadcast-fetch'

// Installed before the WASM module loads; its bindings resolve the global fetch per call.
export const nymPrivateBroadcast: PrivateBroadcastFetchController | null =
  NYM_PRIVATE_BROADCAST.available
    ? installNymPrivateBroadcastFetch(self, {
        requestTimeoutMs: NYM_PRIVATE_BROADCAST.workerRequestTimeoutMs,
        modeTimeoutMs: NYM_PRIVATE_BROADCAST.workerModeTimeoutMs,
        base: self.location.href,
        routes: NYM_PRIVATE_BROADCAST.routes,
        routeWalletSync: NYM_PRIVATE_BROADCAST.routeWalletSync
      })
    : null

/** Marks one wallet sync step, whose own reads may go direct. */
export function duringWalletSync<T>(operation: () => Promise<T>): Promise<T> {
  return nymPrivateBroadcast ? nymPrivateBroadcast.duringWalletSync(operation) : operation()
}

/** Marks a send, which keeps every routed request routed until the returned call ends it. */
export function beginSend(): () => void {
  return nymPrivateBroadcast ? nymPrivateBroadcast.beginSend() : () => {}
}

if (nymPrivateBroadcast && __DEBUG_LOGS__) {
  // Counters only, for isolated verification builds.
  Object.defineProperty(self, '__noirNymPrivateBroadcastStats', {
    value: nymPrivateBroadcast.stats
  })
}
