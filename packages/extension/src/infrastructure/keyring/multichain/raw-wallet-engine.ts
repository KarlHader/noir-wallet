export const RAW_BITCOIN_ADDRESS_TYPES = Object.freeze([
  'p2pkh',
  'p2sh_p2wpkh',
  'p2wpkh',
  'p2tr'
] as const)
export type RawBitcoinAddressType = (typeof RAW_BITCOIN_ADDRESS_TYPES)[number]
export type RawPrivateKeyChainFamily = 'eip155' | 'bip122' | 'solana' | 'near' | 'pearl'
export type RawBitcoinNetwork = 'mainnet' | 'testnet'
export type RawPearlNetwork = 'mainnet' | 'testnet2' | 'regtest'
export type RawPearlKeyNetwork = 'mainnet' | 'testnet2'
/** Aligns with Quantus WASM `scheme` on deriveQuantusAccount(s). */
export const RAW_QUANTUS_SCHEMES = Object.freeze(['ml-dsa-87', 'ml-dsa-65'] as const)
export type RawQuantusScheme = (typeof RAW_QUANTUS_SCHEMES)[number]
export const MAX_BIP32_INDEX = 0x7fffffff
export const MAX_UINT64 = (1n << 64n) - 1n
export const MAX_UINT256 = (1n << 256n) - 1n

export interface RawWalletEngine {
  coreInfo(): unknown
  createWallet(wordCount: number, password: string, bip39Passphrase: string): unknown
  importWallet(mnemonic: string, password: string, bip39Passphrase: string): unknown
  importPrivateKey(request: unknown, password: string): unknown
  exportPrivateKey(sessionId: number, vault: unknown, password: string, request: unknown): unknown
  sessionInfo(sessionId: number): unknown
  unlock(vault: unknown, password: string): unknown
  lock(sessionId: number): boolean
  lockAll(): void
  deriveEvmAccount(sessionId: number, chainId: string, addressIndex: number): unknown
  derivePeaAccount(sessionId: number, requestJson: string): unknown
  deriveSolanaAccount(sessionId: number, chainId: string, accountIndex: number): unknown
  deriveNearAccount(sessionId: number, chainId: string, accountIndex: number): unknown
  deriveBitcoinAccount(
    sessionId: number,
    chainId: string,
    addressType: RawBitcoinAddressType,
    accountIndex: number,
    change: boolean,
    addressIndex: number
  ): unknown
  deriveBitcoinAccounts(
    sessionId: number,
    chainId: string,
    addressType: RawBitcoinAddressType,
    accountIndex: number,
    change: boolean,
    startAddressIndex: number,
    count: number
  ): unknown
  derivePearlAccount(
    sessionId: number,
    chainId: string,
    accountIndex: number,
    change: boolean,
    addressIndex: number
  ): unknown
  derivePearlAccounts(
    sessionId: number,
    chainId: string,
    accountIndex: number,
    change: boolean,
    startAddressIndex: number,
    count: number
  ): unknown
  prepareEvmTransaction(
    sessionId: number,
    chainId: string,
    addressIndex: number,
    transaction: unknown
  ): unknown
  preparePeaEvmTransaction(
    sessionId: number,
    requestJson: string,
    executionChainId: string,
    transaction: unknown
  ): unknown
  confirmEvmTransaction(sessionId: number, requestId: number): unknown
  prepareEvmPersonalMessage(
    sessionId: number,
    chainId: string,
    addressIndex: number,
    message: Uint8Array
  ): unknown
  preparePeaEvmPersonalMessage(sessionId: number, requestJson: string, message: Uint8Array): unknown
  confirmEvmPersonalMessage(sessionId: number, requestId: number): unknown
  prepareEvmTypedData(
    sessionId: number,
    chainId: string,
    addressIndex: number,
    typedDataJson: string
  ): unknown
  preparePeaEvmTypedData(
    sessionId: number,
    requestJson: string,
    executionChainId: string,
    typedDataJson: string
  ): unknown
  confirmEvmTypedData(sessionId: number, requestId: number): unknown
  prepareBitcoinPsbt(
    sessionId: number,
    chainId: string,
    addressType: RawBitcoinAddressType,
    accountIndex: number,
    psbt: string
  ): unknown
  confirmBitcoinPsbt(sessionId: number, requestId: number): unknown
  prepareBitcoinMessage(sessionId: number, request: unknown): unknown
  confirmBitcoinMessage(sessionId: number, requestId: number): unknown
  preparePearlPsbt(sessionId: number, chainId: string, accountIndex: number, psbt: string): unknown
  confirmPearlPsbt(sessionId: number, requestId: number): unknown
  preparePearlMessage(sessionId: number, request: unknown): unknown
  confirmPearlMessage(sessionId: number, requestId: number): unknown
  verifyPearlMessage(
    chainId: string,
    address: string,
    message: Uint8Array,
    signature: string
  ): boolean
  prepareSolanaTransaction(
    sessionId: number,
    chainId: string,
    accountIndex: number,
    transactionBase64: string
  ): unknown
  confirmSolanaTransaction(sessionId: number, requestId: number): unknown
  prepareSolanaMessage(
    sessionId: number,
    chainId: string,
    accountIndex: number,
    message: Uint8Array
  ): unknown
  confirmSolanaMessage(sessionId: number, requestId: number): unknown
  verifySolanaMessage(
    chainId: string,
    address: string,
    message: Uint8Array,
    signature: string
  ): boolean
  prepareNearTransaction(sessionId: number, request: unknown): unknown
  confirmNearTransaction(sessionId: number, requestId: number): unknown
  prepareNearMessage(sessionId: number, request: unknown): unknown
  confirmNearMessage(sessionId: number, requestId: number): unknown
  verifyNearMessage(request: unknown): unknown
  /**
   * Quantus derivation is advertised as `account.quantus.derive` and
   * `account.quantus.batch-derive`, and Worker routing calls these two methods.
   * Transfer prepare/confirm is routed through the Worker and declared as
   * `quantus.extrinsic.sign`; the Background transfer lifecycle consumes the
   * signed extrinsic.
   *
   * `registerQuantusNetwork` binds a configured genesis hash to a non-mainnet
   * reference; the engine refuses to sign through a reference that has no
   * trusted genesis hash. Registration is immutable per reference.
   *
   * `deriveQuantusWormhole` remains unmapped on purpose (wormhole is deferred).
   * Transfer confirmation: only `confirmQuantusCall` is exported; both prepare
   * entry points store a `QuantusCall` request, so `confirmQuantusCall` is the
   * confirm path. There is no `confirmQuantusTransfer`; do not invent one.
   */
  deriveQuantusAccount(
    sessionId: number,
    chainId: string,
    scheme: RawQuantusScheme,
    accountIndex: number,
    change: boolean,
    addressIndex: number
  ): unknown
  deriveQuantusAccounts(
    sessionId: number,
    chainId: string,
    scheme: RawQuantusScheme,
    accountIndex: number,
    change: boolean,
    startAddressIndex: number,
    count: number
  ): unknown
  deriveQuantusWormhole(
    sessionId: number,
    chainId: string,
    accountIndex: number,
    addressIndex: number
  ): unknown
  registerQuantusNetwork(chainId: string, genesisHash: string): void
  prepareQuantusCall(sessionId: number, request: unknown): unknown
  prepareQuantusTransfer(sessionId: number, request: unknown): unknown
  confirmQuantusCall(sessionId: number, requestId: number): unknown
  deriveStarknetAccount(
    sessionId: number,
    chainId: string,
    accountIndex: number,
    addressIndex: number,
    classHash: string
  ): unknown
  prepareStarknetInvoke(sessionId: number, requestJson: string): unknown
  confirmStarknetInvoke(sessionId: number, requestId: number): unknown
  prepareStarknetDeployAccount(sessionId: number, requestJson: string): unknown
  confirmStarknetDeployAccount(sessionId: number, requestId: number): unknown
  prepareStarknetTypedData(sessionId: number, requestJson: string): unknown
  confirmStarknetTypedData(sessionId: number, requestId: number): unknown
  computeStarknetAccountAddress(requestJson: string): unknown
  prepareStarknetInvokeExternal(requestJson: string): unknown
  assembleStarknetInvokeExternal(requestJson: string): unknown
  prepareStarknetDeployAccountExternal(requestJson: string): unknown
  assembleStarknetDeployAccountExternal(requestJson: string): unknown
  hashStarknetTypedData(requestJson: string): unknown
  verifyStarknetSignature(requestJson: string): unknown
  verifyBitcoinMessage(
    chainId: string,
    address: string,
    message: Uint8Array,
    signature: string
  ): boolean
  deriveDashAccount(
    sessionId: number,
    chainId: string,
    accountIndex: number,
    change: boolean,
    addressIndex: number
  ): unknown
  deriveDashAccounts(
    sessionId: number,
    chainId: string,
    accountIndex: number,
    change: boolean,
    startAddressIndex: number,
    count: number
  ): unknown
  prepareDashPsbt(sessionId: number, chainId: string, accountIndex: number, psbt: string): unknown
  confirmDashPsbt(sessionId: number, requestId: number): unknown
  prepareDashMessage(
    sessionId: number,
    chainId: string,
    accountIndex: number,
    change: boolean,
    addressIndex: number,
    message: Uint8Array
  ): unknown
  confirmDashMessage(sessionId: number, requestId: number): unknown
  verifyDashMessage(
    chainId: string,
    address: string,
    message: Uint8Array,
    signature: string
  ): boolean
  rejectSigningRequest(sessionId: number, requestId: number): boolean
  free(): void
}

