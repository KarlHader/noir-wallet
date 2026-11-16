import type { DAppRuntimeRequestMessage } from '@/lib/runtime-message-security'

export function isExplicitMultichainConnectRequest(message: DAppRuntimeRequestMessage): boolean {
  switch (message.chainId) {
    case 'evm':
      return (
        message.request.method === 'eth_requestAccounts' ||
        message.request.method === 'wallet_requestPermissions'
      )
    case 'bitcoin':
    case 'solana':
    case 'near':
      return message.request.method === 'connect' || message.request.method === 'requestAccounts'
    case 'zcash':
      return false
    case 'multichain':
      return message.request.method === 'wallet_createSession'
  }
}
