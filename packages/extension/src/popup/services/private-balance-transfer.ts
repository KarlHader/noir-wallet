import { parseDisplayUnitAmount } from '@/lib/number-format'
import { supportsEvmPrivateExecution } from '@/core/chains/evm'
import { parseNearAccountId } from '@/core/chains/near/identifiers'
import { parseAssetId } from '@/core/chains/registry'
import { getPrivateCrossChainTransferAssetGroup } from '@/core/chains/cross-chain-asset-group'
import {
  getNearMoveChainIds,
  nearDirectQuoteAsset,
  readNearMoveDomainRaw,
  selectBalanceTransferMethod
} from '@/core/chains/near/near-incognito-move'
import {
  NEAR_MAINNET_CHAIN_ID,
  NEAR_MAINNET_NATIVE_ASSET_ID
} from '@/core/chains/near/near-portfolio-assets'
import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import type { AccountNetworksView } from './account-networks-client'
import { getAssetDomainRaw, type AssetDomain } from './asset-domains'
import { buildAddToPrivateEvmPath } from './evm-send-validation'

export { getNearMoveChainIds, selectBalanceTransferMethod }

export type PrivateBalanceTransferDirection = 'main-to-private' | 'private-to-main'

export type TransferDomain = Exclude<AssetDomain, 'all'>

export function buildPrivateDepositReviewPath(input: {
  readonly sourceAssetId: string
  readonly destinationAssetId: string
  readonly amount: string
  readonly maximum: boolean
}): string {
  const source = parseAssetId(input.sourceAssetId)
  const destination = parseAssetId(input.destinationAssetId)
  if (!source.chainId.startsWith('eip155:')) throw new Error('Invalid EVM source asset route')
  const path = buildAddToPrivateEvmPath({
    assetId: destination.id,
    chainId: destination.chainId,
    amount: input.amount,
    maximum: input.maximum
  })
  const query = new URLSearchParams(path.slice(path.indexOf('?') + 1))
  query.set('source', source.id)
  return `/swap?${query}`
}

export function buildNearPrivateDepositReviewPath(input: {
  readonly sourceAssetId: string
  readonly destinationAssetId: string
  readonly amount: string
  readonly maximum: boolean
}): string {
  const source = parseAssetId(input.sourceAssetId)
  const destination = parseAssetId(input.destinationAssetId)
  const quoteAsset = (asset: ReturnType<typeof parseAssetId>) =>
    nearDirectQuoteAsset({
      id: asset.id,
      chainId: asset.chainId,
      kind: asset.id === NEAR_MAINNET_NATIVE_ASSET_ID ? 'native' : 'token',
      reference: asset.reference
    })
  if (
    source.chainId !== NEAR_MAINNET_CHAIN_ID ||
    destination.chainId !== NEAR_MAINNET_CHAIN_ID ||
    !quoteAsset(source) ||
    !quoteAsset(destination)
  ) {
    throw new Error('Invalid NEAR source asset route')
  }
  if (!/^\d+(?:\.\d+)?$/.test(input.amount)) throw new Error('Invalid NEAR transfer amount route')
  const query = new URLSearchParams({
    privateDestination: '1',
    balanceTransfer: '1',
    destinationChain: 'near',
    destinationAsset: destination.id,
    source: source.id,
    amount: input.amount,
    review: '1'
  })
  if (input.maximum) query.set('maximum', '1')
  return `/swap?${query}`
}

const NEAR_IMPLICIT_ACCOUNT = /^[0-9a-f]{64}$/

function canonicalNearRouteAccount(value: string): string | null {
  try {
    const accountId = parseNearAccountId(value)
    return accountId === value ? accountId : null
  } catch {
    return null
  }
}

function nearDirectRouteAsset(assetId: string) {
  const asset = parseAssetId(assetId)
  if (asset.chainId !== NEAR_MAINNET_CHAIN_ID) return null
  const quote = nearDirectQuoteAsset({
    id: asset.id,
    chainId: asset.chainId,
    kind: asset.id === NEAR_MAINNET_NATIVE_ASSET_ID ? 'native' : 'token',
    reference: asset.reference
  })
  return quote ? asset : null
}

