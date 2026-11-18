import type {
  NoirPublicAccount,
  NoirPublicAssets
} from '@/core/services/noir-protocol/public/types'

function responseError(value: unknown, fallback: string): Error {
  if (value && typeof value === 'object' && 'error' in value && typeof value.error === 'string') {
    return new Error(value.error)
  }
  return new Error(fallback)
}

export const noirPublicWalletClient = {
  async getAccount(): Promise<NoirPublicAccount | null> {
    const response: unknown = await chrome.runtime.sendMessage({ type: 'PUBLIC_GET_ACCOUNT' })
    if (!response || typeof response !== 'object' || !('success' in response)) {
      throw responseError(response, 'Unable to load Public account')
    }
    if (response.success !== true) throw responseError(response, 'Unable to load Public account')
    if (!('account' in response) || response.account === null) return null
    return response.account as NoirPublicAccount
  },

  async getAssets(refresh = true): Promise<NoirPublicAssets> {
    const response: unknown = await chrome.runtime.sendMessage({
      type: 'PUBLIC_GET_ASSETS',
      refresh
    })
    if (!response || typeof response !== 'object' || !('success' in response)) {
      throw responseError(response, 'Unable to load Public assets')
    }
    if (response.success !== true || !('result' in response) || !response.result) {
      throw responseError(response, 'Unable to load Public assets')
    }
    return response.result as NoirPublicAssets
  },

  async activate(): Promise<NoirPublicAccount> {
    const response: unknown = await chrome.runtime.sendMessage({ type: 'PUBLIC_ACTIVATE_ACCOUNT' })
    if (
      !response ||
      typeof response !== 'object' ||
      response === null ||
      !('success' in response)
    ) {
      throw responseError(response, 'Unable to activate Public account')
    }
    if (response.success !== true || !('account' in response) || !response.account) {
      throw responseError(response, 'Unable to activate Public account')
    }
    return response.account as NoirPublicAccount
  }
}
