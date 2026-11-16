import type { LedgerChainFamily } from '@/core/wallet/hardware-wallet-data'
import type { Network } from '@/types'
import { ledgerBitcoinAppName } from '@/lib/ledger/bitcoin-model'

export function ledgerAppName(family: LedgerChainFamily, network: Network): string {
  switch (family) {
    case 'evm':
      return 'Ethereum'
    case 'zcash':
      return 'Zcash Shielded'
    case 'bitcoin':
      return ledgerBitcoinAppName(network)
    case 'solana':
      return 'Solana'
    case 'near':
      return 'NEAR'
  }
}

export interface LedgerDeviceStatus {
  readonly message: string
  readonly awaitingDevice: boolean
}

export function ledgerDeviceStatus(app: string, interaction?: string): LedgerDeviceStatus {
  switch (interaction) {
    case undefined:
      return { message: `Connecting to the ${app} app…`, awaitingDevice: false }
    case 'none':
      return { message: 'Reading accounts…', awaitingDevice: false }
    case 'unlock-device':
      return { message: 'Unlock your Ledger', awaitingDevice: true }
    case 'confirm-open-app':
      return { message: `Confirm opening the ${app} app on your Ledger`, awaitingDevice: true }
    case 'verify-address':
    case 'verify-safe-address':
      return { message: 'Confirm the address on your Ledger', awaitingDevice: true }
    case 'allow-secure-connection':
    case 'grant-consent':
      return { message: 'Allow access on your Ledger', awaitingDevice: true }
    case 'register-wallet':
      return { message: 'Confirm the wallet on your Ledger', awaitingDevice: true }
    default:
      return { message: 'Check your Ledger', awaitingDevice: true }
  }
}