export type UnknownRecord = Record<string, unknown>

export function readRecord(value: unknown, label: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`)
  }
  return value as UnknownRecord
}

export function assertExactKeys(
  record: UnknownRecord,
  required: readonly string[],
  optional: readonly string[],
  label: string
): void {
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`${label} contains an unknown field`)
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new Error(`${label} is missing a required field`)
    }
  }
}

export function readString(value: unknown, label: string, maximum = 16_384): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value
  ) {
    throw new Error(`${label} must be a bounded non-empty string`)
  }
  return value
}

export function readBoundedString(value: unknown, label: string, maximum = 16_384): string {
  if (typeof value !== 'string' || value.length > maximum) {
    throw new Error(`${label} must be a bounded string`)
  }
  return value
}

export function readBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`)
  return value
}

export function readSafeInteger(value: unknown, label: string, maximum = 0xffffffff): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`${label} must be a non-negative integer`)
  }
  return value as number
}

export function readUnsignedDecimal(
  value: unknown,
  label: string,
  maximum: bigint = MAX_UINT256
): string {
  const parsed = readString(value, label, 78)
  if (!/^(?:0|[1-9][0-9]*)$/.test(parsed)) {
    throw new Error(`${label} must be an unsigned decimal string`)
  }
  if (BigInt(parsed) > maximum) throw new Error(`${label} exceeds its unsigned integer range`)
  return parsed
}

export function readHex(
  value: unknown,
  label: string,
  options?: { bytes?: number; maximumBytes?: number }
): string {
  const maximum = options?.bytes ?? options?.maximumBytes ?? 1024 * 1024
  const parsed = readString(value, label, maximum * 2 + 2)
  if (!/^0x(?:[0-9a-f]{2})*$/.test(parsed)) throw new Error(`${label} must be lowercase hex`)
  if (options?.bytes !== undefined && parsed.length !== options.bytes * 2 + 2) {
    throw new Error(`${label} has the wrong byte length`)
  }
  return parsed
}

function readRawHex(
  value: unknown,
  label: string,
  options: { bytes?: number; minimumBytes?: number; maximumBytes?: number }
): string {
  const maximum = (options.bytes ?? options.maximumBytes ?? 2 * 1024 * 1024) * 2
  const parsed = readString(value, label, maximum)
  if (!/^(?:[0-9a-f]{2})+$/.test(parsed)) {
    throw new Error(`${label} must be canonical lowercase hex`)
  }
  if (options.bytes !== undefined && parsed.length !== options.bytes * 2) {
    throw new Error(`${label} has the wrong byte length`)
  }
  if (options.minimumBytes !== undefined && parsed.length < options.minimumBytes * 2) {
    throw new Error(`${label} is too short`)
  }
  return parsed
}

function readBase64(value: unknown, label: string, maximum = 4 * 1024 * 1024): string {
  const parsed = readString(value, label, maximum)
  if (
    parsed.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(parsed)
  ) {
    throw new Error(`${label} must be canonical base64`)
  }
  return parsed
}

export function readLiteral<T extends string | number>(
  value: unknown,
  allowed: readonly T[],
  label: string
): T {
  if (!allowed.includes(value as T)) throw new Error(`${label} is invalid`)
  return value as T
}

