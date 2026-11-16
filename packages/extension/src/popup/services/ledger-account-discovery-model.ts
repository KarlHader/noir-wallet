import type {
  LedgerChainFamily,
  LedgerHardwareCredential,
  LedgerPublicAccount
} from '@/core/wallet/hardware-wallet-data'
import {
  ledgerEvmDerivationPath,
  ledgerSolanaDerivationPath,
  ledgerNearDerivationPath,
  type LedgerDerivationMode
} from '@/core/wallet/ledger-derivation-path'
import type { Network } from '@/types'

export type LedgerSelectableFamily = Exclude<LedgerChainFamily, 'zcash'>
export const LEDGER_ACCOUNT_PAGE_SIZE = 5
export const LEDGER_PATH_MODES: Record<
  LedgerSelectableFamily,
  readonly { readonly value: LedgerDerivationMode; readonly label: string }[]
> = {
  evm: [
    { value: 'ledger-live', label: 'Ledger Live' },
    { value: 'standard', label: 'Standard' },
    { value: 'legacy', label: 'Legacy' }
  ],
  bitcoin: [{ value: 'standard', label: 'Native SegWit' }],
  solana: [
    { value: 'standard', label: 'Standard' },
    { value: 'legacy', label: 'Legacy' },
    { value: 'root', label: 'Ledger root' }
  ],
  near: [
    { value: 'standard', label: 'Standard' },
    { value: 'noir', label: 'Noir legacy' }
  ]
}

export interface LedgerAccountCandidate {
  readonly account: LedgerPublicAccount
  readonly deviceIndex: number
  readonly registered: boolean
}

export function ledgerCandidatePaths(
  family: LedgerSelectableFamily,
  mode: LedgerDerivationMode,
  start: number,
  network: Network
): readonly string[] {
  if (!LEDGER_PATH_MODES[family].some(option => option.value === mode)) {
    throw new Error('Unsupported Ledger derivation mode')
  }
  if (!Number.isSafeInteger(start) || start < 0 || start > 0x7fffffff) {
    throw new Error('Invalid Ledger account index')
  }
  if (mode === 'root' && start !== 0) throw new Error('Ledger root has no account index')
  const count = mode === 'root' ? 1 : Math.min(LEDGER_ACCOUNT_PAGE_SIZE, 0x80000000 - start)
  return Array.from({ length: count }, (_, offset) => {
    const index = start + offset
    if (family === 'evm' && (mode === 'ledger-live' || mode === 'standard' || mode === 'legacy'))
      return ledgerEvmDerivationPath(mode, index)
    if (family === 'solana' && (mode === 'standard' || mode === 'legacy' || mode === 'root'))
      return ledgerSolanaDerivationPath(mode, index)
    if (family === 'near' && (mode === 'standard' || mode === 'noir'))
      return ledgerNearDerivationPath(mode, index)
    return `m/84'/${network === 'mainnet' ? 0 : 1}'/${index}'`
  })
}

export function ledgerCandidateIsRegistered(
  account: LedgerPublicAccount,
  existing?: LedgerHardwareCredential
): boolean {
  return (
    existing?.schemaVersion === 3 &&
    existing.accountExport.accounts.some(
      registered =>
        registered.family === account.family &&
        registered.derivationPath === account.derivationPath &&
        (!('network' in registered) ||
          ('network' in account && registered.network === account.network))
    )
  )
}
