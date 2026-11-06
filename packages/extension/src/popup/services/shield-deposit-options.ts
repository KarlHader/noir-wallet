import { getActiveChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import { resolveEvmNetworkCatalog } from '@/core/chains/evm-runtime-config'
import {
  createBuildAddressGatedChainRegistry,
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions,
  getZcashChainId,
  type ChainDefinition
} from '@/core/chains/registry'
import { getAssetProtocolSourceMappings } from '@/core/prices/asset-market-mappings'
import { resolveIntentsEvmChainId } from '@/core/services/intents-evm-assets'
import type { SwapToken } from '@/core/services/intents-api'
import { resolveManagedIntentsCatalogAsset } from './intents-asset-manager-client'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { parseZcashAddress } from '@/core/address-book/address-book'
import { formatBaseUnitDecimalAmount, parseDisplayUnitAmount } from '@/lib/number-format'
import { isAddress, zeroAddress } from 'viem'
import type { AccountNetworkView } from './account-networks-client'
import type { ExternalShieldDeposit } from './confidential-funding-client'
import { hasExternalShieldDepositFunding } from '@/core/services/confidential-funding/confidential-external-deposit'

const bundledAssetMappings = getAssetProtocolSourceMappings(
  'mainnet',
  createAssetRegistry(
    createInitialProductChainRegistry('mainnet'),
    getBundledInitialProductAssetDefinitions('mainnet')
  )
)

export function depositSourceAssetId(token: SwapToken, network: ChainDefinition): string | null {
  if (depositTokenChainId(token) !== network.id) return null
  const bundled = bundledAssetMappings.find(
    mapping =>
      mapping.protocolAssetId === token.assetId && mapping.assetId.startsWith(`${network.id}/`)
  )
  if (bundled) return bundled.assetId
  const managed = resolveManagedIntentsCatalogAsset([token], token.assetId)
  return managed?.chainId === network.id ? managed.assetId : null
}

export function depositTokenChainId(token: SwapToken): string | null {
  const blockchain = token.blockchain.trim().toLowerCase()
  if (blockchain === 'zec' || blockchain === 'zcash') return getZcashChainId('mainnet')
  return resolveIntentsEvmChainId(
    blockchain,
    resolveEvmNetworkCatalog('mainnet', getActiveChainEndpointSettings())
  )
}

export function depositSourceNetworks(): readonly ChainDefinition[] {
  if (DEFAULT_NETWORK !== 'mainnet') return []
  const custom = resolveEvmNetworkCatalog('mainnet', getActiveChainEndpointSettings()).filter(
    network => network.source === 'custom'
  )
  return createBuildAddressGatedChainRegistry(createInitialProductChainRegistry('mainnet', custom))
    .list()
    .filter(chain => chain.family === 'evm' || chain.family === 'zcash')
}

export function availableDepositTokens(
  tokens: readonly SwapToken[],
  networks: readonly ChainDefinition[]
): readonly SwapToken[] {
  return tokens.filter(token => {
    const chainId = depositTokenChainId(token)
    const network = networks.find(candidate => candidate.id === chainId)
    return network !== undefined && depositSourceAssetId(token, network) !== null
  })
}

export function defaultDepositRefundAddress(
  network: ChainDefinition | null,
  accountNetworks: readonly AccountNetworkView[]
): string {
  const accountNetwork = accountNetworks.find(item => item.chain.id === network?.id)
  return accountNetwork?.addresses.find(address => address.privacy === 'transparent')?.value ?? ''
}

export function depositRefundAddressError(
  address: string,
  network: ChainDefinition | null
): string | null {
  if (!network) return 'Select a network'
  const value = address.trim()
  if (!value) return 'Enter a refund address'
  if (network.family === 'evm') {
    return isAddress(value) && value.toLowerCase() !== zeroAddress
      ? null
      : 'Enter a valid EVM address'
  }
  if (network.family === 'zcash') {
    try {
      return parseZcashAddress(value, DEFAULT_NETWORK).scheme.startsWith('zcash-transparent-')
        ? null
        : 'Enter a transparent Zcash address'
    } catch {
      return 'Enter a valid transparent Zcash address'
    }
  }
  return 'Select a supported network'
}

export function depositAmountRaw(amount: string, token: SwapToken | null): string | null {
  if (!token) return null
  try {
    const raw = parseDisplayUnitAmount(amount.trim(), token.decimals)
    return BigInt(raw) > 0n ? raw : null
  } catch {
    return null
  }
}

export function depositAmountError(amount: string, token: SwapToken | null): string | null {
  if (!token) return 'Select a token'
  if (!amount.trim()) return 'Enter an amount'
  return depositAmountRaw(amount, token) === null ? 'Enter a valid amount' : null
}

export function formatDepositAmount(raw: string, decimals: number | undefined): string | null {
  if (decimals === undefined) return null
  try {
    return formatBaseUnitDecimalAmount(raw, decimals)
  } catch {
    return null
  }
}

export function depositStatusLabel(record: ExternalShieldDeposit, now: number): string {
  if (record.phase === 'awaiting-payment' && depositRemainingRaw(record) === '0') {
    return 'Awaiting confirmation'
  }
  if (
    record.phase === 'awaiting-payment' &&
    (record.providerStatus === 'INCOMPLETE_DEPOSIT' ||
      BigInt(record.depositedAmountRaw ?? '0') > 0n)
  ) {
    return 'Partial deposit'
  }
  if (record.phase === 'awaiting-payment' && hasExternalShieldDepositFunding(record)) {
    return 'Deposit detected'
  }
  if (record.phase === 'awaiting-payment' && now >= record.expiresAt) return 'Quote expired'
  switch (record.phase) {
    case 'awaiting-payment':
      return 'Awaiting deposit'
    case 'processing':
      return 'Processing'
    case 'ready':
      return 'Received'
    case 'refunded':
      return 'Refunded'
    case 'failed':
      return 'Failed'
  }
}

export function depositRemainingRaw(record: ExternalShieldDeposit): string {
  const remaining = BigInt(record.amountRaw) - BigInt(record.depositedAmountRaw ?? '0')
  return remaining > 0n ? remaining.toString() : '0'
}

export function depositPaymentProgress(
  record: ExternalShieldDeposit,
  now: number
): Readonly<{
  canPay: boolean
  hasDeposit: boolean
  remainingRaw: string
  paymentAmountRaw: string
}> {
  const hasDeposit = BigInt(record.depositedAmountRaw ?? '0') > 0n
  const remainingRaw = depositRemainingRaw(record)
  const amountUnknown = record.providerStatus === 'INCOMPLETE_DEPOSIT' && !hasDeposit
  const canPay =
    record.phase === 'awaiting-payment' &&
    now < record.expiresAt &&
    remainingRaw !== '0' &&
    !amountUnknown
  return Object.freeze({
    canPay,
    hasDeposit,
    remainingRaw,
    paymentAmountRaw: canPay && hasDeposit ? remainingRaw : record.amountRaw
  })
}

export function canPayShieldDeposit(record: ExternalShieldDeposit, now: number): boolean {
  return depositPaymentProgress(record, now).canPay
}