export function readArray<T>(
  value: unknown,
  label: string,
  parse: (item: unknown, index: number) => T,
  maximum = 512
): readonly T[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} must be a bounded array`)
  }
  return Object.freeze(value.map(parse))
}

export interface RawEncryptedVault {
  readonly version: number
  readonly kdf: 'argon2id'
  readonly kdfParams: {
    readonly memoryKib: number
    readonly iterations: number
    readonly parallelism: number
  }
  readonly cipher: 'xchacha20poly1305'
  readonly salt: string
  readonly nonce: string
  readonly ciphertext: string
}

export function parseRawEncryptedVault(value: unknown): RawEncryptedVault {
  const record = readRecord(value, 'EncryptedVault')
  assertExactKeys(
    record,
    ['version', 'kdf', 'kdfParams', 'cipher', 'salt', 'nonce', 'ciphertext'],
    [],
    'EncryptedVault'
  )
  const params = readRecord(record.kdfParams, 'EncryptedVault.kdfParams')
  assertExactKeys(
    params,
    ['memoryKib', 'iterations', 'parallelism'],
    [],
    'EncryptedVault.kdfParams'
  )
  const version = readLiteral(record.version, [1, 2], 'EncryptedVault.version')
  const memoryKib = readSafeInteger(params.memoryKib, 'EncryptedVault.kdfParams.memoryKib')
  const iterations = readSafeInteger(params.iterations, 'EncryptedVault.kdfParams.iterations')
  const parallelism = readSafeInteger(params.parallelism, 'EncryptedVault.kdfParams.parallelism')
  // Existing vaults use 19 MiB and 2 iterations. New wallets use version 2 with 64 MiB and 3 iterations.
  const legacyKdf = memoryKib === 19 * 1024 && iterations === 2
  const currentKdf = memoryKib === 64 * 1024 && iterations === 3
  if (parallelism !== 1 || (!legacyKdf && !(version === 2 && currentKdf))) {
    throw new Error('EncryptedVault KDF parameters do not match the pinned ABI')
  }
  return Object.freeze({
    version,
    kdf: readLiteral(record.kdf, ['argon2id'], 'EncryptedVault.kdf'),
    kdfParams: Object.freeze({
      memoryKib,
      iterations,
      parallelism
    }),
    cipher: readLiteral(record.cipher, ['xchacha20poly1305'], 'EncryptedVault.cipher'),
    salt: readRawHex(record.salt, 'EncryptedVault.salt', { bytes: 16 }),
    nonce: readRawHex(record.nonce, 'EncryptedVault.nonce', { bytes: 24 }),
    ciphertext: readRawHex(record.ciphertext, 'EncryptedVault.ciphertext', {
      minimumBytes: 16,
      maximumBytes: 8_192
    })
  })
}

export function parseRawCreatedWallet(value: unknown): {
  readonly mnemonic: string
  readonly vault: RawEncryptedVault
} {
  const record = readRecord(value, 'CreatedWallet')
  assertExactKeys(record, ['mnemonic', 'vault'], [], 'CreatedWallet')
  const mnemonic = readString(record.mnemonic, 'CreatedWallet.mnemonic', 512)
  const wordCount = mnemonic.split(' ').length
  if (wordCount !== 12 && wordCount !== 24) throw new Error('CreatedWallet mnemonic is invalid')
  return Object.freeze({ mnemonic, vault: parseRawEncryptedVault(record.vault) })
}

export interface RawSessionInfo {
  readonly sessionId: number
  readonly kind: 'mnemonic' | 'private_key'
  readonly chainFamily?: RawPrivateKeyChainFamily
  readonly bitcoinNetwork?: RawBitcoinNetwork
  readonly pearlNetwork?: RawPearlKeyNetwork
  readonly quantusScheme?: RawQuantusScheme
}

function parseRawPearlKeyNetwork(value: unknown, label: string): RawPearlKeyNetwork {
  return readLiteral(value, ['mainnet', 'testnet2'], label)
}

export function parseRawQuantusScheme(value: unknown, label: string): RawQuantusScheme {
  return readLiteral(value, RAW_QUANTUS_SCHEMES, label)
}

export function parseRawSessionInfo(value: unknown): RawSessionInfo {
  const record = readRecord(value, 'Session')
  assertExactKeys(
    record,
    ['sessionId', 'kind'],
    [
      'chainFamily',
      'bitcoinNetwork',
      'pearlNetwork',
      'dashNetwork',
      'quantusScheme',
      'starknetAccountAddress'
    ],
    'Session'
  )
  const sessionId = readSafeInteger(record.sessionId, 'Session.sessionId')
  if (sessionId === 0) throw new Error('Session.sessionId must be positive')
  const kind = readLiteral(record.kind, ['mnemonic', 'private_key'], 'Session.kind')
  const quantusScheme =
    record.quantusScheme === undefined
      ? undefined
      : parseRawQuantusScheme(record.quantusScheme, 'Session.quantusScheme')
  if (kind === 'mnemonic') {
    if (
      record.chainFamily !== undefined ||
      record.bitcoinNetwork !== undefined ||
      record.pearlNetwork !== undefined
    ) {
      throw new Error('Mnemonic Session must not expose a private-key scope')
    }
    return Object.freeze({
      sessionId,
      kind,
      ...(quantusScheme === undefined ? {} : { quantusScheme })
    })
  }
  const chainFamily = readLiteral(
    record.chainFamily,
    ['eip155', 'bip122', 'solana', 'near', 'pearl'],
    'Session.chainFamily'
  )
  const bitcoinNetwork =
    record.bitcoinNetwork === undefined
      ? undefined
      : readLiteral(record.bitcoinNetwork, ['mainnet', 'testnet'], 'Session.bitcoinNetwork')
  const pearlNetwork =
    record.pearlNetwork === undefined
      ? undefined
      : parseRawPearlKeyNetwork(record.pearlNetwork, 'Session.pearlNetwork')
  if (
    (chainFamily !== 'bip122' && bitcoinNetwork !== undefined) ||
    (chainFamily === 'bip122' && bitcoinNetwork === undefined) ||
    (chainFamily !== 'pearl' && pearlNetwork !== undefined) ||
    (chainFamily === 'pearl' && pearlNetwork === undefined)
  ) {
    throw new Error('Private-key Session scope is invalid')
  }
  return Object.freeze({
    sessionId,
    kind,
    chainFamily,
    ...(bitcoinNetwork === undefined ? {} : { bitcoinNetwork }),
    ...(pearlNetwork === undefined ? {} : { pearlNetwork }),
    ...(quantusScheme === undefined ? {} : { quantusScheme })
  })
}

export interface RawDerivedAccount {
  readonly accountId: string
  readonly address: string
  readonly derivationPath: string
  readonly publicKey: string
  readonly curve: 'secp256k1'
  readonly addressScheme: 'evm'
  readonly derivationScheme: 'bip44' | 'imported'
}

export interface RawDerivedEd25519Account {
  readonly accountId: string
  readonly address: string
  readonly derivationPath: string
  readonly publicKey: string
  readonly curve: 'ed25519'
  readonly addressScheme: 'solana' | 'near'
  readonly derivationScheme: 'slip10' | 'imported'
}

export interface RawDerivedPeaAccount {
  readonly address: string
  readonly publicKey: string
  readonly curve: 'secp256k1'
  readonly derivationScheme: 'pea_v1'
  readonly parent: Readonly<{ readonly addressIndex: number }>
}

export interface RawPeaExecutionAccount extends RawDerivedPeaAccount {
  readonly executionChainId: string
  readonly accountId: string
}

export function globalPeaRequestJson(addressIndex: number): string {
  return JSON.stringify({ version: 1, parent: { addressIndex } })
}

function parseRawPeaIdentity(
  value: unknown,
  options: Readonly<{ executionChainId?: string }> = {}
): RawDerivedPeaAccount | RawPeaExecutionAccount {
  const label = options.executionChainId === undefined ? 'DerivedPeaAccount' : 'PeaExecutionAccount'
  const record = readRecord(value, label)
  assertExactKeys(
    record,
    ['address', 'publicKey', 'curve', 'derivationScheme', 'parent'],
    options.executionChainId === undefined ? [] : ['executionChainId', 'accountId'],
    label
  )
  if (
    options.executionChainId !== undefined &&
    (!Object.prototype.hasOwnProperty.call(record, 'executionChainId') ||
      !Object.prototype.hasOwnProperty.call(record, 'accountId'))
  ) {
    throw new Error(`${label} is missing its execution scope`)
  }
  const address = readString(record.address, `${label}.address`, 42)
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`${label} address is invalid`)
  const publicKey = readHex(record.publicKey, `${label}.publicKey`)
  if (!/^0x0[23][0-9a-f]{64}$/.test(publicKey)) {
    throw new Error(`${label} public key is invalid`)
  }
  const parent = readRecord(record.parent, `${label}.parent`)
  assertExactKeys(parent, ['addressIndex'], [], `${label}.parent`)
  const account = {
    address,
    publicKey,
    curve: readLiteral(record.curve, ['secp256k1'], `${label}.curve`),
    derivationScheme: readLiteral(record.derivationScheme, ['pea_v1'], `${label}.derivationScheme`),
    parent: Object.freeze({
      addressIndex: readSafeInteger(
        parent.addressIndex,
        `${label}.parent.addressIndex`,
        MAX_BIP32_INDEX
      )
    })
  } as const
  if (options.executionChainId === undefined) return Object.freeze(account)
  const executionChainId = readString(record.executionChainId, `${label}.executionChainId`, 64)
  const accountId = readString(record.accountId, `${label}.accountId`, 256)
  if (
    executionChainId !== options.executionChainId ||
    accountId !== `${executionChainId}:${address}`
  ) {
    throw new Error(`${label} execution scope is invalid`)
  }
  return Object.freeze({ ...account, executionChainId, accountId })
}

export function parseRawGlobalPeaAccount(
  value: unknown,
  addressIndex: number
): RawDerivedPeaAccount {
  const account = parseRawPeaIdentity(value)
  if ('executionChainId' in account || account.parent.addressIndex !== addressIndex) {
    throw new Error('Derived PEA does not match its parent account')
  }
  return account
}

export function parseRawPeaExecutionAccount(
  value: unknown,
  executionChainId: string,
  addressIndex: number
): RawPeaExecutionAccount {
  const account = parseRawPeaIdentity(value, { executionChainId })
  if (!('executionChainId' in account) || account.parent.addressIndex !== addressIndex) {
    throw new Error('PEA execution account does not match its request')
  }
  return account
}

export function parseRawEvmAccount(value: unknown): RawDerivedAccount {
  const record = readRecord(value, 'DerivedEvmAccount')
  assertExactKeys(
    record,
    [
      'accountId',
      'address',
      'derivationPath',
      'publicKey',
      'curve',
      'addressScheme',
      'derivationScheme'
    ],
    [],
    'DerivedEvmAccount'
  )
  const address = readString(record.address, 'DerivedEvmAccount.address', 42)
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('Derived EVM address is invalid')
  const publicKey = readHex(record.publicKey, 'DerivedEvmAccount.publicKey')
  if (!/^0x0[23][0-9a-f]{64}$/.test(publicKey)) {
    throw new Error('Derived EVM public key is invalid')
  }
  return Object.freeze({
    accountId: readString(record.accountId, 'DerivedEvmAccount.accountId', 256),
    address,
    derivationPath: readString(record.derivationPath, 'DerivedEvmAccount.derivationPath', 128),
    publicKey,
    curve: readLiteral(record.curve, ['secp256k1'], 'DerivedEvmAccount.curve'),
    addressScheme: readLiteral(record.addressScheme, ['evm'], 'DerivedEvmAccount.addressScheme'),
    derivationScheme: readLiteral(
      record.derivationScheme,
      ['bip44', 'imported'],
      'DerivedEvmAccount.derivationScheme'
    )
  })
}

export function parseRawEd25519Account(
  value: unknown,
  family: 'solana' | 'near'
): RawDerivedEd25519Account {
  const label = family === 'solana' ? 'DerivedSolanaAccount' : 'DerivedNearAccount'
  const record = readRecord(value, label)
  assertExactKeys(
    record,
    [
      'accountId',
      'address',
      'derivationPath',
      'publicKey',
      'curve',
      'addressScheme',
      'derivationScheme'
    ],
    [],
    label
  )
  const address = readString(record.address, `${label}.address`, 128)
  const publicKey = readString(record.publicKey, `${label}.publicKey`, 128)
  if (
    (family === 'solana' &&
      (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) || publicKey !== address)) ||
    (family === 'near' &&
      (!/^[0-9a-f]{64}$/.test(address) || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(publicKey)))
  ) {
    throw new Error(`${label} identity is invalid`)
  }
  return Object.freeze({
    accountId: readString(record.accountId, `${label}.accountId`, 256),
    address,
    derivationPath: readString(record.derivationPath, `${label}.derivationPath`, 128),
    publicKey,
    curve: readLiteral(record.curve, ['ed25519'], `${label}.curve`),
    addressScheme: readLiteral(record.addressScheme, [family], `${label}.addressScheme`),
    derivationScheme: readLiteral(
      record.derivationScheme,
      ['slip10', 'imported'],
      `${label}.derivationScheme`
    )
  })
}

export function assertRawEd25519AccountMatches(
  account: RawDerivedEd25519Account,
  family: 'solana' | 'near',
  chainId: string,
  accountIndex: number,
  imported = false
): void {
  const expectedPath =
    family === 'solana' ? `m/44'/501'/${accountIndex}'/0'` : `m/44'/397'/${accountIndex}'`
  if (
    account.accountId !== `${chainId}:${account.address}` ||
    account.addressScheme !== family ||
    account.derivationScheme !== (imported ? 'imported' : 'slip10') ||
    account.derivationPath !== (imported ? 'm' : expectedPath) ||
    (imported && accountIndex !== 0)
  ) {
    throw new Error(`Derived ${family} account does not match its request`)
  }
}

