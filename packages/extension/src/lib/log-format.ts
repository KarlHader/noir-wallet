export function formatWalletLogPrefix(walletLabel: string, accountId?: string): string {
  return accountId ? `[${walletLabel}:${accountId.slice(-4)}]` : `[${walletLabel}]`
}

export function formatLogError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error'
}
