import '@/lib/buffer-polyfill'
import { secp256k1 } from '@noble/curves/secp256k1'
import { HDKey } from '@scure/bip32'
import { Buffer } from 'buffer'
import { networks, payments } from 'bitcoinjs-lib'
import { publicKeyToAddress } from 'viem/accounts'
import { parseSolanaPublicKey } from '@/core/chains/solana/identifiers'
import {
  nearImplicitAccountIdFromPublicKey,
  parseNearPublicKey
} from '@/core/chains/near/identifiers'
import {
  validateLedgerEvmDerivationPath,
  validateLedgerNearDerivationPath,
  validateLedgerSolanaDerivationPath
} from './ledger-derivation-path'

export const LEDGER_MULTICHAIN_HARDWARE_CREDENTIAL_SCHEMA_VERSION = 3 as const
export const LEDGER_CHAIN_FAMILIES = Object.freeze([
  'zcash',
  'bitcoin',
  'evm',
  'solana',
  'near'
] as const)
export type LedgerChainFamily = (typeof LEDGER_CHAIN_FAMILIES)[number]
interface LedgerAccountBase {
  readonly accountIndex: number
  readonly derivationPath: string
}
export type LedgerPublicAccount = LedgerAccountBase &
  (
    | { readonly family: 'evm'; readonly publicKey: string; readonly address: string }
    | {
        readonly family: 'bitcoin'
        readonly network: 'mainnet' | 'testnet'
        readonly xpub: string
        readonly masterFingerprintHex: string
        readonly publicKey: string
        readonly address: string
      }
    | { readonly family: 'solana'; readonly publicKey: string; readonly address: string }
    | { readonly family: 'near'; readonly publicKey: string; readonly address: string }
    | {
        readonly family: 'zcash'
        readonly network: 'mainnet' | 'testnet'
        readonly ufvk: string
        readonly accountHdIndex: number
        readonly birthdayHeight?: number
      }
  )

export function ledgerPublicAccountIdentity(account: LedgerPublicAccount): string {
  return `${account.family}:${account.accountIndex}:${'network' in account ? account.network : ''}`
}

export function ledgerPublicAccountEquals(
  left: LedgerPublicAccount,
  right: LedgerPublicAccount
): boolean {
  return (
    ledgerPublicAccountIdentity(left) === ledgerPublicAccountIdentity(right) &&
    JSON.stringify(left) === JSON.stringify(right)
  )
}
export interface LedgerMultichainHardwareCredential {
  readonly schemaVersion: typeof LEDGER_MULTICHAIN_HARDWARE_CREDENTIAL_SCHEMA_VERSION
  readonly vendor: 'ledger'
  readonly firmwareProfile: 'multi-app'
  readonly capabilities: readonly LedgerChainFamily[]
  readonly accountExport: {
    readonly protocol: 'ledger-accounts-v1'
    readonly accounts: readonly LedgerPublicAccount[]
  }
  readonly deviceModel: string
  readonly deviceName: string
  readonly ledgerSigningTransport?: 'usb' | 'bluetooth'
}

