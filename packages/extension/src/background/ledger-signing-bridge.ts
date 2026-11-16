import { parseChainId } from '@/core/chains/registry'
import { findLedgerPublicAccount } from '@/core/wallet/hardware-wallet-data'
import {
  IndexedDbCredentialRepository,
  IndexedDbStorageV2Repository
} from '@/infrastructure/persistence/repositories'
import { readActiveLedgerHardwareCredential } from '@/infrastructure/keyring/active-hardware-credential-inventory'
import type { LedgerSigningAccountBinding } from '@/infrastructure/keyring/multichain/ledger-signing-bridge'
import type { ChainId } from '@/core/chains/domain'
import { parseKeyDomainId, type KeyDomainId } from '@/core/keyring/domain'
import { credentialSession } from './credential-session'
import { requestLedgerSignature } from './ledger-signing-coordinator'

export async function resolveLedgerSigningAccount(
  keyDomainId: KeyDomainId,
  chainId: ChainId,
  accountIndex: number
): Promise<LedgerSigningAccountBinding | null> {
  if (!(await credentialSession.hasUnlockSession())) throw new Error('Wallet is locked')
  const storage = new IndexedDbStorageV2Repository()
  const pointer = await storage.getActivePointer()
  const snapshot = pointer ? await storage.getSnapshot(pointer.generationId) : null
  if (
    !snapshot ||
    snapshot.manifest.status !== 'verified' ||
    snapshot.manifest.sourceFingerprint !== pointer?.sourceFingerprint ||
    snapshot.manifest.activeAccount?.keyDomainId !== keyDomainId
  )
    throw new Error('Active Ledger account changed')
  const domain = snapshot.keyDomains.find(item => item.id === keyDomainId)
  if (!domain) throw new Error('Wallet not found')
  if (domain.source.kind === 'software' || domain.source.kind === 'private-key') return null
  if (domain.source.vendor !== 'ledger')
    throw new Error('This hardware Wallet does not support the requested signing adapter')
  const family =
    parseChainId(chainId).namespace === 'solana'
      ? 'solana'
      : parseChainId(chainId).namespace === 'near'
        ? 'near'
        : null
  if (!family) throw new Error('Unsupported Ledger signing chain')
  const accounts = snapshot.accounts.filter(
    item =>
      item.keyDomainId === keyDomainId &&
      item.accountIndex === accountIndex &&
      item.id === snapshot.manifest.activeAccount?.accountId
  )
  if (accounts.length !== 1) throw new Error('Ledger account index does not match active account')
  const chainAccounts = snapshot.chainAccounts.filter(
    item =>
      item.scope.keyDomainId === keyDomainId &&
      item.scope.accountId === accounts[0].id &&
      item.scope.chainId === chainId
  )
  if (chainAccounts.length !== 1) throw new Error('Ledger chain account not registered')
  const credential = await readActiveLedgerHardwareCredential(
    new IndexedDbCredentialRepository(),
    snapshot,
    keyDomainId,
    await credentialSession.getProvisioningPassword()
  )
  const exported = findLedgerPublicAccount(credential, {
    family,
    accountIndex,
    derivationPath: chainAccounts[0].derivation.path
  })
  if (
    !exported ||
    chainAccounts[0].identity.kind !== 'account-identifier' ||
    chainAccounts[0].identity.value !== exported.address
  )
    throw new Error('Ledger public account does not match authenticated credential')
  return Object.freeze({
    accountId: accounts[0].id,
    path: exported.derivationPath,
    publicKey: exported.publicKey,
    address: exported.address
  })
}
export async function readLedgerProvisioningCredential(walletId: unknown) {
  if (typeof walletId !== 'string' || !(await credentialSession.hasUnlockSession()))
    throw new Error('Unlock the wallet before adding Ledger accounts')
  const storage = new IndexedDbStorageV2Repository()
  const pointer = await storage.getActivePointer()
  const snapshot = pointer ? await storage.getSnapshot(pointer.generationId) : null
  if (
    !snapshot ||
    snapshot.manifest.status !== 'verified' ||
    snapshot.manifest.sourceFingerprint !== pointer?.sourceFingerprint
  )
    throw new Error('Ledger Wallet storage unavailable')
  return readActiveLedgerHardwareCredential(
    new IndexedDbCredentialRepository(),
    snapshot,
    parseKeyDomainId(walletId),
    await credentialSession.getProvisioningPassword()
  )
}
export const solanaLedgerSigningBridge = Object.freeze({
  resolveAccount: resolveLedgerSigningAccount,
  requestSignature: (
    request: import('@/lib/ledger/solana').LedgerSolanaSigningRequest,
    binding: import('@/infrastructure/keyring/multichain/ledger-signing-bridge').LedgerSigningBinding
  ) => requestLedgerSignature(request, binding)
})
export const nearLedgerSigningBridge = Object.freeze({
  resolveAccount: resolveLedgerSigningAccount,
  requestSignature: (
    request: import('@/lib/ledger/near').LedgerNearSigningRequest,
    binding: import('@/infrastructure/keyring/multichain/ledger-signing-bridge').LedgerSigningBinding
  ) => requestLedgerSignature(request, binding)
})
