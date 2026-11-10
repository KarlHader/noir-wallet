import { parseChainId } from '@/core/chains/registry'
import { DASH_CHAIN_IDS } from '@/core/chains/registry/chain-ids'
import type { ChainId } from '@/core/chains/domain'
import { getDashNetworkConfig } from '@/config/networks'
import { KeyringError } from '@/core/keyring/ports'
import {
  MAX_BIP32_INDEX,
  MAX_UINT64,
  assertExactKeys,
  readArray,
  readBoolean,
  readHex,
  readLiteral,
  readRecord,
  readSafeInteger,
  parseRawSessionInfo,
  readBoundedString,
  readString,
  readUnsignedDecimal,
  type RawExportedPrivateKey,
  type RawSessionInfo
} from './raw-wallet-engine'

export type DashNetworkName = 'mainnet' | 'testnet'

export interface RawDashAccount {
  readonly accountId: string
  readonly address: string
  readonly derivationPath: string
  readonly publicKey: string
  readonly curve: 'secp256k1'
  readonly addressScheme: 'dash_p2pkh'
  readonly derivationScheme: 'bip44' | 'imported'
  readonly network: DashNetworkName
  readonly masterFingerprint: string
  readonly scriptPubKey: string
  readonly redeemScript?: string
}

export interface DashNetworkParams {
  readonly chainId: ChainId
  readonly network: DashNetworkName
  readonly genesisHash: string
  readonly coinType: 5 | 1
  readonly p2pkhVersion: number
  readonly p2shVersion: number
  readonly wifVersion: number
  readonly displayName: string
  readonly requiredConfirmations: number
}

const DASH_ACCOUNT_KEYS = Object.freeze([
  'accountId',
  'address',
  'derivationPath',
  'publicKey',
  'curve',
  'addressScheme',
  'derivationScheme',
  'network',
  'masterFingerprint',
  'scriptPubKey'
] as const)

export function isDashChainId(chainId: string): chainId is ChainId {
  return chainId === DASH_CHAIN_IDS.mainnet || chainId === DASH_CHAIN_IDS.testnet
}

export function dashNetworkName(chainId: string): DashNetworkName {
  if (chainId === DASH_CHAIN_IDS.mainnet) return 'mainnet'
  if (chainId === DASH_CHAIN_IDS.testnet) return 'testnet'
  throw new Error('Unsupported Dash chain ID')
}

function readVersionByte(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error(`${label} must be a version byte`)
  }
  return value
}

export function readDashNetworkParams(chainId: string): DashNetworkParams {
  const network = dashNetworkName(chainId)
  const config = getDashNetworkConfig(network)
  const parsedChainId = parseChainId(config.chainId).id
  if (parsedChainId !== chainId || config.chainId !== DASH_CHAIN_IDS[network]) {
    throw new Error('Dash network config does not match the selected chain')
  }
  const coinType = config.coinType
  if ((network === 'mainnet' && coinType !== 5) || (network === 'testnet' && coinType !== 1)) {
    throw new Error('Dash coin type does not match the selected network')
  }
  if (typeof config.genesisHash !== 'string' || config.genesisHash.trim() !== config.genesisHash) {
    throw new Error('Dash genesis hash is invalid')
  }
  if (typeof config.displayName !== 'string' || config.displayName.length === 0) {
    throw new Error('Dash display name is invalid')
  }
  if (!Number.isInteger(config.requiredConfirmations) || config.requiredConfirmations < 1) {
    throw new Error('Dash confirmation policy is invalid')
  }
  return Object.freeze({
    chainId: parsedChainId,
    network,
    genesisHash: config.genesisHash,
    coinType,
    p2pkhVersion: readVersionByte(config.p2pkhVersion, 'Dash P2PKH version'),
    p2shVersion: readVersionByte(config.p2shVersion, 'Dash P2SH version'),
    wifVersion: readVersionByte(config.wifVersion, 'Dash WIF version'),
    displayName: config.displayName,
    requiredConfirmations: config.requiredConfirmations
  })
}