function record(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
}
function keys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): void {
  if (
    required.some(key => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some(key => ![...required, ...optional].includes(key))
  ) {
    throw new Error('Invalid Ledger credential fields')
  }
}
function text(value: unknown, label: string, max = 256): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > max ||
    value.trim() !== value
  )
    throw new Error(`Invalid Ledger ${label}`)
  return value
}
function index(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff)
    throw new Error('Invalid Ledger account index')
  return value
}
function network(value: unknown): 'mainnet' | 'testnet' {
  if (value !== 'mainnet' && value !== 'testnet') throw new Error('Invalid Ledger account network')
  return value
}
function path(value: unknown, pattern: RegExp): string {
  const parsed = text(value, 'derivation path', 128)
  if (!pattern.test(parsed)) throw new Error('Unsupported Ledger account derivation path')
  for (const segment of parsed.slice(2).split('/')) {
    if (!/^(?:0|[1-9][0-9]*)'?$/.test(segment))
      throw new Error('Non-canonical Ledger derivation path')
    index(Number(segment.replace("'", '')))
  }
  return parsed
}
function secpKey(value: unknown): string {
  const key = text(value, 'public key')
  if (!/^0x(?:[0-9a-fA-F]{66}|[0-9a-fA-F]{130})$/.test(key))
    throw new Error('Invalid Ledger secp256k1 public key')
  return `0x${secp256k1.ProjectivePoint.fromHex(key.slice(2)).toHex(false)}`
}
function parseAccount(value: unknown): LedgerPublicAccount {
  if (!record(value)) throw new Error('Invalid Ledger public account')
  const accountIndex = index(value.accountIndex)
  const common = ['family', 'accountIndex', 'derivationPath']
  if (value.family === 'evm') {
    keys(value, [...common, 'publicKey', 'address'])
    const publicKey = secpKey(value.publicKey)
    const address = text(value.address, 'EVM address').toLowerCase()
    if (publicKeyToAddress(publicKey as `0x${string}`).toLowerCase() !== address)
      throw new Error('Ledger EVM address does not match public key')
    return Object.freeze({
      family: 'evm',
      accountIndex,
      derivationPath: validateLedgerEvmDerivationPath(
        path(value.derivationPath, /^m\/44'\/60'\/.+$/)
      ),
      publicKey,
      address
    })
  }
  if (value.family === 'bitcoin') {
    keys(value, [...common, 'network', 'xpub', 'masterFingerprintHex', 'publicKey', 'address'])
    const net = network(value.network)
    const derivationPath = path(
      value.derivationPath,
      new RegExp(`^m/84'/${net === 'mainnet' ? 0 : 1}'/[0-9]+'$`)
    )
    const xpub = text(value.xpub, 'Bitcoin xpub')
    const versions = net === 'mainnet' ? undefined : { public: 0x043587cf, private: 0x04358394 }
    const root = HDKey.fromExtendedKey(xpub, versions)
    if (
      root.privateKey ||
      root.depth !== 3 ||
      root.index !== Number(derivationPath.split('/')[3].slice(0, -1)) + 0x80000000
    )
      throw new Error('Ledger xpub does not match its account path')
    const child = root.deriveChild(0).deriveChild(0).publicKey
    if (!child) throw new Error('Invalid Ledger Bitcoin xpub')
    const publicKey = `0x${Buffer.from(child).toString('hex')}`
    const address = payments.p2wpkh({
      pubkey: Buffer.from(child),
      network: net === 'mainnet' ? networks.bitcoin : networks.testnet
    }).address
    if (
      !address ||
      value.address !== address ||
      typeof value.publicKey !== 'string' ||
      value.publicKey.toLowerCase() !== publicKey
    )
      throw new Error('Ledger Bitcoin receive address does not match xpub')
    const masterFingerprintHex = text(
      value.masterFingerprintHex,
      'Bitcoin fingerprint'
    ).toLowerCase()
    if (!/^[0-9a-f]{8}$/.test(masterFingerprintHex))
      throw new Error('Invalid Ledger Bitcoin fingerprint')
    return Object.freeze({
      family: 'bitcoin',
      accountIndex,
      derivationPath,
      network: net,
      xpub,
      masterFingerprintHex,
      publicKey,
      address
    })
  }
  if (value.family === 'solana' || value.family === 'near') {
    keys(value, [...common, 'publicKey', 'address'])
    const family = value.family
    const derivationPath =
      family === 'solana'
        ? validateLedgerSolanaDerivationPath(path(value.derivationPath, /^m\/44'\/501'(?:\/.+)?$/))
        : validateLedgerNearDerivationPath(path(value.derivationPath, /^m\/44'\/397'\/.+$/))
    const publicKey =
      family === 'solana'
        ? parseSolanaPublicKey(value.publicKey)
        : parseNearPublicKey(value.publicKey)
    const address = family === 'solana' ? publicKey : nearImplicitAccountIdFromPublicKey(publicKey)
    if (value.address !== address)
      throw new Error(`Ledger ${family} address does not match public key`)
    return Object.freeze({ family, accountIndex, derivationPath, publicKey, address })
  }
  if (value.family === 'zcash') {
    keys(value, [...common, 'network', 'ufvk', 'accountHdIndex'], ['birthdayHeight'])
    const net = network(value.network)
    const accountHdIndex = index(value.accountHdIndex)
    const derivationPath = path(
      value.derivationPath,
      new RegExp(`^m/32'/${net === 'mainnet' ? 133 : 1}'/${accountHdIndex}'$`)
    )
    const ufvk = text(value.ufvk, 'UFVK', 4096)
    if (!ufvk.startsWith(net === 'mainnet' ? 'uview1' : 'uviewtest1'))
      throw new Error('Ledger UFVK network does not match account')
    const birthdayHeight =
      value.birthdayHeight === undefined ? undefined : index(value.birthdayHeight)
    return Object.freeze({
      family: 'zcash',
      accountIndex,
      derivationPath,
      network: net,
      ufvk,
      accountHdIndex,
      ...(birthdayHeight === undefined ? {} : { birthdayHeight })
    })
  }
  throw new Error('Unsupported Ledger chain family')
}

export function parseLedgerMultichainHardwareCredential(
  value: unknown
): LedgerMultichainHardwareCredential {
  if (!record(value)) throw new Error('Invalid Ledger multichain credential')
  keys(
    value,
    [
      'schemaVersion',
      'vendor',
      'firmwareProfile',
      'capabilities',
      'accountExport',
      'deviceModel',
      'deviceName'
    ],
    ['ledgerSigningTransport']
  )
  if (
    value.schemaVersion !== 3 ||
    value.vendor !== 'ledger' ||
    value.firmwareProfile !== 'multi-app' ||
    !record(value.accountExport) ||
    (value.ledgerSigningTransport !== undefined &&
      value.ledgerSigningTransport !== 'usb' &&
      value.ledgerSigningTransport !== 'bluetooth')
  )
    throw new Error('Invalid Ledger multichain credential')
  keys(value.accountExport, ['protocol', 'accounts'])
  if (
    value.accountExport.protocol !== 'ledger-accounts-v1' ||
    !Array.isArray(value.accountExport.accounts) ||
    value.accountExport.accounts.length === 0 ||
    value.accountExport.accounts.length > 512
  )
    throw new Error('Invalid Ledger public account export')
  const accounts = value.accountExport.accounts.map(parseAccount)
  const identities = accounts.map(
    account =>
      `${account.family}:${account.accountIndex}:${'network' in account ? account.network : ''}`
  )
  if (new Set(identities).size !== identities.length)
    throw new Error('Duplicate Ledger public account')
  const paths = accounts.map(
    account =>
      `${account.family}:${'network' in account ? account.network : ''}:${account.derivationPath}`
  )
  if (new Set(paths).size !== paths.length)
    throw new Error('Ledger derivation path is already registered')
  const capabilities = LEDGER_CHAIN_FAMILIES.filter(family =>
    accounts.some(account => account.family === family)
  )
  if (
    !Array.isArray(value.capabilities) ||
    JSON.stringify(value.capabilities) !== JSON.stringify(capabilities)
  )
    throw new Error('Ledger capabilities do not match exported accounts')
  return Object.freeze({
    schemaVersion: 3,
    vendor: 'ledger',
    firmwareProfile: 'multi-app',
    capabilities: Object.freeze(capabilities),
    accountExport: Object.freeze({
      protocol: 'ledger-accounts-v1',
      accounts: Object.freeze(accounts)
    }),
    deviceModel: text(value.deviceModel, 'device model'),
    deviceName: text(value.deviceName, 'device name'),
    ...(value.ledgerSigningTransport === undefined
      ? {}
      : { ledgerSigningTransport: value.ledgerSigningTransport as 'usb' | 'bluetooth' })
  })
}

export function createLedgerMultichainHardwareCredential(input: {
  readonly accounts: readonly LedgerPublicAccount[]
  readonly deviceModel: string
  readonly deviceName: string
  readonly ledgerSigningTransport?: 'usb' | 'bluetooth'
}): LedgerMultichainHardwareCredential {
  return parseLedgerMultichainHardwareCredential({
    schemaVersion: 3,
    vendor: 'ledger',
    firmwareProfile: 'multi-app',
    capabilities: LEDGER_CHAIN_FAMILIES.filter(family =>
      input.accounts.some(account => account.family === family)
    ),
    accountExport: { protocol: 'ledger-accounts-v1', accounts: input.accounts },
    deviceModel: input.deviceModel,
    deviceName: input.deviceName,
    ...(input.ledgerSigningTransport === undefined
      ? {}
      : { ledgerSigningTransport: input.ledgerSigningTransport })
  })
}

export function findLedgerPublicAccount<F extends LedgerChainFamily>(
  credential: {
    readonly accountExport: {
      readonly protocol: string
      readonly accounts?: readonly LedgerPublicAccount[]
    }
  },
  query: {
    readonly family: F
    readonly accountIndex?: number
    readonly derivationPath?: string
    readonly network?: 'mainnet' | 'testnet'
  }
): Extract<LedgerPublicAccount, { readonly family: F }> | null {
  const matches =
    credential.accountExport.accounts?.filter(
      account =>
        account.family === query.family &&
        (query.accountIndex === undefined || account.accountIndex === query.accountIndex) &&
        (query.derivationPath === undefined || account.derivationPath === query.derivationPath) &&
        (query.network === undefined ||
          !('network' in account) ||
          account.network === query.network)
    ) ?? []
  if (matches.length > 1) throw new Error('Ambiguous Ledger public account')
  return (matches[0] ?? null) as Extract<LedgerPublicAccount, { readonly family: F }> | null
}
