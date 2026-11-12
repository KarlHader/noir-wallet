type DAppFamily =
  | 'zcash'
  | 'evm'
  | 'bitcoin'
  | 'dash'
  | 'pearl'
  | 'quantus'
  | 'solana'
  | 'near'
  | 'starknet'
  | 'multichain'

export const BETA_INVITE_REQUIRED_MESSAGE = 'Activate Noir Wallet Beta before using this wallet.'

export type UnactivatedBetaDAppDecision =
  | { readonly kind: 'silent'; readonly result: null | readonly never[] }
  | { readonly kind: 'activate' }
  | { readonly kind: 'reject' }

/** Keep saved connections from exposing accounts before this installation is activated. */
export function resolveUnactivatedBetaDAppRequest(
  family: DAppFamily,
  method: string
): UnactivatedBetaDAppDecision {
  if (
    (family === 'zcash' && method === 'zcash_getAccounts') ||
    (family === 'multichain' && method === 'wallet_getSession')
  ) {
    return { kind: 'silent', result: null }
  }
  if (
    (family === 'evm' && method === 'eth_accounts') ||
    (family === 'starknet' && method === 'wallet_getPermissions') ||
    ((family === 'bitcoin' ||
      family === 'dash' ||
      family === 'pearl' ||
      family === 'quantus' ||
      family === 'solana' ||
      family === 'near') &&
      method === 'getAccounts')
  ) {
    return { kind: 'silent', result: [] }
  }
  const connects =
    family === 'zcash'
      ? method === 'zcash_requestAccounts'
      : family === 'evm'
        ? method === 'eth_requestAccounts' || method === 'wallet_requestPermissions'
        : family === 'multichain'
          ? method === 'wallet_createSession'
          : family === 'starknet'
            ? method === 'wallet_requestAccounts'
            : method === 'connect' || method === 'requestAccounts'
  return { kind: connects ? 'activate' : 'reject' }
}
