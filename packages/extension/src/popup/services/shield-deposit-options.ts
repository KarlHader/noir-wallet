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
import {
  isDeprecatedIntentsToken,
  resolveIntentsEvmChainId
} from '@/core/services/intents-evm-assets'
import type { SwapToken } from '@/core/services/intents-api'
import { resolveManagedIntentsCatalogAsset } from './intents-asset-manager-client'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { NEAR_CHAIN_FEATURE_FLAG } from '@/config/multichain-feature-flags'
import { readEnabledChainFeatureFlags } from '@/config/enabled-chain-feature-flags'
import {
  NEAR_CONFIDENTIAL_CHAIN_ASSET_ID,
  NEAR_CONFIDENTIAL_PROTOCOL_ASSET_ID
} from '@/background/confidential-near-quote'
import { parseZcashAddress } from '@/core/address-book/address-book'
import { formatBaseUnitDecimalAmount, formatDecimalAmount } from '@/lib/number-format'
import Big from '@/lib/big'
import { isAddress, zeroAddress } from 'viem'
import type { AccountNetworkView } from './account-networks-client'
import type { ExternalShieldDeposit } from './confidential-funding-client'
import {
  hasExternalShieldDepositFunding,
  isExternalShieldDepositExpired
} from '@/core/services/confidential-funding/confidential-external-deposit'

const bundledAssetMappings = getAssetProtocolSourceMappings(
  'mainnet',
  createAssetRegistry(
    createInitialProductChainRegistry('mainnet'),
    getBundledInitialProductAssetDefinitions('mainnet')
  )
)

export function depositSourceAssetId(token: SwapToken, network: ChainDefinition): string | null {
  if (depositTokenChainId(token) !== network.id) return null
  if (
    readEnabledChainFeatureFlags().includes(NEAR_CHAIN_FEATURE_FLAG) &&
    network.id === 'near:mainnet' &&
    token.assetId === NEAR_CONFIDENTIAL_PROTOCOL_ASSET_ID &&
    token.decimals === 24
  ) {
    return NEAR_CONFIDENTIAL_CHAIN_ASSET_ID
  }
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
  if (blockchain === 'near') return DEFAULT_NETWORK === 'mainnet' ? 'near:mainnet' : null
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
    .filter(chain => chain.family === 'evm' || chain.family === 'zcash' || chain.family === 'near')
}

export function availableDepositTokens(
  tokens: readonly SwapToken[],
  networks: readonly ChainDefinition[]
): readonly SwapToken[] {
  return tokens.filter(token => {
    if (isDeprecatedIntentsToken(token)) return false
    const chainId = depositTokenChainId(token)
    const network = networks.find(candidate => candidate.id === chainId)
    return network !== undefined && depositSourceAssetId(token, network) !== null
  })
}

interface DepositTokenChoice {
  readonly id: string
  readonly token: SwapToken
  readonly assetIds: readonly string[]
  readonly distinguish: boolean
}

export function listDepositTokenChoices(
  tokens: readonly SwapToken[]
): readonly DepositTokenChoice[] {
  const groups = new Map<string, SwapToken[]>()
  for (const token of tokens) {
    const symbol = token.symbol.trim().toLowerCase()
    const group = groups.get(symbol)
    if (group) group.push(token)
    else groups.set(symbol, [token])
  }
  return [...groups].flatMap<DepositTokenChoice>(([symbol, group]) => {
    const chainIds = group.map(depositTokenChainId)
    if (new Set(chainIds).size === group.length) {
      return [
        {
          id: `symbol:${symbol}`,
          token: group[0]!,
          assetIds: group.map(token => token.assetId),
          distinguish: false
        }
      ]
    }
    return group.map(token => ({
      id: `asset:${token.assetId}`,
      token,
      assetIds: [token.assetId],
      distinguish: true
    }))
  })
}

export function depositTokenForNetwork(
  tokens: readonly SwapToken[],
  selectionId: string | null,
  network: ChainDefinition | null
): SwapToken | null {
  if (!selectionId || !network) return null
  const matches = tokens.filter(
    token =>
      depositTokenChainId(token) === network.id &&
      (selectionId.startsWith('asset:')
        ? token.assetId === selectionId.slice(6)
        : selectionId.startsWith('symbol:') &&
          token.symbol.trim().toLowerCase() === selectionId.slice(7))
  )
  return matches.length === 1 ? matches[0]! : null
}

export function defaultDepositRefundAddress(
  network: ChainDefinition | null,
  accountNetworks: readonly AccountNetworkView[]
): string {
  if (network?.family === 'near') {
    const evm = accountNetworks.find(item => item.chain.family === 'evm')
    return (
      evm?.addresses.find(address => address.privacy === 'transparent')?.value.toLowerCase() ?? ''
    )
  }
  const accountNetwork = accountNetworks.find(item => item.chain.id === network?.id)
  if (network?.family === 'evm' && accountNetwork?.privateExecutionAddress)
    return accountNetwork.privateExecutionAddress
  return accountNetwork?.addresses.find(address => address.privacy === 'transparent')?.value ?? ''
}

export function depositRefundAddressError(
  address: string,
  network: ChainDefinition | null
): string | null {
  if (!network) return 'Select a network'
  const value = address.trim()
  if (!value) return 'Enter a refund address'
  if (network.family === 'evm' || network.family === 'near') {
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

export function formatDepositAmount(raw: string, decimals: number | undefined): string | null {
  if (decimals === undefined) return null
  try {
    return formatBaseUnitDecimalAmount(raw, decimals)
  } catch {
    return null
  }
}

export function formatMinimumDepositPaymentAmount(
  raw: string,
  decimals: number | undefined
): string | null {
  if (decimals === undefined) return null
  const exact = formatDepositAmount(raw, decimals)
  if (exact === null) return null
  const amount = new Big(exact)
  return formatDecimalAmount(exact, {
    maximumFractionDigits: Math.min(decimals, Math.max(2, 2 - amount.e)),
    roundingMode: Big.roundUp,
    displayMinimum: false
  })
}

export function formatShieldReceiveNetworkMinimum(
  record: ExternalShieldDeposit,
  priceUsd: number | undefined
): string | null {
  const minimumRaw = record.minimumInputRaw ?? record.amountRaw
  const amount = formatDepositAmount(minimumRaw, record.sourceDecimals)
  if (amount === null) return null
  if (priceUsd !== undefined && Number.isFinite(priceUsd) && priceUsd > 0) {
    if (new Big(amount).times(priceUsd).lte(1)) return null
  }
  return formatMinimumDepositPaymentAmount(minimumRaw, record.sourceDecimals)
}

export function hasDepositSettlementShortfall(record: ExternalShieldDeposit): boolean {
  return (
    record.phase === 'ready' &&
    record.settledOutputRaw !== undefined &&
    BigInt(record.settledOutputRaw) < BigInt(record.minimumOutputRaw)
  )
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
  if (record.phase === 'awaiting-payment' && isExternalShieldDepositExpired(record, now))
    return 'Quote expired'
  switch (record.phase) {
    case 'awaiting-payment':
      return 'Awaiting deposit'
    case 'processing':
      return 'Processing'
    case 'ready':
      return hasDepositSettlementShortfall(record) ? 'Received less than minimum' : 'Received'
    case 'refunded':
      return 'Refunded'
    case 'failed':
      return 'Failed'
  }
}

function depositRemainingRaw(record: ExternalShieldDeposit): string {
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
    !isExternalShieldDepositExpired(record, now) &&
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
