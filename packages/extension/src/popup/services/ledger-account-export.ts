import {
  createLedgerMultichainHardwareCredential,
  type LedgerHardwareCredential,
  type LedgerPublicAccount,
  type LedgerChainFamily
} from '@/core/wallet/hardware-wallet-data'
import {
  discoverLedger,
  exportLedgerAccount,
  type LedgerSessionOptions,
  type LedgerTransport
} from '@/lib/ledger/device'
import { exportLedgerEvmAccount } from '@/lib/ledger/evm'
import { exportLedgerBitcoinAccount } from '@/lib/ledger/bitcoin'
import { exportLedgerSolanaAccount } from '@/lib/ledger/solana'
import { exportLedgerNearAccount } from '@/lib/ledger/near'
import type { Network } from '@/types'
import { ledgerAppName } from './ledger-device-status'

export function ledgerCredentialAccounts(
  credential: LedgerHardwareCredential
): readonly LedgerPublicAccount[] {
  if (credential.schemaVersion === 3) return credential.accountExport.accounts
  const network = credential.accountExport.ufvk.startsWith('uviewtest1') ? 'testnet' : 'mainnet'
  return [
    {
      family: 'zcash',
      accountIndex: 0,
      derivationPath: `m/32'/${network === 'mainnet' ? 133 : 1}'/${credential.accountExport.accountHdIndex}'`,
      network,
      ufvk: credential.accountExport.ufvk,
      accountHdIndex: credential.accountExport.accountHdIndex
    }
  ]
}
export function ledgerAccountIdentity(account: LedgerPublicAccount): string {
  return JSON.stringify(
    account.family === 'zcash'
      ? [account.family, account.derivationPath, account.network, account.ufvk]
      : account.family === 'bitcoin'
        ? [
            account.family,
            account.derivationPath,
            account.network,
            account.xpub,
            account.masterFingerprintHex,
            account.address,
            account.publicKey
          ]
        : [account.family, account.derivationPath, account.address, account.publicKey]
  )
}
export async function exportLedgerWalletAccounts(input: {
  readonly transport: LedgerTransport
  readonly network: Network
  readonly families: readonly LedgerChainFamily[]
  readonly deviceAccountIndex: number
  readonly accountIndex: number
  readonly device?: LedgerSessionOptions['device']
  readonly derivationPaths?: Partial<Record<LedgerChainFamily, string>>
  readonly expectedAccounts?: readonly LedgerPublicAccount[]
  readonly existing?: LedgerHardwareCredential
  readonly signal: AbortSignal
  readonly onStep: (app: string, interaction?: string) => void
}) {
  input.signal.throwIfAborted()
  const device = input.device ?? (await discoverLedger(input.transport, input.signal))
  let metadata: { deviceModel: string; deviceName: string } | undefined
  const exportAccount = async (
    family: LedgerChainFamily,
    path?: string,
    network = input.network
  ): Promise<LedgerPublicAccount> => {
    const app = ledgerAppName(family, network)
    input.onStep(app)
    input.signal.throwIfAborted()
    const options = {
      transport: input.transport,
      device,
      signal: input.signal,
      onInteraction: (interaction: string) => input.onStep(app, interaction)
    }
    if (family === 'evm') {
      const result = await exportLedgerEvmAccount({
        ...options,
        accountIndex: input.deviceAccountIndex,
        ...(path ? { derivationPath: path } : {})
      })
      metadata = result
      return {
        family,
        accountIndex: input.accountIndex,
        derivationPath: result.derivationPath,
        publicKey: result.publicKey,
        address: result.address
      }
    }
    if (family === 'bitcoin') {
      const result = await exportLedgerBitcoinAccount({
        ...options,
        network,
        accountIndex: input.deviceAccountIndex,
        ...(path ? { derivationPath: path } : {})
      })
      metadata = result
      return {
        family,
        accountIndex: input.accountIndex,
        derivationPath: result.accountPath,
        network,
        xpub: result.xpub,
        masterFingerprintHex: result.masterFingerprintHex,
        publicKey: result.publicKey,
        address: result.address
      }
    }
    if (family === 'solana') {
      const result = await exportLedgerSolanaAccount(
        path ?? `m/44'/501'/${input.deviceAccountIndex}'/0'`,
        options
      )
      metadata = result
      return {
        family,
        accountIndex: input.accountIndex,
        derivationPath: result.path,
        publicKey: result.publicKey,
        address: result.address
      }
    }
    if (family === 'near') {
      const result = await exportLedgerNearAccount(
        path ?? `m/44'/397'/${input.deviceAccountIndex}'/0'/1'`,
        options
      )
      metadata = result
      return {
        family,
        accountIndex: input.accountIndex,
        derivationPath: result.path,
        publicKey: result.publicKey,
        address: result.address
      }
    }
    const hdIndex = path
      ? Number(path.split('/').at(-1)?.replace("'", ''))
      : input.deviceAccountIndex
    const result = await exportLedgerAccount({ ...options, network, accountIndex: hdIndex })
    metadata = result
    return {
      family,
      accountIndex: input.accountIndex,
      derivationPath: `m/32'/${network === 'mainnet' ? 133 : 1}'/${hdIndex}'`,
      network,
      ufvk: result.ufvk,
      accountHdIndex: hdIndex
    }
  }
  const existing = input.existing ? ledgerCredentialAccounts(input.existing) : []
  let anchorProof: LedgerPublicAccount | undefined
  if (existing.length) {
    const anchor = existing[0]
    const fresh = await exportAccount(
      anchor.family,
      anchor.derivationPath,
      'network' in anchor ? anchor.network : input.network
    )
    const normalized = createLedgerMultichainHardwareCredential({
      deviceModel: input.existing?.deviceModel ?? 'Ledger',
      deviceName: input.existing?.deviceName ?? 'Ledger',
      accounts: [{ ...fresh, accountIndex: anchor.accountIndex }]
    }).accountExport.accounts[0]
    if (ledgerAccountIdentity(normalized) !== ledgerAccountIdentity(anchor))
      throw new Error('Connected Ledger does not match this Wallet')
    anchorProof = anchor
  }
  const additions: LedgerPublicAccount[] = []
  for (const family of input.families) {
    input.signal.throwIfAborted()
    if (
      existing.some(
        account =>
          account.family === family &&
          account.accountIndex === input.accountIndex &&
          (!('network' in account) || account.network === input.network)
      )
    )
      continue
    const fresh = await exportAccount(family, input.derivationPaths?.[family])
    if (!metadata) throw new Error('Ledger device metadata is unavailable')
    const normalized = createLedgerMultichainHardwareCredential({
      ...metadata,
      accounts: [fresh]
    }).accountExport.accounts[0]
    const expected = input.expectedAccounts?.find(account => account.family === family)
    if (expected && ledgerAccountIdentity(normalized) !== ledgerAccountIdentity(expected)) {
      throw new Error('Ledger account changed. Select the account again.')
    }
    additions.push(normalized)
  }
  if (!metadata || (!additions.length && !existing.length))
    throw new Error('Select at least one Ledger chain account')
  const credential = createLedgerMultichainHardwareCredential({
    ...metadata,
    ...(input.existing?.ledgerSigningTransport === undefined
      ? {}
      : { ledgerSigningTransport: input.existing.ledgerSigningTransport }),
    accounts: [...existing, ...additions]
  })
  return { credential, anchorProof }
}