export interface RawDerivedBitcoinAccount extends Omit<
  RawDerivedAccount,
  'addressScheme' | 'derivationScheme'
> {
  readonly addressScheme:
    | 'bitcoin_p2pkh'
    | 'bitcoin_p2sh_p2wpkh'
    | 'bitcoin_p2wpkh'
    | 'bitcoin_p2tr'
  readonly derivationScheme: 'bip44' | 'bip49' | 'bip84' | 'bip86' | 'imported'
  readonly masterFingerprint: string
  readonly network: 'mainnet' | 'testnet'
  readonly scriptPubKey: string
  readonly redeemScript?: string
}

export function rawBitcoinAddressProfile(addressType: RawBitcoinAddressType) {
  switch (addressType) {
    case 'p2pkh':
      return Object.freeze({
        addressScheme: 'bitcoin_p2pkh' as const,
        derivationScheme: 'bip44' as const,
        purpose: 44 as const
      })
    case 'p2sh_p2wpkh':
      return Object.freeze({
        addressScheme: 'bitcoin_p2sh_p2wpkh' as const,
        derivationScheme: 'bip49' as const,
        purpose: 49 as const
      })
    case 'p2wpkh':
      return Object.freeze({
        addressScheme: 'bitcoin_p2wpkh' as const,
        derivationScheme: 'bip84' as const,
        purpose: 84 as const
      })
    case 'p2tr':
      return Object.freeze({
        addressScheme: 'bitcoin_p2tr' as const,
        derivationScheme: 'bip86' as const,
        purpose: 86 as const
      })
  }
}

