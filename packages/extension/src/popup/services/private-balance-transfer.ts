import { parseDisplayUnitAmount } from '@/lib/number-format'
import { supportsEvmPrivateExecution } from '@/core/chains/evm'
import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import type { AccountNetworksView } from './account-networks-client'
import { getAssetDomainRaw, type AssetDomain } from './asset-domains'

export type PrivateBalanceTransferDirection = 'main-to-private' | 'private-to-main'

export type TransferDomain = Exclude<AssetDomain, 'all'>

export function getTransferDomainBalanceRaw(
  asset: PortfolioAssetView,
  domain: TransferDomain
): string | null {
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
}): string | null {
  const funded = (item: (typeof input.assets)[number]) => {
    const raw = getTransferDomainBalanceRaw(item.asset, input.from)
    return raw !== null && BigInt(raw) > 0n
  }
  const eligible = input.assets.filter(
    item =>
      item.chain.chain.family === 'evm' && input.eligibleChainIds.includes(item.chain.chain.id)
  )
  return (eligible.find(funded) ?? eligible[0])?.asset.asset.id ?? null
}

export function resolvePrivateBalanceTransferSource(input: {
  readonly direction: PrivateBalanceTransferDirection
  readonly mainBalanceRaw: string
  readonly privateBalanceRaw: string
  readonly mainAddress: string
  readonly privateAddress: string
}) {
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
        sourceLabel: 'Confidential' as const
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
  readonly sourceLabel: 'Public' | 'Private' | 'Shield' | 'Confidential'
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
