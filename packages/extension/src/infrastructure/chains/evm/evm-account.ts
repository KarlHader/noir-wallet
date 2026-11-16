import type { ChainAccount } from '@/core/accounts/domain'
import type { ChainId } from '@/core/chains/domain'

const MAXIMUM_BIP32_INDEX = 2_147_483_647

export interface EvmAccountBinding {
  readonly address: string
  readonly addressIndex: number
}

export function parseEvmAccountBinding(
  chainAccount: ChainAccount,
  expectedChainId: ChainId
): EvmAccountBinding {
  const path = /^m\/44'\/60'\/(0|[1-9][0-9]*)'\/0\/(0|[1-9][0-9]*)$/.exec(
    chainAccount.derivation.path
  )
  const ledgerLegacyPath = /^m\/44'\/60'\/0'\/(0|[1-9][0-9]*)$/.exec(chainAccount.derivation.path)
  const imported =
    chainAccount.derivation.scheme === 'imported' && chainAccount.derivation.path === 'm'
  const accountIndex = imported ? 0 : path ? Number(path[1]) : ledgerLegacyPath ? 0 : Number.NaN
  const addressIndex = imported
    ? 0
    : path
      ? Number(path[2])
      : ledgerLegacyPath
        ? Number(ledgerLegacyPath[1])
        : Number.NaN
  if (
    chainAccount.scope.chainId !== expectedChainId ||
    (!imported && chainAccount.derivation.scheme !== 'bip44') ||
    !Number.isSafeInteger(accountIndex) ||
    accountIndex < 0 ||
    accountIndex > MAXIMUM_BIP32_INDEX ||
    !Number.isSafeInteger(addressIndex) ||
    addressIndex < 0 ||
    addressIndex > MAXIMUM_BIP32_INDEX ||
    chainAccount.identity.kind !== 'account-identifier' ||
    !/^0x[0-9a-fA-F]{40}$/.test(chainAccount.identity.value)
  ) {
    throw new Error('Invalid EVM ChainAccount')
  }
  return Object.freeze({ address: chainAccount.identity.value, addressIndex })
}