export function parseRawBitcoinAccount(value: unknown): RawDerivedBitcoinAccount {
  const record = readRecord(value, 'DerivedBitcoinAccount')
  assertExactKeys(
    record,
    [
      'accountId',
      'address',
      'derivationPath',
      'publicKey',
      'curve',
      'addressScheme',
      'derivationScheme',
      'masterFingerprint',
      'network',
      'scriptPubKey'
    ],
    ['redeemScript'],
    'DerivedBitcoinAccount'
  )
  const publicKey = readHex(record.publicKey, 'DerivedBitcoinAccount.publicKey')
  if (!/^0x0[23][0-9a-f]{64}$/.test(publicKey)) {
    throw new Error('Derived Bitcoin public key is invalid')
  }
  const account = Object.freeze({
    accountId: readString(record.accountId, 'DerivedBitcoinAccount.accountId', 256),
    address: readString(record.address, 'DerivedBitcoinAccount.address', 128),
    derivationPath: readString(record.derivationPath, 'DerivedBitcoinAccount.derivationPath', 128),
    publicKey,
    curve: readLiteral(record.curve, ['secp256k1'], 'DerivedBitcoinAccount.curve'),
    addressScheme: readLiteral(
      record.addressScheme,
      ['bitcoin_p2pkh', 'bitcoin_p2sh_p2wpkh', 'bitcoin_p2wpkh', 'bitcoin_p2tr'],
      'DerivedBitcoinAccount.addressScheme'
    ),
    derivationScheme: readLiteral(
      record.derivationScheme,
      ['bip44', 'bip49', 'bip84', 'bip86', 'imported'],
      'DerivedBitcoinAccount.derivationScheme'
    ),
    masterFingerprint: readHex(
      record.masterFingerprint,
      'DerivedBitcoinAccount.masterFingerprint',
      { bytes: 4 }
    ),
    network: readLiteral(record.network, ['mainnet', 'testnet'], 'DerivedBitcoinAccount.network'),
    scriptPubKey: readHex(record.scriptPubKey, 'DerivedBitcoinAccount.scriptPubKey'),
    ...(record.redeemScript === undefined
      ? {}
      : { redeemScript: readHex(record.redeemScript, 'DerivedBitcoinAccount.redeemScript') })
  })
  const validAddress =
    account.addressScheme === 'bitcoin_p2pkh'
      ? account.network === 'mainnet'
        ? account.address.startsWith('1')
        : account.address.startsWith('m') || account.address.startsWith('n')
      : account.addressScheme === 'bitcoin_p2sh_p2wpkh'
        ? account.address.startsWith(account.network === 'mainnet' ? '3' : '2')
        : account.address.startsWith(
            account.network === 'mainnet'
              ? account.addressScheme === 'bitcoin_p2wpkh'
                ? 'bc1q'
                : 'bc1p'
              : account.addressScheme === 'bitcoin_p2wpkh'
                ? 'tb1q'
                : 'tb1p'
          )
  const validScript =
    account.addressScheme === 'bitcoin_p2pkh'
      ? /^0x76a914[0-9a-f]{40}88ac$/.test(account.scriptPubKey)
      : account.addressScheme === 'bitcoin_p2sh_p2wpkh'
        ? /^0xa914[0-9a-f]{40}87$/.test(account.scriptPubKey) &&
          /^0x0014[0-9a-f]{40}$/.test(account.redeemScript ?? '')
        : account.addressScheme === 'bitcoin_p2wpkh'
          ? /^0x0014[0-9a-f]{40}$/.test(account.scriptPubKey)
          : /^0x5120[0-9a-f]{64}$/.test(account.scriptPubKey)
  if (
    !validAddress ||
    !validScript ||
    (account.addressScheme !== 'bitcoin_p2sh_p2wpkh' && account.redeemScript !== undefined)
  ) {
    throw new Error('Derived Bitcoin address or script is invalid')
  }
  return account
}

export function assertRawEvmAccountMatches(
  account: RawDerivedAccount,
  chainId: string,
  addressIndex: number,
  imported = false
): void {
  if (
    account.accountId !== `${chainId}:${account.address}` ||
    account.derivationScheme !== (imported ? 'imported' : 'bip44') ||
    account.derivationPath !== (imported ? 'm' : `m/44'/60'/0'/0/${addressIndex}`) ||
    (imported && addressIndex !== 0)
  ) {
    throw new Error('Derived EVM account does not match its request')
  }
}

export function assertRawBitcoinAccountMatches(
  account: RawDerivedBitcoinAccount,
  chainId: string,
  addressType: RawBitcoinAddressType,
  accountIndex: number,
  change: boolean,
  addressIndex: number,
  imported = false
): void {
  const mainnet = chainId === 'bip122:000000000019d6689c085ae165831e93'
  const expectedNetwork = mainnet ? 'mainnet' : 'testnet'
  const profile = rawBitcoinAddressProfile(addressType)
  const coinType = mainnet ? 0 : 1
  const expectedPath = imported
    ? 'm'
    : `m/${profile.purpose}'/${coinType}'/${accountIndex}'/${change ? 1 : 0}/${addressIndex}`
  if (
    account.accountId !== `${chainId}:${account.address}` ||
    account.network !== expectedNetwork ||
    account.addressScheme !== profile.addressScheme ||
    account.derivationScheme !== (imported ? 'imported' : profile.derivationScheme) ||
    account.derivationPath !== expectedPath ||
    (imported && (accountIndex !== 0 || change || addressIndex !== 0))
  ) {
    throw new Error('Derived Bitcoin account does not match its request')
  }
}

