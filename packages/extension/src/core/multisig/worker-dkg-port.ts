/**
 * The real DkgPort. `open` and `save` are handled by Background (`vault.group.*`): it checks the
 * scope, binds the wallet's credential before forwarding an open to the Zcash Worker, and stores
 * the sealed record on save. The round and close calls travel Background → Offscreen → Worker as
 * vault RPCs.
 */
import { requestVaultDkg, requestVaultGroup } from '@/core/worker/client'
import type { DkgPort } from './dkg-port'

export function createWorkerDkgPort(): DkgPort {
  return {
    open: request => requestVaultGroup('vault.group.open', request),
    acceptRound1: request => requestVaultDkg('vault.dkg.acceptRound1', request),
    acceptRound2: request => requestVaultDkg('vault.dkg.acceptRound2', request),
    close: async request => {
      await requestVaultDkg('vault.dkg.close', request)
    },
    // The group activates on a resolved save, so any answer but an explicit `true` must fail.
    save: async request => {
      if ((await requestVaultGroup('vault.group.save', request)) !== true) {
        throw new Error('Vault record could not be saved')
      }
    }
  }
}
