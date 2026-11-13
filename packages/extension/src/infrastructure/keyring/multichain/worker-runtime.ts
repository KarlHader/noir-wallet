import {
  KeyringError,
  KEYRING_COMMAND_PAYLOAD_LIMITS,
  KEYRING_MAX_UNLOCKED_CREDENTIALS,
  createKeyringCommandFailure,
  createKeyringCommandSuccess,
  isKeyringCommandExpired,
  parseKeyringCommand,
  type KeyringCommand,
  type KeyringCommandBinding,
  type KeyringCommandResult,
  type KeyringErrorCode
} from '@/core/keyring/ports'
import type { SigningCommandId } from '@/core/keyring/ports/signing'
import {
  expectedQuantusWasmNetwork,
  requiresQuantusGenesisBinding,
  toQuantusWasmChainId
} from '@/core/chains/quantus'
import { getQuantusChainId } from '@/core/chains/registry'
import {
  adaptPreparedSigning,
  adaptSignedResult,
  parseSigningPreparePayload,
  type AdaptedPreparedSigning,
  type ParsedSigningPreparePayload,
  type PendingSigningKind
} from './signing-adapter'
import {
  assertExactKeys,
  assertRawBitcoinAccountMatches,
  assertRawEd25519AccountMatches,
  assertRawEvmAccountMatches,
  assertRawPearlAccountMatches,
  assertRawQuantusAccountMatches,
  globalPeaRequestJson,
  MAX_BIP32_INDEX,
  MAX_UINT64,
  parseRawBitcoinAccount,
  parseRawCreatedWallet,
  parseRawEncryptedVault,
  parseRawEd25519Account,
  parseRawEvmAccount,
  parseRawGlobalPeaAccount,
  parseRawExportedPrivateKey,
  parseRawPearlAccount,
  parseRawQuantusAccount,
  RAW_BITCOIN_ADDRESS_TYPES,
  RAW_QUANTUS_SCHEMES,
  readArray,
  readBoolean,
  readLiteral,
  readRecord,
  readSafeInteger,
  readString,
  type UnknownRecord,
  type RawBitcoinAddressType,
  type RawBitcoinNetwork,
  type RawDerivedAccount,
  type RawDerivedBitcoinAccount,
  type RawDerivedEd25519Account,
  type RawDerivedPearlAccount,
  type RawDerivedQuantusAccount,
  type RawDerivedPeaAccount,
  type RawPeaExecutionAccount,
  type RawPrivateKeyChainFamily,
  type RawQuantusScheme,
  type RawWalletEngine
} from './raw-wallet-engine'
import { bindMultichainVaultPassword } from './password-binding'
import { BITCOIN_CHAIN_IDS } from '@/core/chains/registry/chain-ids'
import type { RawDashAccount } from './dash-codecs'
import { parseDashOrRawSession } from './dash-codecs'
import {
  assertDashDerivationSession,
  assertDashSigningSession,
  confirmDashSigningRaw,
  dashChainIdForNetwork,
  dashExportRequest,
  deriveDashAccountsRaw,
  parseDashAccountDerivation,
  parseDashExportedPrivateKey,
  parseDerivedDashAccount,
  parseDerivedDashAccountBatch,
  prepareDashSigningRaw,
  verifyDashMessageRaw,
  type DashAccountDerivation,
  type DashSigningPreparePayload
} from './worker-dash-runtime'
import {
  assertStarknetPublicResult,
  parseRawStarknetAccount,
  parseStarknetAssembledDeploy,
  parseStarknetAssembledInvoke,
  parseStarknetExternalPrepareResult,
  readOptionalFeltList,
  readStarknetCalls,
  readStarknetChainId,
  readStarknetFelt,
  readStarknetResourceBounds,
  readStarknetSignature,
  type RawDerivedStarknetAccount
} from './starknet-codecs'
import { starknetSessionRequestJson } from './signing-adapter-starknet'

const DEFAULT_MAX_PENDING_SIGNING = 64
const DEFAULT_SIGNING_TTL_MS = 5 * 60_000

export interface MultichainRuntimeCapabilities {
  readonly abiVersion: string
  readonly sourceCommit: string
  readonly capabilities: readonly string[]
}

export interface MultichainWorkerRuntimeOptions {
  readonly now?: () => number
  readonly createSigningCommandId?: () => string
  readonly maxSessions?: number
  readonly maxPendingSigning?: number
  readonly signingTtlMs?: number
}

type ProductPearlNetwork = 'mainnet' | 'testnet'

function toWasmPearlNetwork(network: ProductPearlNetwork): 'mainnet' | 'testnet2' {
  return network === 'mainnet' ? 'mainnet' : 'testnet2'
}

function fromWasmPearlNetwork(network: 'mainnet' | 'testnet2'): ProductPearlNetwork {
  return network === 'mainnet' ? 'mainnet' : 'testnet'
}

interface CredentialSession {
  readonly keyDomainId: string
  readonly credentialGenerationId: string
  readonly globalUnlockEpoch: string
  readonly rawSessionId: number
  readonly kind: 'mnemonic' | 'private_key'
  readonly chainFamily?: RawPrivateKeyChainFamily | 'dash'
  readonly bitcoinNetwork?: RawBitcoinNetwork
  readonly pearlNetwork?: ProductPearlNetwork
  readonly dashNetwork?: 'mainnet' | 'testnet'
}

interface PendingSigning {
  readonly commandId: SigningCommandId
  readonly keyDomainId: string
  readonly credentialGenerationId: string
  readonly globalUnlockEpoch: string
  readonly rawSessionId: number
  readonly rawRequestId: number
  readonly kind: PendingSigningKind
  readonly account:
    | RawDerivedAccount
    | RawDerivedBitcoinAccount
    | RawDerivedPearlAccount
    | RawDerivedEd25519Account
    | RawDerivedQuantusAccount
    | RawDerivedPeaAccount
    | RawPeaExecutionAccount
    | RawDashAccount
    | RawDerivedStarknetAccount
  readonly expiresAt: number
}

function readPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new KeyringError('INVALID_COMMAND')
  }
  return resolved
}

function defaultSigningCommandId(): string {
  if (typeof crypto.randomUUID !== 'function') throw new KeyringError('INTERNAL_ERROR')
  return `signing-command:${crypto.randomUUID()}`
}

function parseSecret(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > KEYRING_COMMAND_PAYLOAD_LIMITS.maxStringBytes
  ) {
    throw new KeyringError('INVALID_CREDENTIAL')
  }
  return value
}

function parseInput<T>(parse: () => T, code: KeyringErrorCode = 'INVALID_COMMAND'): T {
  try {
    return parse()
  } catch (error) {
    if (error instanceof KeyringError) throw error
    throw new KeyringError(code)
  }
}

function parseMnemonic(value: unknown): string {
  const mnemonic = readString(value, 'mnemonic', 512)
  const words = mnemonic.split(' ')
  if ((words.length !== 12 && words.length !== 24) || words.some(word => word.length === 0)) {
    throw new KeyringError('INVALID_CREDENTIAL')
  }
  return mnemonic
}

function requireCredentialBinding(
  command: KeyringCommand
): Extract<KeyringCommandBinding, { kind: 'credential' }> {
  if (command.binding.kind !== 'credential') throw new KeyringError('INVALID_COMMAND')
  return command.binding
}

function matchesBinding(
  value: CredentialSession | PendingSigning,
  binding: Extract<KeyringCommandBinding, { kind: 'credential' }>
): boolean {
  return (
    value.keyDomainId === binding.keyDomainId &&
    value.credentialGenerationId === binding.credentialGenerationId &&
    value.globalUnlockEpoch === binding.globalUnlockEpoch
  )
}

function readSigningCommandId(value: unknown): SigningCommandId {
  const parsed = readString(value, 'signingCommandId', 128)
  if (!parsed.startsWith('signing-command:')) throw new KeyringError('INVALID_COMMAND')
  return parsed as SigningCommandId
}

function isRawError(value: unknown): value is { readonly code: string; readonly message: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    Object.keys(record).length === 2 &&
    typeof record.code === 'string' &&
    typeof record.message === 'string'
  )
}

function mapRawError(error: unknown, operation: KeyringCommand['operation']): KeyringError {
  if (!isRawError(error)) return new KeyringError('INTERNAL_ERROR')
  const inputCode: KeyringErrorCode =
    operation === 'signing.prepare' ? 'UNSUPPORTED_PAYLOAD' : 'INVALID_COMMAND'
  const mappings: Partial<Record<string, KeyringErrorCode>> = {
    invalid_mnemonic: 'INVALID_CREDENTIAL',
    invalid_private_key: 'INVALID_CREDENTIAL',
    invalid_word_count: 'INVALID_CREDENTIAL',
    invalid_chain_id: 'UNSUPPORTED_CHAIN',
    unsupported_chain: 'UNSUPPORTED_CHAIN',
    key_scope_mismatch: 'UNSUPPORTED_CHAIN',
    invalid_derivation_path: inputCode,
    invalid_input: inputCode,
    invalid_password_or_vault: 'INVALID_CREDENTIAL',
    unsupported_vault: 'INVALID_CREDENTIAL',
    session_not_found: 'CREDENTIAL_LOCKED',
    request_not_found: 'SIGNING_COMMAND_NOT_FOUND',
    wrong_request_type: 'SIGNING_COMMAND_CONFLICT',
    crypto_error: 'INTERNAL_ERROR',
    serialization_error: 'INTERNAL_ERROR',
    random_error: 'INTERNAL_ERROR'
  }
  const code: KeyringErrorCode = mappings[error.code] ?? 'INTERNAL_ERROR'
  const mapped = new KeyringError(code)
  // Preserve sanitized engine detail for Pearl prepare failures without changing the
  // stable KeyringError envelope used across the worker protocol.
  if (
    operation === 'signing.prepare' &&
    typeof error.message === 'string' &&
    /invalid Pearl PSBT:/i.test(error.message)
  ) {
    Object.defineProperty(mapped, 'detail', {
      value: error.message.replace(/^invalid input:\s*/i, '').trim(),
      enumerable: false
    })
  }
  return mapped
}

