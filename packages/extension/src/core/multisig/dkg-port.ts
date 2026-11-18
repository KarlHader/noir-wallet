/**
 * What the create-session store needs from the coordinator side of the DKG, independent of where
 * that runs: the Zcash Worker in the extension, or an in-process handler in Node tests.
 */
import type {
  VaultDkgAcceptRequest,
  VaultDkgConfirmRequest,
  VaultDkgRound1Response,
  VaultDkgRound2Response
} from './dkg-rpc'
import type { VaultGroupOpenRequest, VaultGroupSaveRequest } from './vault-group-rpc'

export interface DkgPort {
  /** Background names the scope's wallet before the Worker opens the session. */
  open(request: VaultGroupOpenRequest): Promise<{ sessionId: string }>
  acceptRound1(request: VaultDkgAcceptRequest): Promise<VaultDkgRound1Response>
  acceptRound2(request: VaultDkgAcceptRequest): Promise<VaultDkgRound2Response>
  confirmRound1(request: VaultDkgConfirmRequest): Promise<void>
  close(request: { sessionId: string }): Promise<void>
  /** Background stores the sealed record for the scope's account before the group activates. */
  save(request: VaultGroupSaveRequest): Promise<void>
}

/**
 * Defers `load` to the first call, so the Worker client is only pulled in once a Bluetooth
 * ceremony actually starts. A failed load is forgotten so the next call can try again.
 */
export function createLazyDkgPort(load: () => Promise<DkgPort>): DkgPort {
  let loading: Promise<DkgPort> | null = null
  const port = (): Promise<DkgPort> => {
    loading ??= load().catch((error: unknown) => {
      loading = null
      throw error
    })
    return loading
  }
  return {
    open: request => port().then(loaded => loaded.open(request)),
    acceptRound1: request => port().then(loaded => loaded.acceptRound1(request)),
    acceptRound2: request => port().then(loaded => loaded.acceptRound2(request)),
    confirmRound1: request => port().then(loaded => loaded.confirmRound1(request)),
    close: request => port().then(loaded => loaded.close(request)),
    save: request => port().then(loaded => loaded.save(request))
  }
}
