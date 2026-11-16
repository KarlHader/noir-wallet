import {
  parseBetaInviteActivationState,
  type BetaInviteActivationState
} from '@/core/wallet/beta-invite'

export interface BetaInviteActivationStatus {
  required: boolean
  state: BetaInviteActivationState
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function request(type: string, inviteCode?: string): Promise<BetaInviteActivationStatus> {
  const response = (await chrome.runtime.sendMessage(
    inviteCode === undefined ? { type } : { type, inviteCode }
  )) as unknown
  if (isRecord(response) && typeof response.error === 'string') {
    throw new Error(response.error)
  }
  if (!isRecord(response) || !isRecord(response.result)) {
    throw new Error('Invite service is unavailable. Try again.')
  }
  const result = response.result
  if (result.required !== true) {
    throw new Error('Invite service is unavailable. Try again.')
  }
  return { required: true, state: parseBetaInviteActivationState(result.state) }
}

export const betaInviteClient = {
  getStatus: () => request('GET_BETA_INVITE_ACTIVATION'),
  check: (inviteCode: string) => request('CHECK_BETA_INVITE_CODE', inviteCode),
  bind: () => request('BIND_BETA_INVITE_WALLET')
}
