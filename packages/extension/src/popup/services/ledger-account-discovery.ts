import {
  createLedgerMultichainHardwareCredential,
  type LedgerHardwareCredential,
  type LedgerPublicAccount
} from '@/core/wallet/hardware-wallet-data'
import type { LedgerDerivationMode } from '@/core/wallet/ledger-derivation-path'
import { exportLedgerEvmAccounts } from '@/lib/ledger/evm'
import { exportLedgerBitcoinAccounts } from '@/lib/ledger/bitcoin'
import { exportLedgerSolanaAccounts } from '@/lib/ledger/solana'
import { exportLedgerNearAccounts } from '@/lib/ledger/near'
import type { LedgerSessionOptions } from '@/lib/ledger/device'
import type { Network } from '@/types'
import {
  ledgerCandidatePaths,
  ledgerCandidateIsRegistered,
  type LedgerAccountCandidate,
  type LedgerSelectableFamily
} from './ledger-account-discovery-model'
export { LEDGER_PATH_MODES } from './ledger-account-discovery-model'
export type {
  LedgerAccountCandidate,
  LedgerSelectableFamily
} from './ledger-account-discovery-model'

export async function loadLedgerAccountCandidates(
  input: LedgerSessionOptions & {
    readonly family: LedgerSelectableFamily
    readonly mode: LedgerDerivationMode
    readonly start: number
    readonly network: Network
    readonly logicalAccountIndex: number
    readonly existing?: LedgerHardwareCredential
  }
): Promise<readonly LedgerAccountCandidate[]> {
  const paths = ledgerCandidatePaths(input.family, input.mode, input.start, input.network)
  const results =
    input.family === 'evm'
      ? await exportLedgerEvmAccounts(paths, input)
      : input.family === 'bitcoin'
        ? await exportLedgerBitcoinAccounts(paths, input)
        : input.family === 'solana'
          ? await exportLedgerSolanaAccounts(paths, input)
          : await exportLedgerNearAccounts(paths, input)
  input.signal?.throwIfAborted()
  if (results.length !== paths.length) throw new Error('Ledger account export is incomplete')
  return results.map((result, offset) => {
    let publicAccount: LedgerPublicAccount
    if (input.family === 'bitcoin') {
      if (!('xpub' in result)) throw new Error('Invalid Ledger Bitcoin account export')
      publicAccount = {
        family: 'bitcoin' as const,
        accountIndex: input.logicalAccountIndex,
        derivationPath: paths[offset],
        network: input.network,
        xpub: result.xpub,
        masterFingerprintHex: result.masterFingerprintHex,
        publicKey: result.publicKey,
        address: result.address
      }
    } else {
      publicAccount = {
        family: input.family,
        accountIndex: input.logicalAccountIndex,
        derivationPath: paths[offset],
        publicKey: result.publicKey,
        address: result.address
      }
    }
    const account = createLedgerMultichainHardwareCredential({
      deviceModel: result.deviceModel,
      deviceName: result.deviceName,
      accounts: [publicAccount]
    }).accountExport.accounts[0]
    return {
      account,
      deviceIndex: input.start + offset,
      registered: ledgerCandidateIsRegistered(account, input.existing)
    }
  })
}
