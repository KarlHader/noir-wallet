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
import { exportLedgerDashAccounts } from '@/lib/ledger/dash'
import { discoverLedgerStarknetAccounts } from '@/lib/ledger/starknet'
import { createStarknetRpcClient } from '@/infrastructure/chains/starknet/starknet-rpc-client'
import { getStarknetNetworkConfig } from '@/core/chains/starknet/network-config'
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

async function computeLedgerStarknetAddress(
  publicKey: string,
  signal?: AbortSignal
): Promise<{ readonly address: string; readonly classHash: string }> {
  const response: unknown = await chrome.runtime.sendMessage({
    type: 'COMPUTE_STARKNET_LEDGER_ADDRESS',
    publicKey
  })
  signal?.throwIfAborted()
  if (typeof response !== 'object' || response === null) {
    throw new Error('Starknet address computation failed')
  }
  const error = Reflect.get(response, 'error')
  if (error)
    throw new Error(typeof error === 'string' ? error : 'Starknet address computation failed')
  const result = Reflect.get(response, 'result')
  if (typeof result !== 'object' || result === null) {
    throw new Error('Starknet compute-address result is invalid')
  }
  const address = Reflect.get(result, 'address')
  const classHash = Reflect.get(result, 'classHash')
  if (typeof address !== 'string' || typeof classHash !== 'string') {
    throw new Error('Starknet compute-address result is invalid')
  }
  return { address, classHash }
}

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
  if (input.family === 'dash' && input.network !== 'mainnet') {
    throw new Error('Dash hardware wallets support mainnet only')
  }
  if (input.family === 'starknet') {
    const config = getStarknetNetworkConfig(input.network === 'mainnet' ? 'mainnet' : 'testnet')
    const rpc = createStarknetRpcClient({ chainId: config.chainId, rpcUrl: config.rpcUrl })
    const discovered = await discoverLedgerStarknetAccounts(paths, {
      ...input,
      computeAddress: publicKey => computeLedgerStarknetAddress(publicKey, input.signal),
      classHashAt: address => rpc.getClassHashAt(address, input.signal)
    })
    return discovered.map((result, offset) => {
      const publicAccount = {
        family: 'starknet' as const,
        accountIndex: input.logicalAccountIndex,
        derivationPath: paths[offset],
        network: input.network,
        publicKey: result.publicKey,
        address: result.address,
        classHash: result.classHash,
        accountType: 'argent' as const,
        appVersion: result.appVersion
      }
      const account = createLedgerMultichainHardwareCredential({
        deviceModel: result.deviceModel,
        deviceName: result.deviceName,
        accounts: [publicAccount]
      }).accountExport.accounts[0]
      return {
        account,
        deviceIndex: input.start + offset,
        registered: ledgerCandidateIsRegistered(account, input.existing),
        detail: result.detail,
        ...(result.selectable ? {} : { blockedReason: result.detail })
      }
    })
  }
  const results =
    input.family === 'evm'
      ? await exportLedgerEvmAccounts(paths, input)
      : input.family === 'bitcoin'
        ? await exportLedgerBitcoinAccounts(paths, input)
        : input.family === 'solana'
          ? await exportLedgerSolanaAccounts(paths, input)
          : input.family === 'dash'
            ? await exportLedgerDashAccounts(paths, input)
            : await exportLedgerNearAccounts(paths, input)
  input.signal?.throwIfAborted()
  if (results.length !== paths.length) throw new Error('Ledger account export is incomplete')
  return results.map((result, offset) => {
    let publicAccount: LedgerPublicAccount
    if (input.family === 'bitcoin') {
      const xpub = 'xpub' in result ? result.xpub : undefined
      const masterFingerprintHex =
        'masterFingerprintHex' in result ? result.masterFingerprintHex : undefined
      const publicKey = 'publicKey' in result ? result.publicKey : undefined
      const address = 'address' in result ? result.address : undefined
      if (
        typeof xpub !== 'string' ||
        typeof masterFingerprintHex !== 'string' ||
        typeof publicKey !== 'string' ||
        typeof address !== 'string'
      ) {
        throw new Error('Invalid Ledger Bitcoin account export')
      }
      publicAccount = {
        family: 'bitcoin' as const,
        accountIndex: input.logicalAccountIndex,
        derivationPath: paths[offset],
        network: input.network,
        xpub,
        masterFingerprintHex,
        publicKey,
        address
      }
    } else if (input.family === 'dash') {
      const xpub = 'xpub' in result ? result.xpub : undefined
      const publicKey = 'publicKey' in result ? result.publicKey : undefined
      const address = 'address' in result ? result.address : undefined
      if (
        typeof xpub !== 'string' ||
        typeof publicKey !== 'string' ||
        typeof address !== 'string' ||
        input.network !== 'mainnet'
      ) {
        throw new Error('Invalid Ledger Dash account export')
      }
      publicAccount = {
        family: 'dash' as const,
        accountIndex: input.logicalAccountIndex,
        derivationPath: paths[offset],
        network: 'mainnet',
        xpub,
        publicKey,
        address
      }
    } else if (input.family === 'evm' || input.family === 'solana' || input.family === 'near') {
      publicAccount = {
        family: input.family,
        accountIndex: input.logicalAccountIndex,
        derivationPath: paths[offset],
        publicKey: result.publicKey,
        address: result.address
      }
    } else {
      throw new Error('Unsupported Ledger account family')
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