function callRaw<T>(
  command: KeyringCommand,
  operation: () => unknown,
  parse: (value: unknown) => T
): T {
  let raw: unknown
  try {
    raw = operation()
  } catch (error) {
    throw mapRawError(error, command.operation)
  }
  try {
    return parse(raw)
  } catch {
    throw new KeyringError('INVALID_RESPONSE')
  }
}

function requireDashNetwork(value: 'mainnet' | 'testnet' | undefined): 'mainnet' | 'testnet' {
  if (value !== 'mainnet' && value !== 'testnet') throw new KeyringError('INVALID_CREDENTIAL')
  return value
}

function isExactBitcoinChainId(chainId: string): boolean {
  return chainId === BITCOIN_CHAIN_IDS.mainnet || chainId === BITCOIN_CHAIN_IDS.testnet
}

function parseAccountDerivation(value: unknown):
  | {
      readonly family: 'pea'
      readonly addressIndex: number
    }
  | {
      readonly family: 'evm'
      readonly chainId: string
      readonly addressIndex: number
    }
  | {
      readonly family: 'bitcoin'
      readonly batch: false
      readonly chainId: string
      readonly addressType: RawBitcoinAddressType
      readonly accountIndex: number
      readonly change: boolean
      readonly addressIndex: number
    }
  | {
      readonly family: 'bitcoin'
      readonly batch: true
      readonly chainId: string
      readonly addressType: RawBitcoinAddressType
      readonly accountIndex: number
      readonly change: boolean
      readonly startAddressIndex: number
      readonly count: number
    }
  | {
      readonly family: 'pearl'
      readonly batch: false
      readonly chainId: string
      readonly accountIndex: number
      readonly change: boolean
      readonly addressIndex: number
    }
  | {
      readonly family: 'pearl'
      readonly batch: true
      readonly chainId: string
      readonly accountIndex: number
      readonly change: boolean
      readonly startAddressIndex: number
      readonly count: number
    }
  | {
      readonly family: 'solana'
      readonly chainId: string
      readonly accountIndex: number
    }
  | {
      readonly family: 'quantus'
      readonly batch: false
      readonly chainId: string
      readonly scheme: RawQuantusScheme
      readonly accountIndex: number
      readonly change: boolean
      readonly addressIndex: number
    }
  | {
      readonly family: 'quantus'
      readonly batch: true
      readonly chainId: string
      readonly scheme: RawQuantusScheme
      readonly accountIndex: number
      readonly change: boolean
      readonly startAddressIndex: number
      readonly count: number
    }
  | {
      readonly family: 'near'
      readonly chainId: string
      readonly accountIndex: number
    }
  | {
      readonly family: 'starknet'
      readonly chainId: string
      readonly accountIndex: number
      readonly addressIndex: number
      readonly classHash: string
    }
  | DashAccountDerivation {
  const record = readRecord(value, 'account.derive-public payload')
  const family = readLiteral(
    record.family,
    ['evm', 'pea', 'bitcoin', 'dash', 'solana', 'near', 'pearl', 'quantus', 'starknet'],
    'account family'
  )
  if (family === 'quantus') {
    const batch = !Object.prototype.hasOwnProperty.call(record, 'addressIndex')
    assertExactKeys(
      record,
      batch
        ? ['family', 'chainId', 'scheme', 'accountIndex', 'change', 'startAddressIndex', 'count']
        : ['family', 'chainId', 'scheme', 'accountIndex', 'change', 'addressIndex'],
      [],
      'derive payload'
    )
    const chainId = readString(record.chainId, 'chainId', 64)
    if (chainId !== getQuantusChainId('mainnet') && chainId !== getQuantusChainId('testnet')) {
      throw new KeyringError('UNSUPPORTED_CHAIN')
    }
    const common = {
      family,
      chainId,
      scheme: readLiteral(record.scheme, RAW_QUANTUS_SCHEMES, 'Quantus scheme'),
      accountIndex: readSafeInteger(record.accountIndex, 'accountIndex', MAX_BIP32_INDEX),
      change: readBoolean(record.change, 'change')
    } as const
    if (!batch) {
      return Object.freeze({
        ...common,
        batch: false as const,
        addressIndex: readSafeInteger(record.addressIndex, 'addressIndex', MAX_BIP32_INDEX)
      })
    }
    const startAddressIndex = readSafeInteger(
      record.startAddressIndex,
      'startAddressIndex',
      MAX_BIP32_INDEX
    )
    const count = readSafeInteger(record.count, 'count', 1_000)
    if (count === 0 || startAddressIndex > MAX_BIP32_INDEX - (count - 1)) {
      throw new Error('Invalid Quantus derivation batch')
    }
    return Object.freeze({ ...common, batch: true as const, startAddressIndex, count })
  }
  if (family === 'evm') {
    assertExactKeys(record, ['family', 'chainId', 'addressIndex'], [], 'derive payload')
    const chainId = readString(record.chainId, 'chainId', 64)
    if (!/^eip155:(?:0|[1-9][0-9]*)$/.test(chainId)) {
      throw new KeyringError('UNSUPPORTED_CHAIN')
    }
    if (BigInt(chainId.slice('eip155:'.length)) > MAX_UINT64) {
      throw new KeyringError('UNSUPPORTED_CHAIN')
    }
    return Object.freeze({
      family,
      chainId,
      addressIndex: readSafeInteger(record.addressIndex, 'addressIndex', MAX_BIP32_INDEX)
    })
  }
  if (family === 'solana') {
    assertExactKeys(record, ['family', 'chainId', 'accountIndex'], [], 'derive payload')
    const chainId = readString(record.chainId, 'chainId', 64)
    if (!/^solana:[1-9A-HJ-NP-Za-km-z]{32}$/.test(chainId)) {
      throw new KeyringError('UNSUPPORTED_CHAIN')
    }
    return Object.freeze({
      family,
      chainId,
      accountIndex: readSafeInteger(record.accountIndex, 'accountIndex', MAX_BIP32_INDEX)
    })
  }
  if (family === 'near') {
    assertExactKeys(record, ['family', 'chainId', 'accountIndex'], [], 'derive payload')
    const chainId = readString(record.chainId, 'chainId', 64)
    if (chainId !== 'near:mainnet' && chainId !== 'near:testnet') {
      throw new KeyringError('UNSUPPORTED_CHAIN')
    }
    return Object.freeze({
      family,
      chainId,
      accountIndex: readSafeInteger(record.accountIndex, 'accountIndex', MAX_BIP32_INDEX)
    })
  }
  if (family === 'starknet') {
    assertExactKeys(
      record,
      ['family', 'chainId', 'accountIndex', 'addressIndex', 'classHash'],
      [],
      'derive payload'
    )
    const chainId = readString(record.chainId, 'chainId', 64)
    if (chainId !== 'starknet:SN_MAIN' && chainId !== 'starknet:SN_SEPOLIA') {
      throw new KeyringError('UNSUPPORTED_CHAIN')
    }
    return Object.freeze({
      family,
      chainId,
      accountIndex: readSafeInteger(record.accountIndex, 'accountIndex', MAX_BIP32_INDEX),
      addressIndex: readSafeInteger(record.addressIndex, 'addressIndex', MAX_BIP32_INDEX),
      classHash: readStarknetFelt(record.classHash, 'classHash')
    })
  }
  if (family === 'pea') {
    assertExactKeys(record, ['family', 'addressIndex'], [], 'derive payload')
    return Object.freeze({
      family,
      addressIndex: readSafeInteger(record.addressIndex, 'addressIndex', MAX_BIP32_INDEX)
    })
  }
  if (family === 'pearl') {
    const batch = !Object.prototype.hasOwnProperty.call(record, 'addressIndex')
    assertExactKeys(
      record,
      batch
        ? ['family', 'chainId', 'accountIndex', 'change', 'startAddressIndex', 'count']
        : ['family', 'chainId', 'accountIndex', 'change', 'addressIndex'],
      [],
      'derive payload'
    )
    const chainId = readString(record.chainId, 'chainId', 64)
    if (
      chainId !== 'bip122:a18d3093b7ff618f0cdd073fa3d10374' &&
      chainId !== 'bip122:b0c86d0cd8825f4d72260d2de46f4704'
    ) {
      throw new KeyringError('UNSUPPORTED_CHAIN')
    }
    if (batch) {
      return Object.freeze({
        family,
        batch: true as const,
        chainId,
        accountIndex: readSafeInteger(record.accountIndex, 'accountIndex', MAX_BIP32_INDEX),
        change: readBoolean(record.change, 'change'),
        startAddressIndex: readSafeInteger(
          record.startAddressIndex,
          'startAddressIndex',
          MAX_BIP32_INDEX
        ),
        count: readSafeInteger(record.count, 'count', 1_000)
      })
    }
    return Object.freeze({
      family,
      batch: false as const,
      chainId,
      accountIndex: readSafeInteger(record.accountIndex, 'accountIndex', MAX_BIP32_INDEX),
      change: readBoolean(record.change, 'change'),
      addressIndex: readSafeInteger(record.addressIndex, 'addressIndex', MAX_BIP32_INDEX)
    })
  }
  if (family === 'dash') return parseDashAccountDerivation(record)
  if (family !== 'bitcoin') throw new KeyringError('UNSUPPORTED_CHAIN')
  const batch = !Object.prototype.hasOwnProperty.call(record, 'addressIndex')
  assertExactKeys(
    record,
    batch
      ? ['family', 'chainId', 'addressType', 'accountIndex', 'change', 'startAddressIndex', 'count']
      : ['family', 'chainId', 'addressType', 'accountIndex', 'change', 'addressIndex'],
    [],
    'derive payload'
  )
  const chainId = readString(record.chainId, 'chainId', 64)
  if (!isExactBitcoinChainId(chainId)) {
    throw new KeyringError('UNSUPPORTED_CHAIN')
  }
  const common = {
    family,
    chainId,
    addressType: readLiteral(record.addressType, RAW_BITCOIN_ADDRESS_TYPES, 'addressType'),
    accountIndex: readSafeInteger(record.accountIndex, 'accountIndex', MAX_BIP32_INDEX),
    change: readBoolean(record.change, 'change')
  } as const
  if (!batch) {
    return Object.freeze({
      ...common,
      batch: false as const,
      addressIndex: readSafeInteger(record.addressIndex, 'addressIndex', MAX_BIP32_INDEX)
    })
  }
  const startAddressIndex = readSafeInteger(
    record.startAddressIndex,
    'startAddressIndex',
    MAX_BIP32_INDEX
  )
  const count = readSafeInteger(record.count, 'count', 1_000)
  if (count === 0 || startAddressIndex > MAX_BIP32_INDEX - (count - 1)) {
    throw new Error('Invalid Bitcoin derivation batch')
  }
  return Object.freeze({ ...common, batch: true as const, startAddressIndex, count })
}

