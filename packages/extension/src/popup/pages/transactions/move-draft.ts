import {
  normalizePrivateBalanceTransferInput,
  resolveTransferDomains,
  type TransferDomain
} from '@/popup/services/private-balance-transfer'

export interface MoveDraft {
  readonly scope: string
  readonly assetId: string | null
  readonly destinationAssetId?: string | null
  readonly from: TransferDomain
  readonly to: TransferDomain
  readonly amount: string
  readonly method: 'cluster' | 'directly'
  readonly maxSelected: boolean
}

export function readMoveAssetHint(
  state: unknown,
  scope: string,
  assetId: string | null
): { symbol: string; iconUrl: string | undefined } | null {
  if (!state || typeof state !== 'object' || !('moveAssetHint' in state)) return null
  const hint = state.moveAssetHint
  if (
    !hint ||
    typeof hint !== 'object' ||
    !('scope' in hint) ||
    hint.scope !== scope ||
    !('assetId' in hint) ||
    hint.assetId !== assetId ||
    !('symbol' in hint) ||
    typeof hint.symbol !== 'string' ||
    !hint.symbol ||
    ('iconUrl' in hint && hint.iconUrl !== undefined && typeof hint.iconUrl !== 'string')
  )
    return null
  return {
    symbol: hint.symbol,
    iconUrl: 'iconUrl' in hint ? (hint.iconUrl as string | undefined) : undefined
  }
}

export function readMoveDraft(state: unknown, scope: string): MoveDraft | null {
  if (!state || typeof state !== 'object' || !('moveDraft' in state)) return null
  const draft = state.moveDraft
  if (!draft || typeof draft !== 'object' || !('scope' in draft) || draft.scope !== scope)
    return null
  if (
    !('from' in draft) ||
    !('to' in draft) ||
    (draft.from !== 'public' && draft.from !== 'private' && draft.from !== 'shield') ||
    (draft.to !== 'public' && draft.to !== 'private' && draft.to !== 'shield') ||
    draft.from === draft.to ||
    !('assetId' in draft) ||
    (draft.assetId !== null && typeof draft.assetId !== 'string') ||
    ('destinationAssetId' in draft &&
      draft.destinationAssetId !== null &&
      typeof draft.destinationAssetId !== 'string') ||
    !('amount' in draft) ||
    typeof draft.amount !== 'string' ||
    normalizePrivateBalanceTransferInput(draft.amount) !== draft.amount ||
    !('method' in draft) ||
    (draft.method !== 'cluster' && draft.method !== 'directly') ||
    !('maxSelected' in draft) ||
    typeof draft.maxSelected !== 'boolean'
  )
    return null
  return {
    ...(draft as MoveDraft),
    method: draft.from === 'shield' || draft.to === 'shield' ? 'directly' : draft.method
  }
}

export function initialMoveDraft(input: {
  readonly state: unknown
  readonly scope: string
  readonly mode: 'public' | 'private'
  readonly routeFrom: string | null
  readonly routeTo: string | null
  readonly routeAssetId: string | null
  readonly entry?: string | null
}): MoveDraft {
  const restored = readMoveDraft(input.state, input.scope)
  if (restored) return restored
  const domains = resolveTransferDomains({
    mode: input.mode,
    from: input.routeFrom ?? input.mode,
    to: input.routeTo ?? 'shield'
  })
  return {
    scope: input.scope,
    assetId: input.routeAssetId,
    from: domains.from,
    to: domains.to,
    amount: '',
    method: domains.from === 'shield' || domains.to === 'shield' ? 'directly' : 'cluster',
    maxSelected: false
  }
}
