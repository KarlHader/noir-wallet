import { BITCOIN_ADDRESS_POLICY } from '@/core/chains/bitcoin'
import type { AccountRef } from '@/core/dapp/dapp-manager'
import type { DAppExecutionMode } from '@/core/dapp/dapp-execution-mode'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { type AccountNetworkSummary, type AccountNetworksCoordinator } from './account-networks'
import { getBitcoinAccountPreferences } from './bitcoin-account-preferences'
import { credentialSession } from './credential-session'
import { dappExecutionModeCoordinator } from './dapp-execution-mode'

interface FirstPartySessionAccount {
  readonly reference: AccountRef
  readonly address: string
}

export interface FirstPartyDAppSessionSnapshot {
  readonly identity: string
  readonly activeReference: AccountRef | null
  readonly executionMode: DAppExecutionMode
  readonly accounts: Readonly<Record<string, readonly FirstPartySessionAccount[]>>
}

async function selectAddress(
  network: AccountNetworkSummary,
  reference: AccountRef
): Promise<string | null> {
  if (network.addresses.some(address => address.scheme.startsWith('bitcoin-'))) {
    const addressType = await getBitcoinAccountPreferences().get({
      network: DEFAULT_NETWORK,
      keyDomainId: reference.walletId,
      accountId: reference.accountId
    })
    const scheme = BITCOIN_ADDRESS_POLICY.importDiscovery.find(
      target => target.addressType === addressType
    )?.addressScheme
    return network.addresses.find(address => address.scheme === scheme)?.value ?? null
  }
  if (network.chainId.startsWith('eip155:')) {
    return network.addresses.find(address => address.scheme === 'evm')?.value.toLowerCase() ?? null
  }
  if (network.chainId.startsWith('solana:')) {
    return network.addresses.find(address => address.scheme === 'solana')?.value ?? null
  }
  if (network.chainId.startsWith('near:')) {
    return network.addresses.find(address => address.scheme === 'near')?.value ?? null
  }
  if (network.addresses.some(address => address.scheme.startsWith('zcash-'))) {
    return (
      network.addresses.find(address => address.scheme === 'zcash-shielded-unified')?.value ??
      network.addresses.find(address => address.scheme === 'zcash-full-unified')?.value ??
      network.addresses.find(address => address.scheme === 'zcash-transparent-p2pkh')?.value ??
      null
    )
  }
  return null
}

export async function readFirstPartyDAppSessionSnapshot(
  accountNetworksCoordinator: AccountNetworksCoordinator
): Promise<FirstPartyDAppSessionSnapshot | null> {
  const unlockEpoch = await credentialSession.getUnlockEpoch()
  if (!unlockEpoch) return null

  const catalog = await accountNetworksCoordinator.readCatalog({ deriveMissingAddresses: false })
  if (!catalog) return null

  const active = catalog.accounts.find(account => account.active)
  const activeReference = active
    ? Object.freeze({ walletId: String(active.walletId), accountId: String(active.accountId) })
    : null
  const executionMode: DAppExecutionMode = activeReference
    ? (
        await dappExecutionModeCoordinator.read({
          network: DEFAULT_NETWORK,
          keyDomainId: activeReference.walletId,
          accountId: activeReference.accountId
        })
      ).mode
    : 'main'
  const byChain = new Map<string, FirstPartySessionAccount[]>()
  for (const account of catalog.accounts) {
    const reference = Object.freeze({
      walletId: String(account.walletId),
      accountId: String(account.accountId)
    })
    for (const network of account.networks) {
      const address = await selectAddress(network, reference)
      if (!address) continue
      const accounts = byChain.get(network.chainId) ?? []
      accounts.push(Object.freeze({ reference, address }))
      byChain.set(network.chainId, accounts)
    }
  }

  if ((await credentialSession.getUnlockEpoch()) !== unlockEpoch) return null

  const accounts = Object.freeze(
    Object.fromEntries(
      [...byChain.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([chainId, entries]) => [
          chainId,
          Object.freeze(
            entries.sort(
              (left, right) =>
                left.reference.walletId.localeCompare(right.reference.walletId) ||
                left.reference.accountId.localeCompare(right.reference.accountId)
            )
          )
        ])
    )
  )
  const identityInput = JSON.stringify([
    unlockEpoch,
    catalog.generationId,
    DEFAULT_NETWORK,
    activeReference,
    executionMode,
    [...catalog.accounts]
      .sort(
        (left, right) =>
          String(left.walletId).localeCompare(String(right.walletId)) ||
          String(left.accountId).localeCompare(String(right.accountId))
      )
      .map(account => [
        account.walletId,
        account.accountId,
        [...account.networks]
          .sort((left, right) => left.chainId.localeCompare(right.chainId))
          .map(network => [
            network.chainId,
            [...network.addresses]
              .map(address => [address.scheme, address.value])
              .sort(
                ([leftScheme, leftValue], [rightScheme, rightValue]) =>
                  leftScheme.localeCompare(rightScheme) || leftValue.localeCompare(rightValue)
              )
          ])
      ]),
    accounts
  ])
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identityInput))
  const identity = Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, '0')
  ).join('')
  if ((await credentialSession.getUnlockEpoch()) !== unlockEpoch) return null
  return Object.freeze({ identity, activeReference, executionMode, accounts })
}
