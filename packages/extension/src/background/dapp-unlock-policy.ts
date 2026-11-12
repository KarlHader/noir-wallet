import type { DAppRuntimeRequestMessage } from '@/lib/runtime-message-security'

export function isExplicitMultichainConnectRequest(message: DAppRuntimeRequestMessage): boolean {
  switch (message.chainId) {
    case 'evm':
      return (
        message.request.method === 'eth_requestAccounts' ||
        message.request.method === 'wallet_requestPermissions'
      )
    case 'bitcoin':
    case 'dash':
    case 'pearl':
    case 'quantus':
    case 'solana':
    case 'near':
      return message.request.method === 'connect' || message.request.method === 'requestAccounts'
    case 'starknet':
      return (
        message.request.method === 'wallet_requestAccounts' && !isSilentStarknetAccountRead(message)
      )
    case 'zcash':
      return false
    case 'multichain':
      return message.request.method === 'wallet_createSession'
  }
}

export function isSilentStarknetAccountRead(message: DAppRuntimeRequestMessage): boolean {
  if (message.chainId !== 'starknet' || message.request.method !== 'wallet_requestAccounts') {
    return false
  }
  const params = message.request.params
  return (
    Boolean(params) &&
    !Array.isArray(params) &&
    (params as Record<string, unknown>).silent_mode === true
  )
}