export function buildNearPrivateWithdrawReviewPath(input: {
  readonly sourceAssetId: string
  readonly destinationAssetId: string
  readonly recipient: string
  readonly peaAccountId: string
  readonly amount: string
  readonly maximum: boolean
}): string {
  const source = nearDirectRouteAsset(input.sourceAssetId)
  const destination = nearDirectRouteAsset(input.destinationAssetId)
  if (!source || !destination || source.id !== destination.id) {
    throw new Error('Invalid NEAR source asset route')
  }
  const recipient = canonicalNearRouteAccount(input.recipient)
  const peaAccountId = canonicalNearRouteAccount(input.peaAccountId)
  if (
    !recipient ||
    !peaAccountId ||
    !NEAR_IMPLICIT_ACCOUNT.test(peaAccountId) ||
    recipient === peaAccountId
  ) {
    throw new Error('Invalid NEAR recipient route')
  }
  if (!/^\d+(?:\.\d+)?$/.test(input.amount)) throw new Error('Invalid NEAR transfer amount route')
  const query = new URLSearchParams({
    privateTransfer: '1',
    balanceTransfer: '1',
    destinationChain: 'near',
    destinationAsset: destination.id,
    source: source.id,
    recipient,
    amount: input.amount,
    review: '1'
  })
  if (input.maximum) query.set('maximum', '1')
  return `/swap?${query}`
}

export function buildCrossChainPrivateWithdrawReviewPath(input: {
  readonly sourceAssetId: string
  readonly destinationAssetId: string
  readonly walletId: string
  readonly accountId: string
  readonly amount: string
  readonly maximum: boolean
}): string {
  const query = new URLSearchParams({
    privateTransfer: '1',
    balanceTransfer: '1',
    crossChainWithdraw: '1',
    source: input.sourceAssetId,
    destination: input.destinationAssetId,
    sourceWalletId: input.walletId,
    sourceAccountId: input.accountId,
    amount: input.amount,
    review: '1'
  })
  if (input.maximum) query.set('maximum', '1')
  return `/swap?${query}`
}

export function resolveCrossChainPrivateWithdrawRoute(
  query: URLSearchParams,
  account: AccountNetworksView | null,
  mainnet: boolean
) {
  if (
    !mainnet ||
    !account ||
    !supportsEvmPrivateExecution(account.walletSource) ||
    query.get('crossChainWithdraw') !== '1' ||
    query.get('privateTransfer') !== '1' ||
    query.get('balanceTransfer') !== '1' ||
    query.has('privateDestination') ||
    query.has('publicPrivacySend') ||
    query.has('recipient') ||
    query.get('sourceWalletId') !== account.walletId ||
    query.get('sourceAccountId') !== account.accountId
  )
    return null
  try {
    const source = parseAssetId(query.get('source') ?? '')
    const destination = parseAssetId(query.get('destination') ?? '')
    const sourceNetwork = account.networks.find(network => network.chain.id === source.chainId)
    const destinationNetwork = account.networks.find(
      network => network.chain.id === destination.chainId
    )
    const recipient = destinationNetwork?.addresses.find(
      address => address.preferredForReceive
    )?.value
    const group = getPrivateCrossChainTransferAssetGroup(source)
    if (
      source.chainId === destination.chainId ||
      sourceNetwork?.chain.family !== 'evm' ||
      !sourceNetwork.privateExecutionAddress ||
      destinationNetwork?.chain.family !== 'evm' ||
      !recipient ||
      !/^0x[0-9a-f]{40}$/i.test(recipient) ||
      /^0x0{40}$/i.test(recipient) ||
      recipient.toLowerCase() === destinationNetwork.privateExecutionAddress?.toLowerCase() ||
      !group ||
      source.namespace !== destination.namespace ||
      group !== getPrivateCrossChainTransferAssetGroup(destination)
    )
      return null
    return {
      destinationAssetId: destination.id,
      destinationApiChainId: destination.chainId.slice('eip155:'.length),
      recipient
    }
  } catch {
    return null
  }
}

export function balanceTransferDomainLabel(domain: TransferDomain) {
  return domain === 'shield' ? 'Shield' : domain === 'private' ? 'Incognito' : 'Public'
}

export function resolveBalanceTransferIntent(value: string | null | undefined) {
  return value === 'deposit' || value === 'withdraw' ? value : null
}

export type BalanceTransferIntent = NonNullable<ReturnType<typeof resolveBalanceTransferIntent>>

export function balanceTransferLabel(intent: BalanceTransferIntent): 'Deposit' | 'Withdraw' {
  return intent === 'deposit' ? 'Deposit' : 'Withdraw'
}

export function fixedTransferSide(intent: BalanceTransferIntent | null): 'to' | 'from' | null {
  return intent === 'deposit' ? 'to' : intent === 'withdraw' ? 'from' : null
}

export function getTransferDomainBalanceRaw(
  asset: PortfolioAssetView,
  domain: TransferDomain
): string | null {
  if (asset.asset.chainId.startsWith('near:')) {
    return readNearMoveDomainRaw(asset.balance, domain)
  }
  if (
    domain === 'shield' &&
    asset.asset.chainId.startsWith('eip155:') &&
    asset.balance.confidentialRaw === undefined
  ) {
    return null
  }
  return getAssetDomainRaw(asset, domain)
}

