export const BETA_INVITE_ACTIVATION_STORAGE_KEY = 'beta_invite_activation_v1'
export const INVITE_API_BASE_URL = 'https://api.zknoir.com/v1/invite-codes'

export function resolveBetaInviteRequired(
  buildChannel: string,
  devOptIn: string | undefined
): boolean {
  return buildChannel === 'beta' || (buildChannel === 'development' && devOptIn === '1')
}
