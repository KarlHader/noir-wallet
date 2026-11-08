import {
  normalizePrivateBalanceTransferInput,
  resolveTransferDomains,
  type TransferDomain
} from '@/popup/services/private-balance-transfer'

export interface MoveDraft {
  readonly scope: string
  readonly assetId: string | null
  readonly from: TransferDomain
  readonly to: TransferDomain
  readonly amount: string
  readonly method: 'cluster' | 'directly'
  readonly maxSelected: boolean
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
    !('amount' in draft) ||
    typeof draft.amount !== 'string' ||
    normalizePrivateBalanceTransferInput(draft.amount) !== draft.amount ||
    !('method' in draft) ||
    (draft.method !== 'cluster' && draft.method !== 'directly') ||
    !('maxSelected' in draft) ||
    typeof draft.maxSelected !== 'boolean'
  )
    return null
  return draft as MoveDraft
}

export function initialMoveDraft(input: {
  readonly state: unknown
  readonly scope: string
  readonly mode: 'public' | 'private'
  readonly routeFrom: string | null
  readonly routeTo: string | null
  readonly routeAssetId: string | null
}): MoveDraft {
  const restored = readMoveDraft(input.state, input.scope)
  if (restored) return restored
  const domains = resolveTransferDomains({
    mode: input.mode,
    from: input.routeFrom,
    to: input.routeTo
  })
  return {
    scope: input.scope,
    assetId: input.routeAssetId,
    from: domains.from,
    to: domains.to,
    amount: '',
    method: 'directly',
    maxSelected: false
  }
}