export function dashDerivationPath(
  chainId: string,
  accountIndex: number,
  change: boolean,
  addressIndex: number,
  imported: boolean
): string {
  if (imported) return 'm'
  const coinType = readDashNetworkParams(chainId).coinType
  return `m/44'/${coinType}'/${accountIndex}'/${change ? 1 : 0}/${addressIndex}`
}

function dashAddressMatches(address: string, network: DashNetworkName): boolean {
  const prefix = network === 'mainnet' ? 'X' : 'y'
  return (
    address.startsWith(prefix) &&
    address.length >= 26 &&
    address.length <= 40 &&
    /^[1-9A-HJ-NP-Za-km-z]+$/.test(address)
  )
}

export function parseRawDashAccount(value: unknown): RawDashAccount {
  const record = readRecord(value, 'DerivedDashAccount')
  if (Object.prototype.hasOwnProperty.call(record, 'kind')) {
    throw new Error('Derived Dash account must not include kind')
  }
  assertExactKeys(record, DASH_ACCOUNT_KEYS, [], 'DerivedDashAccount')
  const publicKey = readHex(record.publicKey, 'DerivedDashAccount.publicKey', { bytes: 33 })
  if (!/^0x0[23][0-9a-f]{64}$/.test(publicKey)) {
    throw new Error('Derived Dash public key is invalid')
  }
  const network = readLiteral(record.network, ['mainnet', 'testnet'], 'DerivedDashAccount.network')
  const address = readString(record.address, 'DerivedDashAccount.address', 128)
  const scriptPubKey = readHex(record.scriptPubKey, 'DerivedDashAccount.scriptPubKey')
  if (!dashAddressMatches(address, network) || !/^0x76a914[0-9a-f]{40}88ac$/.test(scriptPubKey)) {
    throw new Error('Derived Dash address or script is invalid')
  }
  const accountId = readString(record.accountId, 'DerivedDashAccount.accountId', 256)
  return Object.freeze({
    accountId,
    address,
    derivationPath: readString(record.derivationPath, 'DerivedDashAccount.derivationPath', 128),
    publicKey,
    curve: readLiteral(record.curve, ['secp256k1'], 'DerivedDashAccount.curve'),
    addressScheme: readLiteral(
      record.addressScheme,
      ['dash_p2pkh'],
      'DerivedDashAccount.addressScheme'
    ),
    derivationScheme: readLiteral(
      record.derivationScheme,
      ['bip44', 'imported'],
      'DerivedDashAccount.derivationScheme'
    ),
    network,
    masterFingerprint: readHex(record.masterFingerprint, 'DerivedDashAccount.masterFingerprint', {
      bytes: 4
    }),
    scriptPubKey
  })
}

export function assertRawDashAccountMatches(
  account: RawDashAccount,
  chainId: string,
  accountIndex: number,
  change: boolean,
  addressIndex: number,
  imported: boolean
): void {
  const params = readDashNetworkParams(chainId)
  const expectedPath = dashDerivationPath(chainId, accountIndex, change, addressIndex, imported)
  if (
    account.accountId !== `${chainId}:${account.address}` ||
    account.network !== params.network ||
    account.addressScheme !== 'dash_p2pkh' ||
    account.derivationScheme !== (imported ? 'imported' : 'bip44') ||
    account.derivationPath !== expectedPath ||
    (imported && (accountIndex !== 0 || change || addressIndex !== 0))
  ) {
    throw new Error('Derived Dash account does not match its request')
  }
}

export function assertImportedDashCoordinate(
  accountIndex: number,
  change: boolean,
  addressIndex: number,
  batchCount?: number
): void {
  if (
    accountIndex !== 0 ||
    change ||
    addressIndex !== 0 ||
    (batchCount !== undefined && batchCount !== 1)
  ) {
    throw new KeyringError('INVALID_COMMAND')
  }
}

export interface RawDashPsbtInput {
  readonly index: number
  readonly txid: string
  readonly vout: number
  readonly sequence: number
  readonly valueDuffs: string
  readonly address: string
  readonly scriptPubKey: string
  readonly walletOwned: boolean
  readonly derivationPath: string | null
  readonly sighashType: string
}