function publicAccount(
  chainId: string,
  account:
    | RawDerivedAccount
    | RawDerivedBitcoinAccount
    | RawDerivedPearlAccount
    | RawDerivedQuantusAccount
    | RawDerivedEd25519Account
    | RawDashAccount
    | RawDerivedStarknetAccount,
  purpose: 'identity' | 'receive' | 'change'
) {
  return Object.freeze({
    chainId,
    derivation: Object.freeze({
      scheme: account.derivationScheme,
      path: account.derivationPath
    }),
    identity: Object.freeze({ kind: 'account-identifier', value: account.address }),
    addresses: Object.freeze([
      Object.freeze({
        value: account.address,
        scheme: account.addressScheme,
        purpose,
        derivation: Object.freeze({
          scheme: account.derivationScheme,
          path: account.derivationPath
        })
      })
    ]),
    publicKey: account.publicKey,
    ...('masterFingerprint' in account
      ? {
          masterFingerprint: account.masterFingerprint,
          scriptPubKey: account.scriptPubKey,
          ...('redeemScript' in account && account.redeemScript !== undefined
            ? { redeemScript: account.redeemScript }
            : {})
        }
      : {}),
    ...('classHash' in account
      ? { classHash: account.classHash, implementation: account.implementation }
      : {})
  })
}

const STARKNET_INVOKE_OPTIONAL_FIELDS = Object.freeze([
  'accountAddress',
  'classHash',
  'salt',
  'implementation',
  'tip',
  'nonceDataAvailabilityMode',
  'feeDataAvailabilityMode',
  'paymasterData',
  'accountDeploymentData',
  'proofFacts',
  'proof'
])

const STARKNET_DEPLOY_OPTIONAL_FIELDS = Object.freeze([
  'accountAddress',
  'classHash',
  'salt',
  'implementation',
  'tip',
  'nonceDataAvailabilityMode',
  'feeDataAvailabilityMode',
  'paymasterData'
])

function readOptionalStarknetFelt(value: unknown, label: string): void {
  if (value !== undefined) readStarknetFelt(value, label)
}

function readOptionalStarknetAccountSelectors(payload: UnknownRecord): void {
  readOptionalStarknetFelt(payload.classHash, 'classHash')
  readOptionalStarknetFelt(payload.salt, 'salt')
  if (payload.implementation !== undefined) {
    readLiteral(payload.implementation, ['open_zeppelin', 'argent_v04'], 'implementation')
  }
}

function readOptionalStarknetFeeFields(payload: UnknownRecord, includeInvokeFields: boolean): void {
  if (payload.tip !== undefined) {
    const tip = readString(payload.tip, 'tip', 32)
    if (!/^(0|[1-9][0-9]*)$/.test(tip)) throw new Error('tip must be a decimal amount')
  }
  if (payload.nonceDataAvailabilityMode !== undefined) {
    readLiteral(payload.nonceDataAvailabilityMode, ['l1', 'l2'], 'nonceDataAvailabilityMode')
  }
  if (payload.feeDataAvailabilityMode !== undefined) {
    readLiteral(payload.feeDataAvailabilityMode, ['l1', 'l2'], 'feeDataAvailabilityMode')
  }
  if (payload.paymasterData !== undefined) {
    readOptionalFeltList(payload.paymasterData, 'paymasterData')
  }
  if (!includeInvokeFields) return
  if (payload.accountDeploymentData !== undefined) {
    readOptionalFeltList(payload.accountDeploymentData, 'accountDeploymentData')
  }
  if (payload.proofFacts !== undefined) readOptionalFeltList(payload.proofFacts, 'proofFacts')
  if (payload.proof !== undefined) readString(payload.proof, 'proof', 131_072)
}

function readStarknetExternalInvoke(payload: UnknownRecord): void {
  readStarknetChainId(payload.chainId)
  readStarknetFelt(payload.publicKey, 'publicKey')
  readOptionalStarknetFelt(payload.accountAddress, 'accountAddress')
  readOptionalStarknetAccountSelectors(payload)
  readStarknetCalls(payload.calls)
  readStarknetFelt(payload.nonce, 'nonce')
  readStarknetResourceBounds(payload.resourceBounds)
  readOptionalStarknetFeeFields(payload, true)
}

function readStarknetExternalDeploy(payload: UnknownRecord): void {
  readStarknetChainId(payload.chainId)
  readStarknetFelt(payload.publicKey, 'publicKey')
  readOptionalStarknetFelt(payload.accountAddress, 'accountAddress')
  readOptionalStarknetAccountSelectors(payload)
  readStarknetFelt(payload.nonce, 'nonce')
  readStarknetResourceBounds(payload.resourceBounds)
  readOptionalStarknetFeeFields(payload, false)
}

export class MultichainWorkerRuntime {
  private readonly now: () => number
  private readonly createSigningCommandId: () => string
  private readonly maxSessions: number
  private readonly maxPendingSigning: number
  private readonly signingTtlMs: number
  private readonly sessions = new Map<string, CredentialSession>()
  private readonly pending = new Map<SigningCommandId, PendingSigning>()
  private disposed = false

  constructor(
    private readonly engine: RawWalletEngine,
    private readonly runtimeCapabilities: MultichainRuntimeCapabilities,
    options: MultichainWorkerRuntimeOptions = {}
  ) {
    this.now = options.now ?? Date.now
    this.createSigningCommandId = options.createSigningCommandId ?? defaultSigningCommandId
    this.maxSessions = readPositiveInteger(
      options.maxSessions,
      KEYRING_MAX_UNLOCKED_CREDENTIALS,
      KEYRING_MAX_UNLOCKED_CREDENTIALS
    )
    this.maxPendingSigning = readPositiveInteger(
      options.maxPendingSigning,
      DEFAULT_MAX_PENDING_SIGNING,
      1_024
    )
    this.signingTtlMs = readPositiveInteger(
      options.signingTtlMs,
      DEFAULT_SIGNING_TTL_MS,
      30 * 60_000
    )
  }

