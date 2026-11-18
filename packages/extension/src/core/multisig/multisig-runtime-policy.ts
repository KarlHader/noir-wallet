import { MULTISIG_UI_CONFIG } from '@/config/multisig'

export function isMultisigUiEnabled(): boolean {
  return MULTISIG_UI_CONFIG.enabled
}

/**
 * The vault RPC handlers ship in every Worker bundle, but only a build with the multisig UI has a
 * caller for them. Background refuses the methods elsewhere so the surface stays unreachable.
 */
export function isVaultRpcBlocked(
  method: string,
  multisigUiEnabled: boolean = isMultisigUiEnabled()
): boolean {
  return method.startsWith('vault.') && !multisigUiEnabled
}

/**
 * Worker methods that take a wallet id. A page must not be able to name a wallet and get a share
 * sealed or a record opened under it, so only Background (via `vault.group.open` and
 * `vault.group.summary`) may send them.
 */
export function isBackgroundOnlyVaultRpc(method: string): boolean {
  return (
    method === 'vault.record.summary' ||
    method === 'vault.dkg.open' ||
    method.startsWith('vault.sign.worker.') ||
    method === 'wallet.registerFrostAccount' ||
    method === 'wallet.preflightFrostAccount' ||
    method === 'wallet.resolveFrostAccount'
  )
}