export interface RawDashPsbtOutput {
  readonly index: number
  readonly valueDuffs: string
  readonly address: string | null
  readonly scriptPubKey: string
  readonly walletOwned: boolean
  readonly isChange: boolean
  readonly derivationPath: string | null
}

export interface RawDashPsbtSummary {
  readonly chainId: string
  readonly network: DashNetworkName
  readonly accountIndex: number
  readonly psbtVersion: 0
  readonly unsignedTxid: string
  readonly transactionVersion: number
  readonly transactionType: number
  readonly lockTime: number
  readonly inputCount: number
  readonly outputCount: number
  readonly signableInputCount: number
  readonly totalInputDuffs: string
  readonly totalOutputDuffs: string
  readonly feeDuffs: string
  readonly inputs: readonly RawDashPsbtInput[]
  readonly outputs: readonly RawDashPsbtOutput[]
}

function parseNullableDerivationPath(value: unknown, label: string): string | null {
  if (value === null) return null
  return readString(value, label, 128)
}

function parseDashPsbtInput(value: unknown, index: number): RawDashPsbtInput {
  const label = `DashPsbtSummary.inputs[${index}]`
  const record = readRecord(value, label)
  assertExactKeys(
    record,
    [
      'index',
      'txid',
      'vout',
      'sequence',
      'valueDuffs',
      'address',
      'scriptPubKey',
      'walletOwned',
      'derivationPath',
      'sighashType'
    ],
    [],
    label
  )
  const txid = readString(record.txid, `${label}.txid`, 64)
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error(`${label}.txid is invalid`)
  return Object.freeze({
    index: readSafeInteger(record.index, `${label}.index`),
    txid,
    vout: readSafeInteger(record.vout, `${label}.vout`),
    sequence: readSafeInteger(record.sequence, `${label}.sequence`),
    valueDuffs: readUnsignedDecimal(record.valueDuffs, `${label}.valueDuffs`, MAX_UINT64),
    address: readString(record.address, `${label}.address`, 128),
    scriptPubKey: readHex(record.scriptPubKey, `${label}.scriptPubKey`),
    walletOwned: readBoolean(record.walletOwned, `${label}.walletOwned`),
    derivationPath: parseNullableDerivationPath(record.derivationPath, `${label}.derivationPath`),
    sighashType: readString(record.sighashType, `${label}.sighashType`, 64)
  })
}

function parseDashPsbtOutput(value: unknown, index: number): RawDashPsbtOutput {
  const label = `DashPsbtSummary.outputs[${index}]`
  const record = readRecord(value, label)
  assertExactKeys(
    record,
    ['index', 'valueDuffs', 'address', 'scriptPubKey', 'walletOwned', 'isChange', 'derivationPath'],
    [],
    label
  )
  const isChange = readBoolean(record.isChange, `${label}.isChange`)
  const walletOwned = readBoolean(record.walletOwned, `${label}.walletOwned`)
  if (isChange && !walletOwned) throw new Error('Dash change output must be wallet owned')
  return Object.freeze({
    index: readSafeInteger(record.index, `${label}.index`),
    valueDuffs: readUnsignedDecimal(record.valueDuffs, `${label}.valueDuffs`, MAX_UINT64),
    address: record.address === null ? null : readString(record.address, `${label}.address`, 128),
    scriptPubKey: readHex(record.scriptPubKey, `${label}.scriptPubKey`),
    walletOwned,
    isChange,
    derivationPath: parseNullableDerivationPath(record.derivationPath, `${label}.derivationPath`)
  })
}