function parseTransferDomain(value: string | null | undefined): TransferDomain | null {
  return value === 'public' || value === 'private' || value === 'shield' ? value : null
}

export function resolveTransferDomains(input: {
  readonly mode: 'public' | 'private'
  readonly from?: string | null
  readonly to?: string | null
}): Readonly<{ from: TransferDomain; to: TransferDomain }> {
  const defaultFrom = input.mode === 'public' ? 'private' : 'public'
  const defaultTo = input.mode === 'private' ? 'private' : 'public'
  const requestedFrom = parseTransferDomain(input.from)
  const requestedTo = parseTransferDomain(input.to)
  let from = requestedFrom ?? defaultFrom
  let to = requestedTo ?? defaultTo
  if (from === to) {
    if (!requestedFrom) from = to === 'public' ? 'private' : 'public'
    else to = from === 'public' ? 'private' : 'public'
  }
  return Object.freeze({ from, to })
}

export function getPrivateTransferChainIds(
  account: AccountNetworksView | null,
  mainnet: boolean
): readonly string[] {
  if (!mainnet || !supportsEvmPrivateExecution(account?.walletSource)) return []
  return (
    account?.networks.flatMap(network =>
      network.chain.family === 'evm' &&
      network.privateExecutionAddress &&
      network.addresses.some(address => address.preferredForReceive)
        ? [network.chain.id]
        : []
    ) ?? []
  )
}

export function selectDefaultTransferAssetId(input: {
  readonly assets: readonly {
    readonly asset: PortfolioAssetView
    readonly chain: PortfolioChainView
  }[]
  readonly from: TransferDomain
  readonly to: TransferDomain
  readonly eligibleChainIds: readonly string[]
  readonly nearChainIds?: readonly string[]
}): string | null {
  const funded = (item: (typeof input.assets)[number]) => {
    const raw = getTransferDomainBalanceRaw(item.asset, input.from)
    return raw !== null && BigInt(raw) > 0n
  }
  const nearChainIds = input.nearChainIds ?? []
  const eligible = input.assets.filter(item => {
    if (item.chain.chain.family === 'evm') {
      return input.eligibleChainIds.includes(item.chain.chain.id)
    }
    if (item.chain.chain.family === 'near') return nearChainIds.includes(item.chain.chain.id)
    return false
  })
  return (eligible.find(funded) ?? eligible[0])?.asset.asset.id ?? null
}

export function resolvePrivateBalanceTransferSource(input: {
  readonly direction: PrivateBalanceTransferDirection
  readonly mainBalanceRaw: string
  readonly privateBalanceRaw: string
  readonly mainAddress: string
  readonly privateAddress: string
}): Readonly<{
  availableRaw: string
  sender: string
  recipient: string
  executionMode: 'main' | 'private'
  sourceLabel: 'Public' | 'Incognito'
}> {
  return input.direction === 'main-to-private'
    ? {
        availableRaw: input.mainBalanceRaw,
        sender: input.mainAddress,
        recipient: input.privateAddress,
        executionMode: 'main' as const,
        sourceLabel: 'Public' as const
      }
    : {
        availableRaw: input.privateBalanceRaw,
        sender: input.privateAddress,
        recipient: input.mainAddress,
        executionMode: 'private' as const,
        sourceLabel: 'Incognito' as const
      }
}

export interface PrivateBalanceTransferAmountState {
  readonly amountRaw: string | null
  readonly error: string | null
}

export function resolvePrivateBalanceTransferAmount(input: {
  readonly amount: string
  readonly decimals: number
  readonly availableRaw: string
  readonly sourceLabel: ReturnType<typeof balanceTransferDomainLabel>
}): PrivateBalanceTransferAmountState {
  if (input.amount.length === 0 || input.amount === '.')
    return Object.freeze({ amountRaw: null, error: null })
  try {
    const amountRaw = parseDisplayUnitAmount(input.amount, input.decimals)
    if (BigInt(amountRaw) === 0n) {
      return Object.freeze({ amountRaw: null, error: null })
    }
    if (BigInt(amountRaw) > BigInt(input.availableRaw)) {
      return Object.freeze({
        amountRaw: null,
        error: `Amount exceeds the ${input.sourceLabel} balance`
      })
    }
    return Object.freeze({ amountRaw, error: null })
  } catch {
    return Object.freeze({ amountRaw: null, error: 'Enter a valid amount' })
  }
}

export function normalizePrivateBalanceTransferInput(value: string): string | null {
  if (value.length > 128 || !/^\d*(?:\.\d*)?$/.test(value)) return null
  return value
}
