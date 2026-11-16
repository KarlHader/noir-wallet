import { INVITE_API_BASE_URL } from '@/config/beta-invite'
import { BetaInviteError } from '@/core/wallet/beta-invite'
import { FetchTimeoutError, fetchWithTimeout } from '@/lib/fetch-utils'

type InviteFetch = typeof fetchWithTimeout

type InviteResponse =
  | { readonly kind: 'success'; readonly data: Record<string, unknown> }
  | { readonly kind: 'wallet-already-bound' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function requestInvite(
  code: string,
  action: 'check' | 'bind',
  fetchImpl: InviteFetch,
  address?: string
): Promise<InviteResponse> {
  try {
    const response = await fetchImpl(
      `${INVITE_API_BASE_URL}/${encodeURIComponent(code)}/${action}`,
      {
        method: action === 'bind' ? 'POST' : 'GET',
        ...(action === 'bind'
          ? {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ wallet_address: address })
            }
          : {}),
        timeoutMs: 10_000
      }
    )
    if (!response.ok) throw new BetaInviteError('service-unavailable')
    const payload: unknown = await response.json()
    if (!isRecord(payload)) throw new BetaInviteError('service-unavailable')
    if (payload.code === 4004) throw new BetaInviteError('invalid-code')
    if (payload.code === 2004) {
      const message =
        typeof payload.message === 'string' ? payload.message.trim().toLowerCase() : ''
      // The service shares this code between invite-code and wallet-address conflicts.
      if (action === 'bind' && message === 'wallet address has already been bound') {
        return { kind: 'wallet-already-bound' }
      }
      if (message === 'invite code has already been bound') {
        throw new BetaInviteError('used-code')
      }
      throw new BetaInviteError(action === 'bind' ? 'binding-failed' : 'service-unavailable')
    }
    if (payload.code !== 0 || !isRecord(payload.data)) {
      throw new BetaInviteError(action === 'bind' ? 'binding-failed' : 'service-unavailable')
    }
    return { kind: 'success', data: payload.data }
  } catch (error) {
    if (error instanceof BetaInviteError) throw error
    if (error instanceof FetchTimeoutError) throw new BetaInviteError('timeout')
    throw new BetaInviteError('service-unavailable')
  }
}

export async function checkBetaInviteCode(
  code: string,
  fetchImpl: InviteFetch = fetchWithTimeout
): Promise<void> {
  const result = await requestInvite(code, 'check', fetchImpl)
  if (result.kind !== 'success') throw new BetaInviteError('service-unavailable')
  const { data } = result
  if (data.exists !== true || typeof data.bound !== 'boolean') {
    throw new BetaInviteError(data.exists === false ? 'invalid-code' : 'service-unavailable')
  }
  if (data.bound) throw new BetaInviteError('used-code')
}

export async function bindBetaInviteCode(
  code: string,
  walletAddress: string,
  fetchImpl: InviteFetch = fetchWithTimeout
): Promise<void> {
  const result = await requestInvite(code, 'bind', fetchImpl, walletAddress)
  // This confirmation applies to the background-selected address in this request.
  if (result.kind === 'wallet-already-bound') return
  const { data } = result
  if (data.code !== code || data.bound !== true) {
    throw new BetaInviteError('binding-failed')
  }
}