export function parseRawDashPsbtSummary(value: unknown): RawDashPsbtSummary {
  const record = readRecord(value, 'DashPsbtSummary')
  assertExactKeys(
    record,
    [
      'chainId',
      'network',
      'accountIndex',
      'psbtVersion',
      'unsignedTxid',
      'transactionVersion',
      'transactionType',
      'lockTime',
      'inputCount',
      'outputCount',
      'signableInputCount',
      'totalInputDuffs',
      'totalOutputDuffs',
      'feeDuffs',
      'inputs',
      'outputs'
    ],
    [],
    'DashPsbtSummary'
  )
  const chainId = readString(record.chainId, 'DashPsbtSummary.chainId', 64)
  const params = readDashNetworkParams(chainId)
  const inputs = readArray(record.inputs, 'DashPsbtSummary.inputs', parseDashPsbtInput, 512)
  const outputs = readArray(record.outputs, 'DashPsbtSummary.outputs', parseDashPsbtOutput, 512)
  const unsignedTxid = readString(record.unsignedTxid, 'DashPsbtSummary.unsignedTxid', 64)
  if (!/^[0-9a-f]{64}$/.test(unsignedTxid)) {
    throw new Error('DashPsbtSummary.unsignedTxid is invalid')
  }
  const summary = Object.freeze({
    chainId,
    network: readLiteral(record.network, ['mainnet', 'testnet'], 'DashPsbtSummary.network'),
    accountIndex: readSafeInteger(
      record.accountIndex,
      'DashPsbtSummary.accountIndex',
      MAX_BIP32_INDEX
    ),
    psbtVersion: readLiteral(record.psbtVersion, [0], 'DashPsbtSummary.psbtVersion'),
    unsignedTxid,
    transactionVersion: readSafeInteger(
      record.transactionVersion,
      'DashPsbtSummary.transactionVersion'
    ),
    transactionType: readSafeInteger(record.transactionType, 'DashPsbtSummary.transactionType'),
    lockTime: readSafeInteger(record.lockTime, 'DashPsbtSummary.lockTime'),
    inputCount: readSafeInteger(record.inputCount, 'DashPsbtSummary.inputCount', 512),
    outputCount: readSafeInteger(record.outputCount, 'DashPsbtSummary.outputCount', 512),
    signableInputCount: readSafeInteger(
      record.signableInputCount,
      'DashPsbtSummary.signableInputCount',
      512
    ),
    totalInputDuffs: readUnsignedDecimal(
      record.totalInputDuffs,
      'DashPsbtSummary.totalInputDuffs',
      MAX_UINT64
    ),
    totalOutputDuffs: readUnsignedDecimal(
      record.totalOutputDuffs,
      'DashPsbtSummary.totalOutputDuffs',
      MAX_UINT64
    ),
    feeDuffs: readUnsignedDecimal(record.feeDuffs, 'DashPsbtSummary.feeDuffs', MAX_UINT64),
    inputs,
    outputs
  })
  if (
    summary.network !== params.network ||
    summary.inputCount !== inputs.length ||
    summary.outputCount !== outputs.length
  ) {
    throw new Error('Dash PSBT summary does not match its chain')
  }
  const owned = inputs.filter(input => input.walletOwned).length
  if (summary.signableInputCount !== owned) {
    throw new Error('Dash PSBT signable input count does not match')
  }
  const inputTotal = inputs.reduce((sum, input) => sum + BigInt(input.valueDuffs), 0n)
  const outputTotal = outputs.reduce((sum, output) => sum + BigInt(output.valueDuffs), 0n)
  if (
    inputTotal !== BigInt(summary.totalInputDuffs) ||
    outputTotal !== BigInt(summary.totalOutputDuffs) ||
    inputTotal - outputTotal !== BigInt(summary.feeDuffs)
  ) {
    throw new Error('Dash PSBT summary amounts do not balance')
  }
  return summary
}

export interface RawDashMessageSummary {
  readonly chainId: string
  readonly signer: string
  readonly messageHash: string
  readonly byteLength: number
  readonly utf8Preview: string
  readonly previewTruncated: boolean
}

export function parseRawDashMessageSummary(value: unknown): RawDashMessageSummary {
  const record = readRecord(value, 'DashMessageSummary')
  assertExactKeys(
    record,
    ['chainId', 'signer', 'messageHash', 'byteLength', 'utf8Preview', 'previewTruncated'],
    [],
    'DashMessageSummary'
  )
  const chainId = readString(record.chainId, 'DashMessageSummary.chainId', 64)
  readDashNetworkParams(chainId)
  const messageHash = readHex(record.messageHash, 'DashMessageSummary.messageHash', { bytes: 32 })
  return Object.freeze({
    chainId,
    signer: readString(record.signer, 'DashMessageSummary.signer', 128),
    messageHash,
    byteLength: readSafeInteger(record.byteLength, 'DashMessageSummary.byteLength', 4 * 1024),
    utf8Preview: readBoundedString(record.utf8Preview, 'DashMessageSummary.utf8Preview', 4 * 1024),
    previewTruncated: readBoolean(record.previewTruncated, 'DashMessageSummary.previewTruncated')
  })
}