export interface RawDerivedPearlAccount extends Omit<
  RawDerivedAccount,
  'addressScheme' | 'derivationScheme'
> {
  readonly addressScheme: 'pearl_p2tr'
  readonly derivationScheme: 'bip86' | 'imported'
  readonly masterFingerprint: string
  readonly network: RawPearlNetwork
  readonly scriptPubKey: string
}

const PEARL_MAINNET_CHAIN_ID = 'bip122:a18d3093b7ff618f0cdd073fa3d10374'
const PEARL_TESTNET_CHAIN_ID = 'bip122:b0c86d0cd8825f4d72260d2de46f4704'

export function parseRawPearlAccount(value: unknown): RawDerivedPearlAccount {
  const record = readRecord(value, 'DerivedPearlAccount')
  assertExactKeys(
    record,
    [
      'accountId',
      'address',
      'derivationPath',
      'publicKey',
      'curve',
      'addressScheme',
      'derivationScheme',
      'masterFingerprint',
      'network',
      'scriptPubKey'
    ],
    [],
    'DerivedPearlAccount'
  )
  const publicKey = readHex(record.publicKey, 'DerivedPearlAccount.publicKey')
  if (!/^0x0[23][0-9a-f]{64}$/.test(publicKey)) {
    throw new Error('Derived Pearl public key is invalid')
  }
  const account = Object.freeze({
    accountId: readString(record.accountId, 'DerivedPearlAccount.accountId', 256),
    address: readString(record.address, 'DerivedPearlAccount.address', 128),
    derivationPath: readString(record.derivationPath, 'DerivedPearlAccount.derivationPath', 128),
    publicKey,
    curve: readLiteral(record.curve, ['secp256k1'], 'DerivedPearlAccount.curve'),
    addressScheme: readLiteral(
      record.addressScheme,
      ['pearl_p2tr'],
      'DerivedPearlAccount.addressScheme'
    ),
    derivationScheme: readLiteral(
      record.derivationScheme,
      ['bip86', 'imported'],
      'DerivedPearlAccount.derivationScheme'
    ),
    masterFingerprint: readHex(record.masterFingerprint, 'DerivedPearlAccount.masterFingerprint', {
      bytes: 4
    }),
    network: readLiteral(
      record.network,
      ['mainnet', 'testnet2', 'regtest'],
      'DerivedPearlAccount.network'
    ),
    scriptPubKey: readHex(record.scriptPubKey, 'DerivedPearlAccount.scriptPubKey')
  })
  const validAddress =
    account.network === 'mainnet'
      ? account.address.startsWith('prl1p')
      : account.network === 'testnet2'
        ? account.address.startsWith('tprl1p')
        : account.address.startsWith('rprl1p')
  if (!validAddress || !/^0x5120[0-9a-f]{64}$/.test(account.scriptPubKey)) {
    throw new Error('Derived Pearl address or script is invalid')
  }
  return account
}

export function assertRawPearlAccountMatches(
  account: RawDerivedPearlAccount,
  chainId: string,
  accountIndex: number,
  change: boolean,
  addressIndex: number,
  imported = false
): void {
  const expectedNetwork =
    chainId === PEARL_MAINNET_CHAIN_ID
      ? 'mainnet'
      : chainId === PEARL_TESTNET_CHAIN_ID
        ? 'testnet2'
        : null
  if (expectedNetwork === null) {
    throw new Error('Unsupported Pearl chain ID')
  }
  const coinType = expectedNetwork === 'mainnet' ? 808276 : 1
  const expectedPath = imported
    ? 'm'
    : `m/86'/${coinType}'/${accountIndex}'/${change ? 1 : 0}/${addressIndex}`
  if (
    account.accountId !== `${chainId}:${account.address}` ||
    account.network !== expectedNetwork ||
    account.addressScheme !== 'pearl_p2tr' ||
    account.derivationScheme !== (imported ? 'imported' : 'bip86') ||
    account.derivationPath !== expectedPath ||
    (imported && (accountIndex !== 0 || change || addressIndex !== 0))
  ) {
    throw new Error('Derived Pearl account does not match its request')
  }
}

/** FIPS 204 public-key sizes for the two supported Quantus schemes. */
const QUANTUS_PUBLIC_KEY_BYTES: Readonly<Record<RawQuantusScheme, number>> = Object.freeze({
  'ml-dsa-87': 2592,
  'ml-dsa-65': 1952
})
const QUANTUS_CURVES: Readonly<Record<RawQuantusScheme, 'ml_dsa87' | 'ml_dsa65'>> = Object.freeze({
  'ml-dsa-87': 'ml_dsa87',
  'ml-dsa-65': 'ml_dsa65'
})
export const RAW_QUANTUS_NETWORKS = Object.freeze(['mainnet', 'dev', 'heisenberg'] as const)
export type RawQuantusNetwork = (typeof RAW_QUANTUS_NETWORKS)[number]

export interface RawDerivedQuantusAccount {
  readonly accountId: string
  readonly address: string
  readonly derivationPath: string
  readonly publicKey: string
  readonly curve: 'ml_dsa87' | 'ml_dsa65'
  readonly addressScheme: 'quantus'
  readonly derivationScheme: 'bip44' | 'imported'
  readonly scheme: RawQuantusScheme
  readonly network: RawQuantusNetwork
}