  async execute(input: unknown): Promise<KeyringCommandResult> {
    const command = parseKeyringCommand(input)
    if (this.disposed) return createKeyringCommandFailure(command.commandId, 'WORKER_UNAVAILABLE')
    if (isKeyringCommandExpired(command, this.now())) {
      return createKeyringCommandFailure(command.commandId, 'COMMAND_TIMEOUT')
    }
    if (command.operation !== 'signing.confirm') this.purgeExpiredSigning()

    try {
      const value = await this.executeCommand(command)
      if (isKeyringCommandExpired(command, this.now())) {
        return createKeyringCommandFailure(command.commandId, 'COMMAND_TIMEOUT')
      }
      return createKeyringCommandSuccess(command.commandId, value)
    } catch (error) {
      const code = error instanceof KeyringError ? error.code : 'INTERNAL_ERROR'
      return createKeyringCommandFailure(command.commandId, code)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.lockAll()
    this.engine.free()
  }

  private async executeCommand(command: KeyringCommand): Promise<unknown> {
    switch (command.operation) {
      case 'capabilities.get':
        parseInput(() => assertExactKeys(readRecord(command.payload, 'payload'), [], [], 'payload'))
        return Object.freeze({
          abiVersion: this.runtimeCapabilities.abiVersion,
          sourceCommit: this.runtimeCapabilities.sourceCommit,
          capabilities: Object.freeze([...this.runtimeCapabilities.capabilities])
        })
      case 'credential.create':
        return this.createCredential(command)
      case 'credential.import':
        return this.importCredential(command)
      case 'credential.import-private-key':
        return this.importPrivateKey(command)
      case 'credential.export-private-key':
        return this.exportPrivateKey(command)
      case 'credential.rewrap-private-key':
        return this.rewrapPrivateKey(command)
      case 'credential.unlock':
        return this.unlockCredential(command)
      case 'credential.lock':
        return this.lockCredential(command)
      case 'credential.lock-all':
        parseInput(() => assertExactKeys(readRecord(command.payload, 'payload'), [], [], 'payload'))
        this.lockAll()
        return Object.freeze({ state: 'locked' })
      case 'credential.get-state':
        return this.getCredentialState(command)
      case 'account.derive-public':
        return this.derivePublicAccount(command)
      case 'signing.prepare':
        return this.prepareSigning(command)
      case 'signing.confirm':
        return this.confirmSigning(command)
      case 'signing.verify':
        return this.verifySigning(command)
      case 'signing.cancel':
        return this.cancelSigning(command)
      case 'signing.cancel-all':
        return this.cancelAllSigning(command)
      case 'command.cancel':
        return this.cancelProductCommand(command)
      case 'starknet.compute-address':
      case 'starknet.prepare-invoke-external':
      case 'starknet.assemble-invoke-external':
      case 'starknet.prepare-deploy-external':
      case 'starknet.assemble-deploy-external':
      case 'starknet.hash-typed-data':
      case 'starknet.verify-signature':
        return this.executeStarknetPublic(command)
      case 'identity.get-public':
        throw new KeyringError('UNSUPPORTED_OPERATION')
    }
  }

  private executeStarknetPublic(command: KeyringCommand) {
    if (command.binding.kind !== 'unbound') throw new KeyringError('INVALID_COMMAND')
    const requestJson = parseInput(() => {
      const payload = readRecord(command.payload, 'Starknet public payload')
      for (const key of Object.keys(payload)) {
        if (key === 'sessionId' || key === 'privateKey' || key === 'seed' || key === 'mnemonic') {
          throw new Error('Starknet public payload contains a secret field')
        }
      }
      switch (command.operation) {
        case 'starknet.compute-address':
          assertExactKeys(
            payload,
            ['chainId', 'publicKey'],
            ['classHash', 'salt', 'implementation'],
            'compute address'
          )
          readStarknetChainId(payload.chainId)
          readStarknetFelt(payload.publicKey, 'publicKey')
          readOptionalStarknetAccountSelectors(payload)
          break
        case 'starknet.prepare-invoke-external':
          assertExactKeys(
            payload,
            ['chainId', 'publicKey', 'calls', 'nonce', 'resourceBounds'],
            STARKNET_INVOKE_OPTIONAL_FIELDS,
            'prepare invoke'
          )
          readStarknetExternalInvoke(payload)
          break
        case 'starknet.assemble-invoke-external':
          assertExactKeys(
            payload,
            ['chainId', 'publicKey', 'calls', 'nonce', 'resourceBounds', 'signature'],
            STARKNET_INVOKE_OPTIONAL_FIELDS,
            'assemble invoke'
          )
          readStarknetExternalInvoke(payload)
          readStarknetSignature(payload.signature)
          break
        case 'starknet.prepare-deploy-external':
          assertExactKeys(
            payload,
            ['chainId', 'publicKey', 'nonce', 'resourceBounds'],
            STARKNET_DEPLOY_OPTIONAL_FIELDS,
            'prepare deploy'
          )
          readStarknetExternalDeploy(payload)
          break
        case 'starknet.assemble-deploy-external':
          assertExactKeys(
            payload,
            ['chainId', 'publicKey', 'nonce', 'resourceBounds', 'signature'],
            STARKNET_DEPLOY_OPTIONAL_FIELDS,
            'assemble deploy'
          )
          readStarknetExternalDeploy(payload)
          readStarknetSignature(payload.signature)
          break
        case 'starknet.hash-typed-data':
          assertExactKeys(
            payload,
            ['chainId', 'accountAddress', 'publicKey', 'typedData'],
            ['classHash', 'salt', 'implementation'],
            'typed data hash'
          )
          readStarknetChainId(payload.chainId)
          readStarknetFelt(payload.accountAddress, 'accountAddress')
          readStarknetFelt(payload.publicKey, 'publicKey')
          readString(payload.typedData, 'typedData', 65_536)
          readOptionalStarknetAccountSelectors(payload)
          break
        case 'starknet.verify-signature':
          assertExactKeys(payload, ['hash', 'publicKey', 'signature'], [], 'verify signature')
          readStarknetFelt(payload.hash, 'hash')
          readStarknetFelt(payload.publicKey, 'publicKey')
          readStarknetSignature(payload.signature)
          break
        default:
          throw new KeyringError('UNSUPPORTED_OPERATION')
      }
      return JSON.stringify(payload)
    }, 'INVALID_COMMAND')
    return callRaw(
      command,
      () => {
        switch (command.operation) {
          case 'starknet.compute-address':
            return this.engine.computeStarknetAccountAddress(requestJson)
          case 'starknet.prepare-invoke-external':
            return this.engine.prepareStarknetInvokeExternal(requestJson)
          case 'starknet.assemble-invoke-external':
            return this.engine.assembleStarknetInvokeExternal(requestJson)
          case 'starknet.prepare-deploy-external':
            return this.engine.prepareStarknetDeployAccountExternal(requestJson)
          case 'starknet.assemble-deploy-external':
            return this.engine.assembleStarknetDeployAccountExternal(requestJson)
          case 'starknet.hash-typed-data':
            return this.engine.hashStarknetTypedData(requestJson)
          case 'starknet.verify-signature':
            return this.engine.verifyStarknetSignature(requestJson)
          default:
            throw new KeyringError('UNSUPPORTED_OPERATION')
        }
      },
      value => {
        switch (command.operation) {
          case 'starknet.compute-address':
            assertStarknetPublicResult(value)
            return parseRawStarknetAccount(value)
          case 'starknet.prepare-invoke-external':
          case 'starknet.prepare-deploy-external':
            return parseStarknetExternalPrepareResult(value)
          case 'starknet.assemble-invoke-external':
            return parseStarknetAssembledInvoke(value)
          case 'starknet.assemble-deploy-external':
            return parseStarknetAssembledDeploy(value)
          case 'starknet.verify-signature': {
            const verified = assertStarknetPublicResult(value)
            if (typeof verified !== 'boolean') {
              throw new Error('Starknet signature verification must be boolean')
            }
            return verified
          }
          default:
            return assertStarknetPublicResult(value)
        }
      }
    )
  }

  private async createCredential(command: KeyringCommand) {
    requireCredentialBinding(command)
    const { wordCount, password } = parseInput(() => {
      const payload = readRecord(command.payload, 'credential.create payload')
      assertExactKeys(payload, ['wordCount', 'password'], [], 'credential.create payload')
      return {
        wordCount: readLiteral(payload.wordCount, [12, 24], 'wordCount'),
        password: parseSecret(payload.password)
      }
    })
    const vaultPassword = await bindMultichainVaultPassword(password)
    return callRaw(
      command,
      () => this.engine.createWallet(wordCount, vaultPassword, ''),
      parseRawCreatedWallet
    )
  }

  private async importCredential(command: KeyringCommand) {
    requireCredentialBinding(command)
    const { mnemonic, password } = parseInput(() => {
      const payload = readRecord(command.payload, 'credential.import payload')
      assertExactKeys(payload, ['mnemonic', 'password'], [], 'credential.import payload')
      return {
        mnemonic: parseMnemonic(payload.mnemonic),
        password: parseSecret(payload.password)
      }
    }, 'INVALID_CREDENTIAL')
    const vaultPassword = await bindMultichainVaultPassword(password)
    return callRaw(
      command,
      () => this.engine.importWallet(mnemonic, vaultPassword, ''),
      parseRawEncryptedVault
    )
  }

  private async importPrivateKey(command: KeyringCommand) {
    requireCredentialBinding(command)
    const payload = parseInput(() => {
      const value = readRecord(command.payload, 'credential.import-private-key payload')
      assertExactKeys(
        value,
        ['privateKey', 'password', 'chainFamily'],
        ['bitcoinNetwork', 'pearlNetwork', 'dashNetwork'],
        'credential.import-private-key payload'
      )
      const chainFamily = readLiteral(
        value.chainFamily,
        ['eip155', 'bip122', 'solana', 'near', 'pearl', 'dash'],
        'chainFamily'
      )
      const bitcoinNetwork =
        value.bitcoinNetwork === undefined
          ? undefined
          : readLiteral(value.bitcoinNetwork, ['mainnet', 'testnet'], 'bitcoinNetwork')
      const pearlNetwork =
        value.pearlNetwork === undefined
          ? undefined
          : readLiteral(value.pearlNetwork, ['mainnet', 'testnet'], 'pearlNetwork')
      const dashNetwork =
        value.dashNetwork === undefined
          ? undefined
          : readLiteral(value.dashNetwork, ['mainnet', 'testnet'], 'dashNetwork')
      if (
        (chainFamily !== 'bip122' && bitcoinNetwork !== undefined) ||
        (chainFamily === 'bip122' && bitcoinNetwork === undefined) ||
        (chainFamily !== 'pearl' && pearlNetwork !== undefined) ||
        (chainFamily === 'pearl' && pearlNetwork === undefined) ||
        (chainFamily !== 'dash' && dashNetwork !== undefined) ||
        (chainFamily === 'dash' && dashNetwork === undefined)
      ) {
        throw new KeyringError('INVALID_CREDENTIAL')
      }
      return Object.freeze({
        privateKey: parseSecret(value.privateKey),
        password: parseSecret(value.password),
        chainFamily,
        ...(bitcoinNetwork === undefined ? {} : { bitcoinNetwork }),
        ...(pearlNetwork === undefined ? {} : { pearlNetwork }),
        ...(dashNetwork === undefined ? {} : { dashNetwork })
      })
    }, 'INVALID_CREDENTIAL')
    const vaultPassword = await bindMultichainVaultPassword(payload.password)
    return callRaw(
      command,
      () =>
        this.engine.importPrivateKey(
          {
            privateKey: payload.privateKey,
            chainFamily: payload.chainFamily,
            ...(payload.bitcoinNetwork === undefined
              ? {}
              : { bitcoinNetwork: payload.bitcoinNetwork }),
            ...(payload.pearlNetwork === undefined
              ? {}
              : { pearlNetwork: toWasmPearlNetwork(payload.pearlNetwork) }),
            ...(payload.dashNetwork === undefined ? {} : { dashNetwork: payload.dashNetwork })
          },
          vaultPassword
        ),
      parseRawEncryptedVault
    )
  }

  private async exportPrivateKey(command: KeyringCommand) {
    const binding = requireCredentialBinding(command)
    const session = this.requireSession(binding)
    const payload = parseInput(() => {
      const value = readRecord(command.payload, 'credential.export-private-key payload')
      assertExactKeys(
        value,
        ['vault', 'password', 'chainId', 'addressIndex'],
        ['addressType', 'accountIndex', 'change'],
        'credential.export-private-key payload'
      )
      const chainId = readString(value.chainId, 'chainId', 64)
      const addressIndex = readSafeInteger(value.addressIndex, 'addressIndex', MAX_BIP32_INDEX)
      if (chainId.startsWith('eip155:')) {
        if (
          value.addressType !== undefined ||
          value.accountIndex !== undefined ||
          value.change !== undefined
        ) {
          throw new KeyringError('INVALID_COMMAND')
        }
        return Object.freeze({
          vault: parseRawEncryptedVault(value.vault),
          password: parseSecret(value.password),
          request: Object.freeze({ chainId, addressIndex })
        })
      }
      if (chainId.startsWith('solana:') || chainId.startsWith('near:')) {
        if (value.addressType !== undefined || value.change !== undefined || addressIndex !== 0) {
          throw new KeyringError('INVALID_COMMAND')
        }
        return Object.freeze({
          vault: parseRawEncryptedVault(value.vault),
          password: parseSecret(value.password),
          request: Object.freeze({
            chainId,
            accountIndex: readSafeInteger(value.accountIndex, 'accountIndex', MAX_BIP32_INDEX)
          })
        })
      }
      if (
        chainId === 'bip122:a18d3093b7ff618f0cdd073fa3d10374' ||
        chainId === 'bip122:b0c86d0cd8825f4d72260d2de46f4704'
      ) {
        if (value.addressType !== undefined) throw new KeyringError('INVALID_COMMAND')
        return Object.freeze({
          vault: parseRawEncryptedVault(value.vault),
          password: parseSecret(value.password),
          request: Object.freeze({
            chainId,
            accountIndex: readSafeInteger(value.accountIndex, 'accountIndex', MAX_BIP32_INDEX),
            change: readBoolean(value.change, 'change'),
            addressIndex
          })
        })
      }
      if (
        chainId === dashChainIdForNetwork('mainnet') ||
        chainId === dashChainIdForNetwork('testnet')
      ) {
        if (value.addressType !== undefined) throw new KeyringError('INVALID_COMMAND')
        const accountIndex = readSafeInteger(value.accountIndex, 'accountIndex', MAX_BIP32_INDEX)
        const change = readBoolean(value.change, 'change')
        if (change || addressIndex !== 0) throw new KeyringError('INVALID_COMMAND')
        return Object.freeze({
          vault: parseRawEncryptedVault(value.vault),
          password: parseSecret(value.password),
          request: dashExportRequest(chainId, accountIndex),
          dash: true as const
        })
      }
      if (!isExactBitcoinChainId(chainId)) throw new KeyringError('UNSUPPORTED_CHAIN')
      return Object.freeze({
        vault: parseRawEncryptedVault(value.vault),
        password: parseSecret(value.password),
        request: Object.freeze({
          chainId,
          addressType: readLiteral(value.addressType, RAW_BITCOIN_ADDRESS_TYPES, 'addressType'),
          accountIndex: readSafeInteger(value.accountIndex, 'accountIndex', MAX_BIP32_INDEX),
          change: readBoolean(value.change, 'change'),
          addressIndex
        })
      })
    }, 'INVALID_CREDENTIAL')
    const vaultPassword = await bindMultichainVaultPassword(payload.password)
    return callRaw(
      command,
      () =>
        this.engine.exportPrivateKey(
          session.rawSessionId,
          payload.vault,
          vaultPassword,
          payload.request
        ),
      value =>
        'dash' in payload ? parseDashExportedPrivateKey(value) : parseRawExportedPrivateKey(value)
    )
  }

  private async rewrapPrivateKey(command: KeyringCommand) {
    requireCredentialBinding(command)
    const payload = parseInput(() => {
      const value = readRecord(command.payload, 'credential.rewrap-private-key payload')
      assertExactKeys(
        value,
        ['vault', 'currentPassword', 'newPassword', 'chainFamily'],
        ['bitcoinNetwork', 'pearlNetwork', 'dashNetwork'],
        'credential.rewrap-private-key payload'
      )
      const chainFamily = readLiteral(
        value.chainFamily,
        ['eip155', 'bip122', 'solana', 'near', 'pearl', 'dash'],
        'chainFamily'
      )
      const bitcoinNetwork =
        value.bitcoinNetwork === undefined
          ? undefined
          : readLiteral(value.bitcoinNetwork, ['mainnet', 'testnet'], 'bitcoinNetwork')
      const pearlNetwork =
        value.pearlNetwork === undefined
          ? undefined
          : readLiteral(value.pearlNetwork, ['mainnet', 'testnet'], 'pearlNetwork')
      const dashNetwork =
        value.dashNetwork === undefined
          ? undefined
          : readLiteral(value.dashNetwork, ['mainnet', 'testnet'], 'dashNetwork')
      if (
        (chainFamily !== 'bip122' && bitcoinNetwork !== undefined) ||
        (chainFamily === 'bip122' && bitcoinNetwork === undefined) ||
        (chainFamily !== 'pearl' && pearlNetwork !== undefined) ||
        (chainFamily === 'pearl' && pearlNetwork === undefined) ||
        (chainFamily !== 'dash' && dashNetwork !== undefined) ||
        (chainFamily === 'dash' && dashNetwork === undefined)
      ) {
        throw new KeyringError('INVALID_CREDENTIAL')
      }
      return Object.freeze({
        vault: parseRawEncryptedVault(value.vault),
        currentPassword: parseSecret(value.currentPassword),
        newPassword: parseSecret(value.newPassword),
        chainFamily,
        ...(bitcoinNetwork === undefined ? {} : { bitcoinNetwork }),
        ...(pearlNetwork === undefined ? {} : { pearlNetwork }),
        ...(dashNetwork === undefined ? {} : { dashNetwork })
      })
    }, 'INVALID_CREDENTIAL')
    const currentVaultPassword = await bindMultichainVaultPassword(payload.currentPassword)
    const newVaultPassword = await bindMultichainVaultPassword(payload.newPassword)
    let rawSessionId: number | null = null
    try {
      const session = callRaw(
        command,
        () => this.engine.unlock(payload.vault, currentVaultPassword),
        parseDashOrRawSession
      )
      rawSessionId = session.sessionId
      const sessionBitcoinNetwork = 'bitcoinNetwork' in session ? session.bitcoinNetwork : undefined
      const sessionDashNetwork = 'dashNetwork' in session ? session.dashNetwork : undefined
      const sessionPearlNetwork = 'pearlNetwork' in session ? session.pearlNetwork : undefined
      if (
        session.kind !== 'private_key' ||
        session.chainFamily !== payload.chainFamily ||
        sessionBitcoinNetwork !== payload.bitcoinNetwork ||
        (sessionPearlNetwork === undefined
          ? payload.pearlNetwork !== undefined
          : payload.pearlNetwork === undefined ||
            fromWasmPearlNetwork(sessionPearlNetwork) !== payload.pearlNetwork) ||
        sessionDashNetwork !== payload.dashNetwork
      ) {
        throw new KeyringError('INVALID_CREDENTIAL')
      }
      const dashNetwork = payload.dashNetwork
      const chainId =
        payload.chainFamily === 'eip155'
          ? 'eip155:1'
          : payload.chainFamily === 'solana'
            ? 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
            : payload.chainFamily === 'near'
              ? 'near:mainnet'
              : payload.chainFamily === 'pearl'
                ? payload.pearlNetwork === 'mainnet'
                  ? 'bip122:a18d3093b7ff618f0cdd073fa3d10374'
                  : 'bip122:b0c86d0cd8825f4d72260d2de46f4704'
                : payload.chainFamily === 'dash'
                  ? dashChainIdForNetwork(requireDashNetwork(dashNetwork))
                  : payload.bitcoinNetwork === 'mainnet'
                    ? BITCOIN_CHAIN_IDS.mainnet
                    : BITCOIN_CHAIN_IDS.testnet
      const exported = callRaw(
        command,
        () =>
          this.engine.exportPrivateKey(
            session.sessionId,
            payload.vault,
            currentVaultPassword,
            payload.chainFamily === 'eip155'
              ? { chainId, addressIndex: 0 }
              : payload.chainFamily === 'solana' || payload.chainFamily === 'near'
                ? { chainId, accountIndex: 0 }
                : payload.chainFamily === 'pearl'
                  ? {
                      chainId,
                      accountIndex: 0,
                      change: false,
                      addressIndex: 0
                    }
                  : payload.chainFamily === 'dash'
                    ? dashExportRequest(chainId, 0)
                    : {
                        chainId,
                        addressType: 'p2wpkh' as const,
                        accountIndex: 0,
                        change: false,
                        addressIndex: 0
                      }
          ),
        payload.chainFamily === 'dash' ? parseDashExportedPrivateKey : parseRawExportedPrivateKey
      )
      return callRaw(
        command,
        () =>
          this.engine.importPrivateKey(
            {
              privateKey: exported.privateKey,
              chainFamily: payload.chainFamily,
              ...(payload.bitcoinNetwork === undefined
                ? {}
                : { bitcoinNetwork: payload.bitcoinNetwork }),
              ...(payload.pearlNetwork === undefined
                ? {}
                : { pearlNetwork: toWasmPearlNetwork(payload.pearlNetwork) }),
              ...(payload.dashNetwork === undefined ? {} : { dashNetwork: payload.dashNetwork })
            },
            newVaultPassword
          ),
        parseRawEncryptedVault
      )
    } finally {
      if (rawSessionId !== null) {
        try {
          this.engine.lock(rawSessionId)
        } catch {
          // The temporary rewrap session may already have been released by the engine.
        }
      }
    }
  }

  private async unlockCredential(command: KeyringCommand) {
    const binding = requireCredentialBinding(command)
    const { vault, password } = parseInput(() => {
      const payload = readRecord(command.payload, 'credential.unlock payload')
      assertExactKeys(payload, ['vault', 'password'], [], 'credential.unlock payload')
      return {
        vault: parseRawEncryptedVault(payload.vault),
        password: parseSecret(payload.password)
      }
    }, 'INVALID_CREDENTIAL')
    const existing = this.sessions.get(binding.keyDomainId)
    if (!existing && this.sessions.size >= this.maxSessions) {
      throw new KeyringError('CAPACITY_EXCEEDED')
    }
    if (existing) this.lockSession(existing)
    const vaultPassword = await bindMultichainVaultPassword(password)
    const rawSession = callRaw(
      command,
      () => this.engine.unlock(vault, vaultPassword),
      parseDashOrRawSession
    )
    this.sessions.set(
      binding.keyDomainId,
      Object.freeze({
        keyDomainId: binding.keyDomainId,
        credentialGenerationId: binding.credentialGenerationId,
        globalUnlockEpoch: binding.globalUnlockEpoch,
        rawSessionId: rawSession.sessionId,
        kind: rawSession.kind,
        ...(rawSession.chainFamily === undefined ? {} : { chainFamily: rawSession.chainFamily }),
        ...('bitcoinNetwork' in rawSession && rawSession.bitcoinNetwork !== undefined
          ? { bitcoinNetwork: rawSession.bitcoinNetwork }
          : {}),
        ...('pearlNetwork' in rawSession && rawSession.pearlNetwork !== undefined
          ? { pearlNetwork: fromWasmPearlNetwork(rawSession.pearlNetwork) }
          : {}),
        ...('dashNetwork' in rawSession ? { dashNetwork: rawSession.dashNetwork } : {})
      })
    )
    return Object.freeze({ state: 'unlocked' })
  }

  private lockCredential(command: KeyringCommand) {
    const binding = requireCredentialBinding(command)
    parseInput(() => {
      const payload = readRecord(command.payload, 'credential.lock payload')
      assertExactKeys(payload, [], [], 'credential.lock payload')
    })
    const session = this.sessions.get(binding.keyDomainId)
    if (session && matchesBinding(session, binding)) this.lockSession(session)
    return Object.freeze({ state: 'locked' })
  }

  private getCredentialState(command: KeyringCommand) {
    const binding = requireCredentialBinding(command)
    parseInput(() => {
      const payload = readRecord(command.payload, 'credential.get-state payload')
      assertExactKeys(payload, [], [], 'credential.get-state payload')
    })
    const session = this.sessions.get(binding.keyDomainId)
    return Object.freeze({
      state: session && matchesBinding(session, binding) ? 'unlocked' : 'locked'
    })
  }

  private derivePublicAccount(command: KeyringCommand) {
    const binding = requireCredentialBinding(command)
    const session = this.requireSession(binding)
    let derivation
    try {
      derivation = parseAccountDerivation(command.payload)
    } catch (error) {
      if (error instanceof KeyringError) throw error
      throw new KeyringError('INVALID_COMMAND')
    }
    if (derivation.family === 'evm') {
      const account = callRaw(
        command,
        () =>
          this.engine.deriveEvmAccount(
            session.rawSessionId,
            derivation.chainId,
            derivation.addressIndex
          ),
        value => {
          const account = parseRawEvmAccount(value)
          assertRawEvmAccountMatches(
            account,
            derivation.chainId,
            derivation.addressIndex,
            session.kind === 'private_key'
          )
          return account
        }
      )
      return publicAccount(derivation.chainId, account, 'identity')
    }
    if (derivation.family === 'solana' || derivation.family === 'near') {
      const account = callRaw(
        command,
        () =>
          derivation.family === 'solana'
            ? this.engine.deriveSolanaAccount(
                session.rawSessionId,
                derivation.chainId,
                derivation.accountIndex
              )
            : this.engine.deriveNearAccount(
                session.rawSessionId,
                derivation.chainId,
                derivation.accountIndex
              ),
        value => {
          const account = parseRawEd25519Account(value, derivation.family)
          assertRawEd25519AccountMatches(
            account,
            derivation.family,
            derivation.chainId,
            derivation.accountIndex,
            session.kind === 'private_key'
          )
          return account
        }
      )
      return publicAccount(derivation.chainId, account, 'identity')
    }
    if (derivation.family === 'starknet') {
      if (session.kind === 'private_key') throw new KeyringError('UNSUPPORTED_CHAIN')
      const account = callRaw(
        command,
        () =>
          this.engine.deriveStarknetAccount(
            session.rawSessionId,
            derivation.chainId,
            derivation.accountIndex,
            derivation.addressIndex,
            derivation.classHash
          ),
        value => {
          const derived = parseRawStarknetAccount(value)
          const expectedPath = `m/44'/9004'/${derivation.accountIndex}'/0/${derivation.addressIndex}`
          if (
            derived.derivationPath !== expectedPath ||
            derived.implementation !== 'open_zeppelin'
          ) {
            throw new Error('Starknet account does not match the software derivation')
          }
          return derived
        }
      )
      return publicAccount(derivation.chainId, account, 'identity')
    }
    if (derivation.family === 'pea') {
      return callRaw(
        command,
        () =>
          this.engine.derivePeaAccount(
            session.rawSessionId,
            globalPeaRequestJson(derivation.addressIndex)
          ),
        value => parseRawGlobalPeaAccount(value, derivation.addressIndex)
      )
    }
    if (derivation.family === 'pearl') {
      if (derivation.batch) {
        const accounts = callRaw(
          command,
          () =>
            this.engine.derivePearlAccounts(
              session.rawSessionId,
              derivation.chainId,
              derivation.accountIndex,
              derivation.change,
              derivation.startAddressIndex,
              derivation.count
            ),
          value =>
            readArray(
              value,
              'DerivedPearlAccounts',
              (candidate, offset) => {
                const account = parseRawPearlAccount(candidate)
                assertRawPearlAccountMatches(
                  account,
                  derivation.chainId,
                  derivation.accountIndex,
                  derivation.change,
                  derivation.startAddressIndex + offset,
                  session.kind === 'private_key'
                )
                return account
              },
              1_000
            )
        )
        if (accounts.length !== derivation.count) throw new KeyringError('INVALID_RESPONSE')
        return Object.freeze(
          accounts.map(account =>
            publicAccount(derivation.chainId, account, derivation.change ? 'change' : 'receive')
          )
        )
      }
      const account = callRaw(
        command,
        () =>
          this.engine.derivePearlAccount(
            session.rawSessionId,
            derivation.chainId,
            derivation.accountIndex,
            derivation.change,
            derivation.addressIndex
          ),
        value => {
          const account = parseRawPearlAccount(value)
          assertRawPearlAccountMatches(
            account,
            derivation.chainId,
            derivation.accountIndex,
            derivation.change,
            derivation.addressIndex,
            session.kind === 'private_key'
          )
          return account
        }
      )
      return publicAccount(derivation.chainId, account, derivation.change ? 'change' : 'receive')
    }
    if (derivation.family === 'quantus') {
      const wasmChainId = toQuantusWasmChainId(derivation.chainId)
      const expectedNetwork = expectedQuantusWasmNetwork(derivation.chainId)
      if (derivation.batch) {
        const accounts = callRaw(
          command,
          () =>
            this.engine.deriveQuantusAccounts(
              session.rawSessionId,
              wasmChainId,
              derivation.scheme,
              derivation.accountIndex,
              derivation.change,
              derivation.startAddressIndex,
              derivation.count
            ),
          value =>
            readArray(
              value,
              'DerivedQuantusAccounts',
              (candidate, offset) => {
                const account = parseRawQuantusAccount(candidate)
                assertRawQuantusAccountMatches(
                  account,
                  derivation.scheme,
                  derivation.accountIndex,
                  derivation.change,
                  derivation.startAddressIndex + offset,
                  expectedNetwork,
                  session.kind === 'private_key'
                )
                return account
              },
              1_000
            )
        )
        if (accounts.length !== derivation.count) throw new KeyringError('INVALID_RESPONSE')
        return Object.freeze(
          accounts.map(account =>
            publicAccount(derivation.chainId, account, derivation.change ? 'change' : 'receive')
          )
        )
      }
      const account = callRaw(
        command,
        () =>
          this.engine.deriveQuantusAccount(
            session.rawSessionId,
            wasmChainId,
            derivation.scheme,
            derivation.accountIndex,
            derivation.change,
            derivation.addressIndex
          ),
        value => {
          const account = parseRawQuantusAccount(value)
          assertRawQuantusAccountMatches(
            account,
            derivation.scheme,
            derivation.accountIndex,
            derivation.change,
            derivation.addressIndex,
            expectedNetwork,
            session.kind === 'private_key'
          )
          return account
        }
      )
      return publicAccount(derivation.chainId, account, derivation.change ? 'change' : 'receive')
    }
    if (derivation.family === 'dash') {
      assertDashDerivationSession(session.kind, derivation)
      const imported = session.kind === 'private_key'
      if (derivation.batch) {
        const accounts = callRaw(
          command,
          () => deriveDashAccountsRaw(this.engine, session.rawSessionId, derivation),
          value => parseDerivedDashAccountBatch(value, derivation, imported)
        )
        return Object.freeze(
          accounts.map(account =>
            publicAccount(derivation.chainId, account, derivation.change ? 'change' : 'receive')
          )
        )
      }
      const account = callRaw(
        command,
        () => deriveDashAccountsRaw(this.engine, session.rawSessionId, derivation),
        value => parseDerivedDashAccount(value, derivation, imported)
      )
      return publicAccount(derivation.chainId, account, derivation.change ? 'change' : 'receive')
    }
    if (derivation.family !== 'bitcoin') throw new KeyringError('UNSUPPORTED_CHAIN')
    if (derivation.batch) {
      const accounts = callRaw(
        command,
        () =>
          this.engine.deriveBitcoinAccounts(
            session.rawSessionId,
            derivation.chainId,
            derivation.addressType,
            derivation.accountIndex,
            derivation.change,
            derivation.startAddressIndex,
            derivation.count
          ),
        value =>
          readArray(
            value,
            'DerivedBitcoinAccounts',
            (candidate, offset) => {
              const account = parseRawBitcoinAccount(candidate)
              assertRawBitcoinAccountMatches(
                account,
                derivation.chainId,
                derivation.addressType,
                derivation.accountIndex,
                derivation.change,
                derivation.startAddressIndex + offset,
                session.kind === 'private_key'
              )
              return account
            },
            1_000
          )
      )
      if (accounts.length !== derivation.count) throw new KeyringError('INVALID_RESPONSE')
      return Object.freeze(
        accounts.map(account =>
          publicAccount(derivation.chainId, account, derivation.change ? 'change' : 'receive')
        )
      )
    }
    const account = callRaw(
      command,
      () =>
        this.engine.deriveBitcoinAccount(
          session.rawSessionId,
          derivation.chainId,
          derivation.addressType,
          derivation.accountIndex,
          derivation.change,
          derivation.addressIndex
        ),
      value => {
        const account = parseRawBitcoinAccount(value)
        assertRawBitcoinAccountMatches(
          account,
          derivation.chainId,
          derivation.addressType,
          derivation.accountIndex,
          derivation.change,
          derivation.addressIndex,
          session.kind === 'private_key'
        )
        return account
      }
    )
    return publicAccount(derivation.chainId, account, derivation.change ? 'change' : 'receive')
  }

  private async prepareSigning(command: KeyringCommand) {
    const binding = requireCredentialBinding(command)
    const session = this.requireSession(binding)
    if (this.pending.size >= this.maxPendingSigning) throw new KeyringError('CAPACITY_EXCEEDED')
    let payload: ParsedSigningPreparePayload
    try {
      payload = parseSigningPreparePayload(command.payload)
    } catch {
      throw new KeyringError('UNSUPPORTED_PAYLOAD')
    }
    const signingCommandId = readSigningCommandId(this.createSigningCommandId())
    if (this.pending.has(signingCommandId)) throw new KeyringError('SIGNING_COMMAND_CONFLICT')
    const expiresAt = this.now() + this.signingTtlMs
    if (!Number.isSafeInteger(expiresAt)) throw new KeyringError('INTERNAL_ERROR')

    let raw: unknown
    let bitcoinAccount: RawDerivedBitcoinAccount | RawDashAccount | undefined
    let pearlAccount: RawDerivedPearlAccount | undefined
    try {
      if (payload.kind === 'evm-transaction') {
        raw = this.engine.prepareEvmTransaction(
          session.rawSessionId,
          payload.chainId,
          payload.addressIndex,
          payload.transaction
        )
      } else if (payload.kind === 'pea-evm-transaction') {
        raw = this.engine.preparePeaEvmTransaction(
          session.rawSessionId,
          globalPeaRequestJson(payload.addressIndex),
          payload.chainId,
          payload.transaction
        )
      } else if (payload.kind === 'evm-personal-message') {
        raw = this.engine.prepareEvmPersonalMessage(
          session.rawSessionId,
          payload.chainId,
          payload.addressIndex,
          payload.message
        )
      } else if (payload.kind === 'pea-evm-personal-message') {
        raw = this.engine.preparePeaEvmPersonalMessage(
          session.rawSessionId,
          globalPeaRequestJson(payload.addressIndex),
          payload.message
        )
      } else if (payload.kind === 'evm-typed-data') {
        raw = this.engine.prepareEvmTypedData(
          session.rawSessionId,
          payload.chainId,
          payload.addressIndex,
          payload.typedDataJson
        )
      } else if (payload.kind === 'pea-evm-typed-data') {
        raw = this.engine.preparePeaEvmTypedData(
          session.rawSessionId,
          globalPeaRequestJson(payload.addressIndex),
          payload.chainId,
          payload.typedDataJson
        )
      } else if (payload.kind === 'bitcoin-psbt') {
        bitcoinAccount = callRaw(
          command,
          () =>
            this.engine.deriveBitcoinAccount(
              session.rawSessionId,
              payload.chainId,
              payload.addressType,
              payload.accountIndex,
              false,
              0
            ),
          value => {
            const account = parseRawBitcoinAccount(value)
            assertRawBitcoinAccountMatches(
              account,
              payload.chainId,
              payload.addressType,
              payload.accountIndex,
              false,
              0,
              session.kind === 'private_key'
            )
            return account
          }
        )
        raw = this.engine.prepareBitcoinPsbt(
          session.rawSessionId,
          payload.chainId,
          payload.addressType,
          payload.accountIndex,
          payload.psbt
        )
      } else if (payload.kind === 'pearl-psbt') {
        pearlAccount = callRaw(
          command,
          () =>
            this.engine.derivePearlAccount(
              session.rawSessionId,
              payload.chainId,
              payload.accountIndex,
              false,
              0
            ),
          value => {
            const account = parseRawPearlAccount(value)
            assertRawPearlAccountMatches(
              account,
              payload.chainId,
              payload.accountIndex,
              false,
              0,
              session.kind === 'private_key'
            )
            return account
          }
        )
        raw = this.engine.preparePearlPsbt(
          session.rawSessionId,
          payload.chainId,
          payload.accountIndex,
          payload.psbt
        )
      } else if (payload.kind === 'pearl-bip322-message') {
        raw = this.engine.preparePearlMessage(session.rawSessionId, {
          chainId: payload.chainId,
          accountIndex: payload.accountIndex,
          change: payload.change,
          addressIndex: payload.addressIndex,
          message: payload.message
        })
      } else if (payload.kind === 'dash-psbt' || payload.kind === 'dash-message') {
        const dashPayload: DashSigningPreparePayload = payload
        assertDashSigningSession(session.kind, dashPayload)
        const imported = session.kind === 'private_key'
        bitcoinAccount = callRaw(
          command,
          () =>
            this.engine.deriveDashAccount(
              session.rawSessionId,
              dashPayload.chainId,
              dashPayload.accountIndex,
              dashPayload.kind === 'dash-message' ? dashPayload.change : false,
              dashPayload.kind === 'dash-message' ? dashPayload.addressIndex : 0
            ),
          value =>
            parseDerivedDashAccount(
              value,
              {
                family: 'dash',
                batch: false,
                chainId: dashPayload.chainId,
                accountIndex: dashPayload.accountIndex,
                change: dashPayload.kind === 'dash-message' ? dashPayload.change : false,
                addressIndex: dashPayload.kind === 'dash-message' ? dashPayload.addressIndex : 0
              },
              imported
            )
        )
        raw = prepareDashSigningRaw(this.engine, session.rawSessionId, dashPayload)
      } else if (payload.kind === 'solana-transaction') {
        raw = this.engine.prepareSolanaTransaction(
          session.rawSessionId,
          payload.chainId,
          payload.accountIndex,
          payload.transaction
        )
      } else if (payload.kind === 'solana-message') {
        raw = this.engine.prepareSolanaMessage(
          session.rawSessionId,
          payload.chainId,
          payload.accountIndex,
          payload.message
        )
      } else if (payload.kind === 'near-transaction') {
        raw = this.engine.prepareNearTransaction(session.rawSessionId, payload.transaction)
      } else if (payload.kind === 'near-nep413-message') {
        raw = this.engine.prepareNearMessage(session.rawSessionId, payload.request)
      } else if (payload.kind === 'quantus-transfer') {
        // The engine pins only the mainnet genesis hash and refuses to sign through
        // any other reference until the host binds it to a trusted genesis hash.
        // The binding is immutable per reference, so an endpoint that later reports
        // a different chain fails closed instead of signing on the wrong network.
        if (requiresQuantusGenesisBinding(payload.transfer.chainId)) {
          this.engine.registerQuantusNetwork(
            payload.transfer.chainId,
            payload.transfer.genesisHash
          )
        }
        raw = this.engine.prepareQuantusTransfer(session.rawSessionId, payload.transfer)
      } else if (
        payload.kind === 'starknet-invoke' ||
        payload.kind === 'starknet-deploy-account' ||
        payload.kind === 'starknet-typed-data'
      ) {
        if (session.kind === 'private_key') throw new KeyringError('UNSUPPORTED_CHAIN')
        const requestJson = starknetSessionRequestJson(payload)
        raw =
          payload.kind === 'starknet-invoke'
            ? this.engine.prepareStarknetInvoke(session.rawSessionId, requestJson)
            : payload.kind === 'starknet-deploy-account'
              ? this.engine.prepareStarknetDeployAccount(session.rawSessionId, requestJson)
              : this.engine.prepareStarknetTypedData(session.rawSessionId, requestJson)
      } else {
        raw = this.engine.prepareBitcoinMessage(session.rawSessionId, {
          chainId: payload.chainId,
          addressType: payload.addressType,
          accountIndex: payload.accountIndex,
          change: payload.change,
          addressIndex: payload.addressIndex,
          message: payload.message
        })
      }
    } catch (error) {
      throw mapRawError(error, command.operation)
    }

    let adapted: AdaptedPreparedSigning
    try {
      adapted = await adaptPreparedSigning(
        raw,
        payload,
        signingCommandId,
        expiresAt,
        bitcoinAccount,
        session.kind === 'private_key',
        pearlAccount
      )
    } catch {
      this.rejectRawRequest(session.rawSessionId, raw)
      throw new KeyringError('INVALID_RESPONSE')
    }
    if (isKeyringCommandExpired(command, this.now())) {
      this.engine.rejectSigningRequest(session.rawSessionId, adapted.rawRequestId)
      throw new KeyringError('COMMAND_TIMEOUT')
    }
    this.pending.set(
      signingCommandId,
      Object.freeze({
        commandId: signingCommandId,
        keyDomainId: binding.keyDomainId,
        credentialGenerationId: binding.credentialGenerationId,
        globalUnlockEpoch: binding.globalUnlockEpoch,
        rawSessionId: session.rawSessionId,
        rawRequestId: adapted.rawRequestId,
        kind: adapted.kind,
        account: adapted.account,
        expiresAt
      })
    )
    return adapted.prepared
  }

  private confirmSigning(command: KeyringCommand) {
    const binding = requireCredentialBinding(command)
    const signingCommandId = parseInput(() => {
      const payload = readRecord(command.payload, 'signing.confirm payload')
      assertExactKeys(payload, ['signingCommandId'], [], 'signing.confirm payload')
      return readSigningCommandId(payload.signingCommandId)
    })
    const pending = this.pending.get(signingCommandId)
    if (!pending || !matchesBinding(pending, binding)) {
      throw new KeyringError('SIGNING_COMMAND_NOT_FOUND')
    }
    this.pending.delete(signingCommandId)
    if (this.now() >= pending.expiresAt) {
      this.engine.rejectSigningRequest(pending.rawSessionId, pending.rawRequestId)
      throw new KeyringError('SIGNING_COMMAND_EXPIRED')
    }
    let raw: unknown
    try {
      switch (pending.kind) {
        case 'evm-transaction':
        case 'pea-evm-transaction':
          raw = this.engine.confirmEvmTransaction(pending.rawSessionId, pending.rawRequestId)
          break
        case 'evm-personal-message':
        case 'pea-evm-personal-message':
          raw = this.engine.confirmEvmPersonalMessage(pending.rawSessionId, pending.rawRequestId)
          break
        case 'evm-typed-data':
        case 'pea-evm-typed-data':
          raw = this.engine.confirmEvmTypedData(pending.rawSessionId, pending.rawRequestId)
          break
        case 'bitcoin-psbt':
          raw = this.engine.confirmBitcoinPsbt(pending.rawSessionId, pending.rawRequestId)
          break
        case 'bitcoin-bip322-message':
          raw = this.engine.confirmBitcoinMessage(pending.rawSessionId, pending.rawRequestId)
          break
        case 'pearl-psbt':
          raw = this.engine.confirmPearlPsbt(pending.rawSessionId, pending.rawRequestId)
          break
        case 'pearl-bip322-message':
          raw = this.engine.confirmPearlMessage(pending.rawSessionId, pending.rawRequestId)
          break
        case 'dash-psbt':
        case 'dash-message':
          raw = confirmDashSigningRaw(
            this.engine,
            pending.rawSessionId,
            pending.rawRequestId,
            pending.kind
          )
          break
        case 'solana-transaction':
          raw = this.engine.confirmSolanaTransaction(pending.rawSessionId, pending.rawRequestId)
          break
        case 'solana-message':
          raw = this.engine.confirmSolanaMessage(pending.rawSessionId, pending.rawRequestId)
          break
        case 'near-transaction':
          raw = this.engine.confirmNearTransaction(pending.rawSessionId, pending.rawRequestId)
          break
        case 'near-nep413-message':
          raw = this.engine.confirmNearMessage(pending.rawSessionId, pending.rawRequestId)
          break
        case 'quantus-transfer':
          // Both Quantus prepare entry points store a `QuantusCall` request and
          // only `confirmQuantusCall` exists upstream.
          raw = this.engine.confirmQuantusCall(pending.rawSessionId, pending.rawRequestId)
          break
        case 'starknet-invoke':
          raw = this.engine.confirmStarknetInvoke(pending.rawSessionId, pending.rawRequestId)
          break
        case 'starknet-deploy-account':
          raw = this.engine.confirmStarknetDeployAccount(pending.rawSessionId, pending.rawRequestId)
          break
        case 'starknet-typed-data':
          raw = this.engine.confirmStarknetTypedData(pending.rawSessionId, pending.rawRequestId)
          break
      }
    } catch (error) {
      throw mapRawError(error, command.operation)
    }
    try {
      return adaptSignedResult(pending.kind, raw, pending.account)
    } catch {
      throw new KeyringError('INVALID_RESPONSE')
    }
  }

  private cancelSigning(command: KeyringCommand) {
    const binding = requireCredentialBinding(command)
    const signingCommandId = parseInput(() => {
      const payload = readRecord(command.payload, 'signing.cancel payload')
      assertExactKeys(payload, ['signingCommandId'], [], 'signing.cancel payload')
      return readSigningCommandId(payload.signingCommandId)
    })
    const pending = this.pending.get(signingCommandId)
    if (!pending || !matchesBinding(pending, binding)) return Object.freeze({ cancelled: false })
    this.pending.delete(signingCommandId)
    const cancelled = this.engine.rejectSigningRequest(pending.rawSessionId, pending.rawRequestId)
    return Object.freeze({ cancelled })
  }

  private verifySigning(command: KeyringCommand) {
    const payload = parseInput(() => {
      const value = readRecord(command.payload, 'signing.verify payload')
      assertExactKeys(
        value,
        ['kind', 'chainId', 'address', 'message', 'signature'],
        [],
        'signing.verify payload'
      )
      return value
    }, 'UNSUPPORTED_PAYLOAD')
    if (payload.kind === 'dash-message') {
      const chainId = readString(payload.chainId, 'chainId', 64)
      if (
        !(payload.message instanceof Uint8Array) ||
        payload.message.byteLength === 0 ||
        payload.message.byteLength > 4 * 1024
      ) {
        throw new KeyringError('UNSUPPORTED_PAYLOAD')
      }
      const address = readString(payload.address, 'address', 128)
      const signature = readString(payload.signature, 'signature', 16_384)
      let verified: boolean
      try {
        verified = verifyDashMessageRaw(
          this.engine,
          chainId,
          address,
          new Uint8Array(payload.message),
          signature
        )
      } catch (error) {
        if (error instanceof KeyringError) throw error
        throw mapRawError(error, command.operation)
      }
      return Object.freeze({ verified })
    }
    if (payload.kind !== 'bitcoin-bip322-message' && payload.kind !== 'pearl-bip322-message') {
      throw new KeyringError('UNSUPPORTED_PAYLOAD')
    }
    const chainId = readString(payload.chainId, 'chainId', 64)
    const isPearl = payload.kind === 'pearl-bip322-message'
    if (isPearl) {
      if (
        chainId !== 'bip122:a18d3093b7ff618f0cdd073fa3d10374' &&
        chainId !== 'bip122:b0c86d0cd8825f4d72260d2de46f4704'
      ) {
        throw new KeyringError('UNSUPPORTED_CHAIN')
      }
    } else if (!isExactBitcoinChainId(chainId)) {
      throw new KeyringError('UNSUPPORTED_CHAIN')
    }
    const maximumMessageBytes = isPearl ? 80 : 4 * 1024
    if (
      !(payload.message instanceof Uint8Array) ||
      payload.message.byteLength === 0 ||
      payload.message.byteLength > maximumMessageBytes
    ) {
      throw new KeyringError('UNSUPPORTED_PAYLOAD')
    }
    const address = readString(payload.address, 'address', 128)
    const signature = readString(payload.signature, 'signature', 16_384)
    let verified: boolean
    try {
      verified = isPearl
        ? this.engine.verifyPearlMessage(
            chainId,
            address,
            new Uint8Array(payload.message),
            signature
          )
        : this.engine.verifyBitcoinMessage(
            chainId,
            address,
            new Uint8Array(payload.message),
            signature
          )
    } catch (error) {
      throw mapRawError(error, command.operation)
    }
    return Object.freeze({ verified })
  }

  private cancelAllSigning(command: KeyringCommand) {
    const binding = requireCredentialBinding(command)
    parseInput(() => {
      const payload = readRecord(command.payload, 'signing.cancel-all payload')
      assertExactKeys(payload, [], [], 'signing.cancel-all payload')
    })
    let cancelled = 0
    for (const pending of [...this.pending.values()]) {
      if (!matchesBinding(pending, binding)) continue
      this.pending.delete(pending.commandId)
      if (this.engine.rejectSigningRequest(pending.rawSessionId, pending.rawRequestId)) {
        cancelled += 1
      }
    }
    return Object.freeze({ cancelled })
  }

  private cancelProductCommand(command: KeyringCommand) {
    parseInput(() => {
      const payload = readRecord(command.payload, 'command.cancel payload')
      assertExactKeys(payload, ['commandId'], [], 'command.cancel payload')
      readString(payload.commandId, 'commandId', 128)
    })
    return Object.freeze({ cancelled: false })
  }

  private requireSession(
    binding: Extract<KeyringCommandBinding, { kind: 'credential' }>
  ): CredentialSession {
    const session = this.sessions.get(binding.keyDomainId)
    if (!session || !matchesBinding(session, binding)) throw new KeyringError('CREDENTIAL_LOCKED')
    return session
  }

  private rejectRawRequest(rawSessionId: number, raw: unknown): void {
    try {
      const record = readRecord(raw, 'prepared signing response')
      const requestId = readSafeInteger(record.requestId, 'prepared signing response.requestId')
      this.engine.rejectSigningRequest(rawSessionId, requestId)
    } catch {
      // A malformed raw response has no trusted request identifier to cancel.
    }
  }

  private purgeExpiredSigning(): void {
    const now = this.now()
    for (const pending of [...this.pending.values()]) {
      if (now < pending.expiresAt) continue
      this.pending.delete(pending.commandId)
      this.engine.rejectSigningRequest(pending.rawSessionId, pending.rawRequestId)
    }
  }

  private lockSession(session: CredentialSession): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.keyDomainId !== session.keyDomainId) continue
      this.pending.delete(pending.commandId)
      this.engine.rejectSigningRequest(pending.rawSessionId, pending.rawRequestId)
    }
    this.engine.lock(session.rawSessionId)
    this.sessions.delete(session.keyDomainId)
  }

  private lockAll(): void {
    this.pending.clear()
    this.sessions.clear()
    this.engine.lockAll()
  }
}