export function parseRawSignedDashPsbt(value: unknown): {
  readonly psbt: string
  readonly unsignedTxid: string
  readonly signedInputIndexes: readonly number[]
} {
  const record = readRecord(value, 'SignedDashPsbt')
  assertExactKeys(record, ['psbt', 'unsignedTxid', 'signedInputIndexes'], [], 'SignedDashPsbt')
  const unsignedTxid = readString(record.unsignedTxid, 'SignedDashPsbt.unsignedTxid', 64)
  if (!/^[0-9a-f]{64}$/.test(unsignedTxid)) {
    throw new Error('SignedDashPsbt.unsignedTxid is invalid')
  }
  const psbt = readString(record.psbt, 'SignedDashPsbt.psbt', 2 * 1024 * 1024)
  return Object.freeze({
    psbt,
    unsignedTxid,
    signedInputIndexes: readArray(
      record.signedInputIndexes,
      'SignedDashPsbt.signedInputIndexes',
      (item, index) => readSafeInteger(item, `SignedDashPsbt.signedInputIndexes[${index}]`, 512),
      512
    )
  })
}

export function parseRawSignedDashMessage(value: unknown): {
  readonly signature: string
  readonly address: string
  readonly messageHash: string
} {
  const record = readRecord(value, 'SignedDashMessage')
  assertExactKeys(record, ['signature', 'address', 'messageHash'], [], 'SignedDashMessage')
  return Object.freeze({
    signature: readString(record.signature, 'SignedDashMessage.signature', 16_384),
    address: readString(record.address, 'SignedDashMessage.address', 128),
    messageHash: readHex(record.messageHash, 'SignedDashMessage.messageHash', { bytes: 32 })
  })
}

export function parseDashExportedPrivateKey(value: unknown): RawExportedPrivateKey {
  const record = readRecord(value, 'ExportedPrivateKey')
  assertExactKeys(record, ['chainId', 'format', 'privateKey', 'hex'], [], 'ExportedPrivateKey')
  const chainId = readString(record.chainId, 'ExportedPrivateKey.chainId', 64)
  const params = readDashNetworkParams(chainId)
  const format = readLiteral(record.format, ['wif'], 'ExportedPrivateKey.format')
  const privateKey = readString(record.privateKey, 'ExportedPrivateKey.privateKey', 256)
  const hex = readHex(record.hex, 'ExportedPrivateKey.hex', { bytes: 32 })
  const prefix = params.network === 'mainnet' ? 'X' : 'c'
  if (!new RegExp(`^${prefix}[1-9A-HJ-NP-Za-km-z]{51}$`).test(privateKey)) {
    throw new Error('Exported Dash private key does not match its chain')
  }
  return Object.freeze({ chainId, format, privateKey, hex })
}

export interface DashPrivateKeySession {
  readonly sessionId: number
  readonly kind: 'private_key'
  readonly chainFamily: 'dash'
  readonly dashNetwork: DashNetworkName
}

export function parseDashOrRawSession(value: unknown): RawSessionInfo | DashPrivateKeySession {
  const record = readRecord(value, 'Session')
  if (record.chainFamily === 'dash' || record.dashNetwork !== undefined) {
    assertExactKeys(record, ['sessionId', 'kind', 'chainFamily', 'dashNetwork'], [], 'Session')
    const sessionId = readSafeInteger(record.sessionId, 'Session.sessionId')
    if (sessionId === 0) throw new Error('Session.sessionId must be positive')
    const kind = readLiteral(record.kind, ['private_key'], 'Session.kind')
    return Object.freeze({
      sessionId,
      kind,
      chainFamily: readLiteral(record.chainFamily, ['dash'], 'Session.chainFamily'),
      dashNetwork: readLiteral(record.dashNetwork, ['mainnet', 'testnet'], 'Session.dashNetwork')
    })
  }
  return parseRawSessionInfo(value)
}