export function parseRawQuantusAccount(value: unknown): RawDerivedQuantusAccount {
  const record = readRecord(value, 'DerivedQuantusAccount')
  assertExactKeys(
    record,
    [
      'accountId',
      'address',
      'derivationPath',
      'publicKey',
      'curve',
      'addressScheme',
      'derivationScheme',
      'scheme',
      'network'
    ],
    [],
    'DerivedQuantusAccount'
  )
  const scheme = parseRawQuantusScheme(record.scheme, 'DerivedQuantusAccount.scheme')
  const curve = readLiteral(record.curve, ['ml_dsa87', 'ml_dsa65'], 'DerivedQuantusAccount.curve')
  if (curve !== QUANTUS_CURVES[scheme]) {
    throw new Error('Derived Quantus curve does not match its scheme')
  }
  const addressScheme = readLiteral(
    record.addressScheme,
    ['quantus'],
    'DerivedQuantusAccount.addressScheme'
  )
  const derivationScheme = readLiteral(
    record.derivationScheme,
    ['bip44', 'imported'],
    'DerivedQuantusAccount.derivationScheme'
  )
  if (derivationScheme === 'bip44') {
    return Object.freeze({
      accountId: readHex(record.accountId, 'DerivedQuantusAccount.accountId', { bytes: 32 }),
      address: readString(record.address, 'DerivedQuantusAccount.address', 128),
      derivationPath: readString(
        record.derivationPath,
        'DerivedQuantusAccount.derivationPath',
        128
      ),
      publicKey: readHex(record.publicKey, 'DerivedQuantusAccount.publicKey', {
        bytes: QUANTUS_PUBLIC_KEY_BYTES[scheme]
      }),
      curve,
      addressScheme,
      derivationScheme,
      scheme,
      network: readLiteral(record.network, RAW_QUANTUS_NETWORKS, 'DerivedQuantusAccount.network')
    })
  }
  return Object.freeze({
    accountId: readHex(record.accountId, 'DerivedQuantusAccount.accountId', { bytes: 32 }),
    address: readString(record.address, 'DerivedQuantusAccount.address', 128),
    derivationPath: readString(record.derivationPath, 'DerivedQuantusAccount.derivationPath', 128),
    publicKey: readHex(record.publicKey, 'DerivedQuantusAccount.publicKey', {
      bytes: QUANTUS_PUBLIC_KEY_BYTES[scheme]
    }),
    curve,
    addressScheme,
    derivationScheme,
    scheme,
    network: readLiteral(record.network, RAW_QUANTUS_NETWORKS, 'DerivedQuantusAccount.network')
  })
}

/**
 * Asserts that a derived Quantus account answers the exact request that produced
 * it, and that the WASM network label matches the host chain ID.
 */
export function assertRawQuantusAccountMatches(
  account: RawDerivedQuantusAccount,
  scheme: RawQuantusScheme,
  accountIndex: number,
  change: boolean,
  addressIndex: number,
  expectedNetwork: RawQuantusNetwork,
  imported = false
): void {
  const expectedPath = imported
    ? 'm'
    : `m/44'/189189'/${accountIndex}'/${change ? 1 : 0}'/${addressIndex}'`
  if (
    account.scheme !== scheme ||
    account.network !== expectedNetwork ||
    account.derivationPath !== expectedPath ||
    account.derivationScheme !== (imported ? 'imported' : 'bip44') ||
    (imported && (accountIndex !== 0 || change || addressIndex !== 0))
  ) {
    throw new Error('Derived Quantus account does not match its request')
  }
}

export interface RawExportedPrivateKey {
  readonly chainId: string
  readonly format: 'hex' | 'wif' | 'base58' | 'near_ed25519'
  readonly privateKey: string
  readonly hex: string
}

export function parseRawExportedPrivateKey(value: unknown): RawExportedPrivateKey {
  const record = readRecord(value, 'ExportedPrivateKey')
  assertExactKeys(record, ['chainId', 'format', 'privateKey', 'hex'], [], 'ExportedPrivateKey')
  const chainId = readString(record.chainId, 'ExportedPrivateKey.chainId', 64)
  const format = readLiteral(
    record.format,
    ['hex', 'wif', 'base58', 'near_ed25519'],
    'ExportedPrivateKey.format'
  )
  const privateKey = readString(record.privateKey, 'ExportedPrivateKey.privateKey', 256)
  const hex = readHex(record.hex, 'ExportedPrivateKey.hex', { bytes: 32 })
  if (
    (chainId.startsWith('eip155:') &&
      (format !== 'hex' || privateKey !== hex || !/^0x[0-9a-f]{64}$/.test(privateKey))) ||
    (chainId.startsWith('bip122:') &&
      (format !== 'wif' || !/^[KL5c9][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(privateKey))) ||
    (chainId.startsWith('solana:') &&
      (format !== 'base58' || !/^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(privateKey))) ||
    (chainId.startsWith('near:') &&
      (format !== 'near_ed25519' || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(privateKey))) ||
    (!chainId.startsWith('eip155:') &&
      !chainId.startsWith('bip122:') &&
      !chainId.startsWith('solana:') &&
      !chainId.startsWith('near:'))
  ) {
    throw new Error('Exported private key does not match its chain')
  }
  return Object.freeze({ chainId, format, privateKey, hex })
}

export interface RawPreparedValue {
  readonly requestId: number
  readonly value: UnknownRecord
}

export function parseRawPreparedValue(value: unknown, label: string): RawPreparedValue {
  const record = readRecord(value, label)
  const requestId = readSafeInteger(record.requestId, `${label}.requestId`)
  if (requestId === 0) throw new Error(`${label}.requestId must be positive`)
  return { requestId, value: record }
}

export function parseRawSignedEvmTransaction(value: unknown) {
  const record = readRecord(value, 'SignedEvmTransaction')
  assertExactKeys(
    record,
    ['rawTransaction', 'transactionHash', 'signature'],
    [],
    'SignedEvmTransaction'
  )
  const rawTransaction = readHex(record.rawTransaction, 'SignedEvmTransaction.rawTransaction')
  if (rawTransaction === '0x') throw new Error('SignedEvmTransaction.rawTransaction is empty')
  return Object.freeze({
    rawTransaction,
    transactionHash: readHex(record.transactionHash, 'SignedEvmTransaction.transactionHash', {
      bytes: 32
    }),
    signature: readHex(record.signature, 'SignedEvmTransaction.signature', { bytes: 65 })
  })
}

export function parseRawSignedEvmMessage(value: unknown) {
  const record = readRecord(value, 'SignedEvmMessage')
  assertExactKeys(record, ['signature', 'signingHash'], [], 'SignedEvmMessage')
  return Object.freeze({
    signature: readHex(record.signature, 'SignedEvmMessage.signature', { bytes: 65 }),
    signingHash: readHex(record.signingHash, 'SignedEvmMessage.signingHash', { bytes: 32 })
  })
}

export function parseRawSignedBitcoinPsbt(value: unknown) {
  const record = readRecord(value, 'SignedBitcoinPsbt')
  assertExactKeys(record, ['psbt', 'unsignedTxid', 'signedInputIndexes'], [], 'SignedBitcoinPsbt')
  const unsignedTxid = readString(record.unsignedTxid, 'SignedBitcoinPsbt.unsignedTxid', 64)
  if (!/^[0-9a-f]{64}$/.test(unsignedTxid)) {
    throw new Error('SignedBitcoinPsbt.unsignedTxid is invalid')
  }
  const signedInputIndexes = readArray(
    record.signedInputIndexes,
    'SignedBitcoinPsbt.signedInputIndexes',
    (item, index) => readSafeInteger(item, `SignedBitcoinPsbt.signedInputIndexes[${index}]`, 511)
  )
  if (
    signedInputIndexes.length === 0 ||
    new Set(signedInputIndexes).size !== signedInputIndexes.length
  ) {
    throw new Error('SignedBitcoinPsbt.signedInputIndexes is invalid')
  }
  return Object.freeze({
    psbt: readBase64(record.psbt, 'SignedBitcoinPsbt.psbt'),
    unsignedTxid,
    signedInputIndexes
  })
}

export function parseRawSignedBitcoinMessage(value: unknown) {
  const record = readRecord(value, 'SignedBitcoinMessage')
  assertExactKeys(
    record,
    ['signature', 'payloadBase64', 'address', 'messageHash'],
    ['witnessBase64'],
    'SignedBitcoinMessage'
  )
  const signature = readString(record.signature, 'SignedBitcoinMessage.signature', 16_384)
  if (!signature.startsWith('smp') && !signature.startsWith('ful')) {
    throw new Error('SignedBitcoinMessage.signature is invalid')
  }
  const payloadBase64 = readBase64(record.payloadBase64, 'SignedBitcoinMessage.payloadBase64')
  const witnessBase64 =
    record.witnessBase64 === undefined
      ? undefined
      : readBase64(record.witnessBase64, 'SignedBitcoinMessage.witnessBase64')
  if (
    signature.slice(3) !== payloadBase64 ||
    (signature.startsWith('smp') && witnessBase64 !== payloadBase64) ||
    (signature.startsWith('ful') && witnessBase64 !== undefined)
  ) {
    throw new Error('SignedBitcoinMessage signature and payload do not match')
  }
  return Object.freeze({
    signature,
    payloadBase64,
    ...(witnessBase64 === undefined ? {} : { witnessBase64 }),
    address: readString(record.address, 'SignedBitcoinMessage.address', 128),
    messageHash: readHex(record.messageHash, 'SignedBitcoinMessage.messageHash', { bytes: 32 })
  })
}

export function parseRawSignedPearlPsbt(value: unknown) {
  const record = readRecord(value, 'SignedPearlPsbt')
  assertExactKeys(record, ['psbt', 'unsignedTxid', 'signedInputIndexes'], [], 'SignedPearlPsbt')
  const unsignedTxid = readString(record.unsignedTxid, 'SignedPearlPsbt.unsignedTxid', 64)
  if (!/^[0-9a-f]{64}$/.test(unsignedTxid)) {
    throw new Error('SignedPearlPsbt.unsignedTxid is invalid')
  }
  const signedInputIndexes = readArray(
    record.signedInputIndexes,
    'SignedPearlPsbt.signedInputIndexes',
    (item, index) => readSafeInteger(item, `SignedPearlPsbt.signedInputIndexes[${index}]`, 511)
  )
  if (
    signedInputIndexes.length === 0 ||
    new Set(signedInputIndexes).size !== signedInputIndexes.length
  ) {
    throw new Error('SignedPearlPsbt.signedInputIndexes is invalid')
  }
  return Object.freeze({
    psbt: readBase64(record.psbt, 'SignedPearlPsbt.psbt'),
    unsignedTxid,
    signedInputIndexes
  })
}

export function parseRawSignedPearlMessage(value: unknown) {
  const record = readRecord(value, 'SignedPearlMessage')
  assertExactKeys(
    record,
    ['signature', 'payloadBase64', 'address', 'messageHash'],
    [],
    'SignedPearlMessage'
  )
  const signature = readBase64(record.signature, 'SignedPearlMessage.signature')
  const payloadBase64 = readBase64(record.payloadBase64, 'SignedPearlMessage.payloadBase64')
  if (signature !== payloadBase64) {
    throw new Error('SignedPearlMessage signature and payload do not match')
  }
  return Object.freeze({
    signature,
    payloadBase64,
    address: readString(record.address, 'SignedPearlMessage.address', 128),
    messageHash: readHex(record.messageHash, 'SignedPearlMessage.messageHash', { bytes: 32 })
  })
}

function readBase58String(value: unknown, label: string, maximum = 128): string {
  const parsed = readString(value, label, maximum)
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(parsed)) throw new Error(`${label} must be base58`)
  return parsed
}

