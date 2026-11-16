import type { ActivityItem } from '@/core/activity'
import { parseChainId } from '@/core/chains/registry'
import type { ActivityAssetMetadata } from '@/popup/services/activity-presentation-catalog'
import { resolveActivityChainId } from './activity-chain'

type ActivityInteractionFamily = 'evm' | 'solana' | 'near' | 'tron' | 'generic'

export interface ActivityInteractionPresentation {
  readonly family: ActivityInteractionFamily
  readonly title: string
  readonly icon: string
  readonly targetLabel: string
  readonly targetAddress?: string
  readonly fallbackNetworkName: string
  readonly fallbackChainIconAlias?: string
}

interface ActivityInteractionAdapter {
  readonly family: ActivityInteractionFamily
  readonly title: string
  readonly icon: string
  readonly targetLabel: string
  readonly fallbackNetworkName: string
  readonly fallbackChainIconAlias?: string
}

const INTERACTION_ADAPTERS: Readonly<Record<string, ActivityInteractionAdapter>> = Object.freeze({
  eip155: Object.freeze({
    family: 'evm',
    title: 'Contract interaction',
    icon: 'lucide:file-code-2',
    targetLabel: 'Contract',
    fallbackNetworkName: 'EVM network',
    fallbackChainIconAlias: 'evm'
  }),
  solana: Object.freeze({
    family: 'solana',
    title: 'Program interaction',
    icon: 'lucide:binary',
    targetLabel: 'Program',
    fallbackNetworkName: 'Solana',
    fallbackChainIconAlias: 'solana'
  }),
  near: Object.freeze({
    family: 'near',
    title: 'Contract action',
    icon: 'lucide:blocks',
    targetLabel: 'Contract',
    fallbackNetworkName: 'NEAR',
    fallbackChainIconAlias: 'near'
  }),
  tron: Object.freeze({
    family: 'tron',
    title: 'Smart contract call',
    icon: 'lucide:file-code-2',
    targetLabel: 'Contract',
    fallbackNetworkName: 'TRON',
    fallbackChainIconAlias: 'tron'
  })
})

const GENERIC_INTERACTION_ADAPTER: ActivityInteractionAdapter = Object.freeze({
  family: 'generic',
  title: 'On-chain interaction',
  icon: 'lucide:braces',
  targetLabel: 'Target',
  fallbackNetworkName: 'Network'
})

function resolveNamespace(chainId: string | undefined): string | undefined {
  if (!chainId) return undefined
  try {
    return parseChainId(chainId).namespace
  } catch {
    return undefined
  }
}

export function getActivityInteractionPresentation(
  item: ActivityItem,
  preferredChainId?: string
): ActivityInteractionPresentation | null {
  if (item.kind !== 'contract-call' && item.kind !== 'approve') return null

  const namespace = resolveNamespace(preferredChainId ?? resolveActivityChainId(item))
  const adapter =
    (namespace ? INTERACTION_ADAPTERS[namespace] : undefined) ?? GENERIC_INTERACTION_ADAPTER

  return {
    family: adapter.family,
    title: item.kind === 'approve' ? 'Approve' : adapter.title,
    icon: item.kind === 'approve' ? 'lucide:badge-check' : adapter.icon,
    targetLabel: item.kind === 'approve' ? 'Token' : adapter.targetLabel,
    targetAddress: item.snapshot?.recipient?.address,
    fallbackNetworkName: adapter.fallbackNetworkName,
    fallbackChainIconAlias: adapter.fallbackChainIconAlias
  }
}

export function getActivityApprovalDetails(
  item: ActivityItem,
  assets: ReadonlyMap<string, ActivityAssetMetadata>
): Readonly<{ tokenSymbol?: string; methodLabel?: string }> | null {
  if (item.kind !== 'approve') return null
  const recipient = item.snapshot?.recipient
  const token =
    recipient?.chainId.startsWith('eip155:') && /^0x[0-9a-fA-F]{40}$/.test(recipient.address)
      ? [...assets.values()].find(
          entry =>
            entry.asset.kind === 'token' &&
            entry.asset.chainId === recipient.chainId &&
            entry.asset.namespace === 'erc20' &&
            entry.asset.reference.toLowerCase() === recipient.address.toLowerCase()
        )
      : undefined
  return {
    ...(token ? { tokenSymbol: token.metadata.symbol } : {}),
    ...(item.snapshot?.evm?.methodSelector === '0x095ea7b3' ? { methodLabel: 'Approve' } : {})
  }
}
