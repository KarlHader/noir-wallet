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
  parseRawSessionInfo,
  RAW_BITCOIN_ADDRESS_TYPES,
  readArray,
  readBoolean,
  readLiteral,
  readRecord,
  readSafeInteger,
  readString,
  type RawBitcoinAddressType,
  type RawBitcoinNetwork,
  type RawDerivedAccount,
  type RawDerivedBitcoinAccount,
  type RawDerivedEd25519Account,
  type RawDerivedPeaAccount,
  type RawPeaExecutionAccount,
  type RawPrivateKeyChainFamily,
  type RawWalletEngine
} from './raw-wallet-engine'
import { bindMultichainVaultPassword } from './password-binding'

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

interface CredentialSession {
  readonly keyDomainId: string
  readonly credentialGenerationId: string
  readonly globalUnlockEpoch: string
  readonly rawSessionId: number
  readonly kind: 'mnemonic' | 'private_key'
  readonly chainFamily?: RawPrivateKeyChainFamily
  readonly bitcoinNetwork?: RawBitcoinNetwork
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
    | RawDerivedEd25519Account
    | RawDerivedPeaAccount
    | RawPeaExecutionAccount
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
  return new KeyringError(code)
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
      readonly family: 'solana'
      readonly chainId: string
      readonly accountIndex: number
    }
  | {
      readonly family: 'near'
      readonly chainId: string
      readonly accountIndex: number
    } {
  const record = readRecord(value, 'account.derive-public payload')
  const family = readLiteral(
    record.family,
    ['evm', 'pea', 'bitcoin', 'solana', 'near'],
    'account family'
  )
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
  if (family === 'pea') {
    assertExactKeys(record, ['family', 'addressIndex'], [], 'derive payload')
    return Object.freeze({
      family,
      addressIndex: readSafeInteger(record.addressIndex, 'addressIndex', MAX_BIP32_INDEX)
    })
  }
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
  if (
    chainId !== 'bip122:000000000019d6689c085ae165831e93' &&
    chainId !== 'bip122:000000000933ea01ad0ee984209779ba'
  ) {
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
  account: RawDerivedAccount | RawDerivedBitcoinAccount | RawDerivedEd25519Account,
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
          ...(account.redeemScript === undefined ? {} : { redeemScript: account.redeemScript })
        }
      : {})
  })
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
      case 'identity.get-public':
        throw new KeyringError('UNSUPPORTED_OPERATION')
    }
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
        ['bitcoinNetwork'],
        'credential.import-private-key payload'
      )
      const chainFamily = readLiteral(
        value.chainFamily,
        ['eip155', 'bip122', 'solana', 'near'],
        'chainFamily'
      )
      const bitcoinNetwork =
        value.bitcoinNetwork === undefined
          ? undefined
          : readLiteral(value.bitcoinNetwork, ['mainnet', 'testnet'], 'bitcoinNetwork')
      if (
        (chainFamily !== 'bip122' && bitcoinNetwork !== undefined) ||
        (chainFamily === 'bip122' && bitcoinNetwork === undefined)
      ) {
        throw new KeyringError('INVALID_CREDENTIAL')
      }
      return Object.freeze({
        privateKey: parseSecret(value.privateKey),
        password: parseSecret(value.password),
        chainFamily,
        ...(bitcoinNetwork === undefined ? {} : { bitcoinNetwork })
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
              : { bitcoinNetwork: payload.bitcoinNetwork })
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
      if (!chainId.startsWith('bip122:')) throw new KeyringError('UNSUPPORTED_CHAIN')
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
      parseRawExportedPrivateKey
    )
  }

  private async rewrapPrivateKey(command: KeyringCommand) {
    requireCredentialBinding(command)
    const payload = parseInput(() => {
      const value = readRecord(command.payload, 'credential.rewrap-private-key payload')
      assertExactKeys(
        value,
        ['vault', 'currentPassword', 'newPassword', 'chainFamily'],
        ['bitcoinNetwork'],
        'credential.rewrap-private-key payload'
      )
      const chainFamily = readLiteral(
        value.chainFamily,
        ['eip155', 'bip122', 'solana', 'near'],
        'chainFamily'
      )
      const bitcoinNetwork =
        value.bitcoinNetwork === undefined
          ? undefined
          : readLiteral(value.bitcoinNetwork, ['mainnet', 'testnet'], 'bitcoinNetwork')
      if (
        (chainFamily !== 'bip122' && bitcoinNetwork !== undefined) ||
        (chainFamily === 'bip122' && bitcoinNetwork === undefined)
      ) {
        throw new KeyringError('INVALID_CREDENTIAL')
      }
      return Object.freeze({
        vault: parseRawEncryptedVault(value.vault),
        currentPassword: parseSecret(value.currentPassword),
        newPassword: parseSecret(value.newPassword),
        chainFamily,
        ...(bitcoinNetwork === undefined ? {} : { bitcoinNetwork })
      })
    }, 'INVALID_CREDENTIAL')
    const currentVaultPassword = await bindMultichainVaultPassword(payload.currentPassword)
    const newVaultPassword = await bindMultichainVaultPassword(payload.newPassword)
    let rawSessionId: number | null = null
    try {
      const session = callRaw(
        command,
        () => this.engine.unlock(payload.vault, currentVaultPassword),
        parseRawSessionInfo
      )
      rawSessionId = session.sessionId
      if (
        session.kind !== 'private_key' ||
        session.chainFamily !== payload.chainFamily ||
        session.bitcoinNetwork !== payload.bitcoinNetwork
      ) {
        throw new KeyringError('INVALID_CREDENTIAL')
      }
      const chainId =
        payload.chainFamily === 'eip155'
          ? 'eip155:1'
          : payload.chainFamily === 'solana'
            ? 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
            : payload.chainFamily === 'near'
              ? 'near:mainnet'
              : payload.bitcoinNetwork === 'mainnet'
                ? 'bip122:000000000019d6689c085ae165831e93'
                : 'bip122:000000000933ea01ad0ee984209779ba'
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
                : {
                    chainId,
                    addressType: 'p2wpkh',
                    accountIndex: 0,
                    change: false,
                    addressIndex: 0
                  }
          ),
        parseRawExportedPrivateKey
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
                : { bitcoinNetwork: payload.bitcoinNetwork })
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
      parseRawSessionInfo
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
        ...(rawSession.bitcoinNetwork === undefined
          ? {}
          : { bitcoinNetwork: rawSession.bitcoinNetwork })
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
    let bitcoinAccount: RawDerivedBitcoinAccount | undefined
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
        session.kind === 'private_key'
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
    if (payload.kind !== 'bitcoin-bip322-message') {
      throw new KeyringError('UNSUPPORTED_PAYLOAD')
    }
    const chainId = readString(payload.chainId, 'chainId', 64)
    if (
      chainId !== 'bip122:000000000019d6689c085ae165831e93' &&
      chainId !== 'bip122:000000000933ea01ad0ee984209779ba'
    ) {
      throw new KeyringError('UNSUPPORTED_CHAIN')
    }
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
      verified = this.engine.verifyBitcoinMessage(
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
