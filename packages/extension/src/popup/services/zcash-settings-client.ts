import { getResponseErrorMessage } from '@/lib/errors'

function responseRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export async function resyncZcashWallet(input: {
  readonly walletId: string
  readonly accountId: string
  readonly birthdayHeight: number
}): Promise<void> {
  const response = responseRecord(
    await chrome.runtime.sendMessage({
      type: 'RESYNC_ZCASH_WALLET',
      walletId: input.walletId,
      accountId: input.accountId,
      birthdayHeight: input.birthdayHeight
    })
  )
  if (response?.success === true) return
  throw new Error(getResponseErrorMessage(response) ?? 'Zcash resync could not be started')
}
