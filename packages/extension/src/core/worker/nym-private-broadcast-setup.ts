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
        routes: NYM_PRIVATE_BROADCAST.routes
      })
    : null

if (nymPrivateBroadcast && __DEBUG_LOGS__) {
  // Counters only, for isolated verification builds.
  Object.defineProperty(self, '__noirNymPrivateBroadcastStats', {
    value: nymPrivateBroadcast.stats
  })
}