export function parseRawSignedSolanaTransaction(value: unknown) {
  const record = readRecord(value, 'SignedSolanaTransaction')
  assertExactKeys(
    record,
    ['transaction', 'signature', 'messageHash'],
    [],
    'SignedSolanaTransaction'
  )
  return Object.freeze({
    transaction: readBase64(record.transaction, 'SignedSolanaTransaction.transaction'),
    signature: readBase58String(record.signature, 'SignedSolanaTransaction.signature'),
    messageHash: readHex(record.messageHash, 'SignedSolanaTransaction.messageHash', { bytes: 32 })
  })
}

export function parseRawSignedSolanaMessage(value: unknown) {
  const record = readRecord(value, 'SignedSolanaMessage')
  assertExactKeys(record, ['signature', 'publicKey', 'messageHash'], [], 'SignedSolanaMessage')
  return Object.freeze({
    signature: readBase58String(record.signature, 'SignedSolanaMessage.signature'),
    publicKey: readBase58String(record.publicKey, 'SignedSolanaMessage.publicKey'),
    messageHash: readHex(record.messageHash, 'SignedSolanaMessage.messageHash', { bytes: 32 })
  })
}

export function parseRawSignedNearTransaction(value: unknown) {
  const record = readRecord(value, 'SignedNearTransaction')
  assertExactKeys(
    record,
    ['signedTransaction', 'transactionHash', 'signature'],
    [],
    'SignedNearTransaction'
  )
  const signature = readString(record.signature, 'SignedNearTransaction.signature', 128)
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/.test(signature)) {
    throw new Error('SignedNearTransaction.signature is invalid')
  }
  return Object.freeze({
    signedTransaction: readBase64(
      record.signedTransaction,
      'SignedNearTransaction.signedTransaction'
    ),
    transactionHash: readBase58String(
      record.transactionHash,
      'SignedNearTransaction.transactionHash'
    ),
    signature
  })
}

export function parseRawSignedNearMessage(value: unknown) {
  const record = readRecord(value, 'SignedNearMessage')
  assertExactKeys(
    record,
    ['accountId', 'publicKey', 'signature', 'state', 'signingHash'],
    [],
    'SignedNearMessage'
  )
  const publicKey = readString(record.publicKey, 'SignedNearMessage.publicKey', 128)
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/.test(publicKey)) {
    throw new Error('SignedNearMessage public key is invalid')
  }
  return Object.freeze({
    accountId: readString(record.accountId, 'SignedNearMessage.accountId', 128),
    publicKey,
    signature: readBase64(record.signature, 'SignedNearMessage.signature'),
    state:
      record.state === null
        ? null
        : readBoundedString(record.state, 'SignedNearMessage.state', 4_096),
    signingHash: readHex(record.signingHash, 'SignedNearMessage.signingHash', { bytes: 32 })
  })
}
