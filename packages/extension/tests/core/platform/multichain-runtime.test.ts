import { test } from 'node:test'
import { expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import {
  decodeChromeRuntimeCommand,
  encodeChromeRuntimeCommand
} from '../../../src/infrastructure/keyring/multichain/chrome-runtime-codec'
import {
  parseRawEncryptedVault,
  parseRawSignedNearMessage,
  type RawWalletEngine
} from '../../../src/infrastructure/keyring/multichain/raw-wallet-engine'
import { MultichainWorkerRuntime } from '../../../src/infrastructure/keyring/multichain/worker-runtime'
import { decodeQuantusAccountId } from '../../../src/core/chains/quantus/identifiers'
import { bytesToHex, hexToBytes } from '../../../src/lib/bytes'
import { blake2b } from '@noble/hashes/blake2b'

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const VAULT = Object.freeze({
  version: 1,
  kdf: 'argon2id' as const,
  kdfParams: Object.freeze({ memoryKib: 19 * 1024, iterations: 2, parallelism: 1 }),
  cipher: 'xchacha20poly1305' as const,
  salt: '11'.repeat(16),
  nonce: '22'.repeat(24),
  ciphertext: '33'.repeat(64)
})
const PRIVATE_KEY_VAULT = Object.freeze({
  ...VAULT,
  version: 2,
  ciphertext: '44'.repeat(64)
})
const EVM_ACCOUNT = Object.freeze({
  accountId: 'eip155:1:0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
  address: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
  derivationPath: "m/44'/60'/0'/0/0",
  publicKey: `0x02${'11'.repeat(32)}`,
  curve: 'secp256k1',
  addressScheme: 'evm',
  derivationScheme: 'bip44'
})
const IMPORTED_EVM_ACCOUNT = Object.freeze({
  ...EVM_ACCOUNT,
  derivationPath: 'm',
  derivationScheme: 'imported'
})
const GLOBAL_PEA = Object.freeze({
  address: '0x27B25a8B03F9b80bB7c8Ea8bBa3F826Da0C0C530',
  publicKey: '0x03b4d06703b1d2eabf4adc7aa44289d6ea55d954c6099a3befbff7b3781b297708',
  curve: 'secp256k1' as const,
  derivationScheme: 'pea_v1' as const,
  parent: Object.freeze({ addressIndex: 0 })
})
const SOLANA_ACCOUNT = Object.freeze({
  accountId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:8z7rGBxY1EbsJwk5B4B8Ru4LhVwV9mqgZxYGKf5kSq4D',
  address: '8z7rGBxY1EbsJwk5B4B8Ru4LhVwV9mqgZxYGKf5kSq4D',
  derivationPath: "m/44'/501'/0'/0'",
  publicKey: '8z7rGBxY1EbsJwk5B4B8Ru4LhVwV9mqgZxYGKf5kSq4D',
  curve: 'ed25519',
  addressScheme: 'solana',
  derivationScheme: 'slip10'
})
const NEAR_ACCOUNT = Object.freeze({
  accountId: `near:testnet:${'11'.repeat(32)}`,
  address: '11'.repeat(32),
  derivationPath: "m/44'/397'/0'",
  publicKey: 'ed25519:8z7rGBxY1EbsJwk5B4B8Ru4LhVwV9mqgZxYGKf5kSq4D',
  curve: 'ed25519',
  addressScheme: 'near',
  derivationScheme: 'slip10'
})
const QUANTUS_ADDRESS = 'qzna4bUiEiZdXQpwvSQDmM2y9rBPyJRS9iNm85jPgicM76kA8'
// balances.transfer_keep_alive shape the engine encodes for a native transfer.
const QUANTUS_CALL = `0x020300${'ef'.repeat(32)}070010a5d4e8`
const QUANTUS_CALL_BYTES = hexToBytes(QUANTUS_CALL)
const QUANTUS_CALL_HASH = `0x${bytesToHex(blake2b(QUANTUS_CALL_BYTES, { dkLen: 32 }))}`
const QUANTUS_RECIPIENT = 'qzjTEdq3Wd1d98kaeE1RTDPBBYBfY6XpfCtaLq97wmfcAD8M2'
function quantusPublicKey(scheme: 'ml-dsa-87' | 'ml-dsa-65'): string {
  return `0x${'ab'.repeat(scheme === 'ml-dsa-87' ? 2592 : 1952)}`
}
function quantusAccount(
  scheme: 'ml-dsa-87' | 'ml-dsa-65',
  accountIndex: number,
  change: boolean,
  addressIndex: number,
  network: 'mainnet' | 'dev'
) {
  return {
    accountId: `0x${'cd'.repeat(32)}`,
    address: QUANTUS_ADDRESS,
    derivationPath: `m/44'/189189'/${accountIndex}'/${change ? 1 : 0}'/${addressIndex}'`,
    publicKey: quantusPublicKey(scheme),
    curve: scheme === 'ml-dsa-87' ? ('ml_dsa87' as const) : ('ml_dsa65' as const),
    addressScheme: 'quantus' as const,
    derivationScheme: 'bip44' as const,
    scheme,
    network
  }
}
const BINDING = Object.freeze({
  kind: 'credential',
  keyDomainId: 'key-domain:test',
  credentialGenerationId: 'credential-generation:test',
  globalUnlockEpoch: 'global-unlock:test'
})

class FakeWalletEngine implements RawWalletEngine {
  readonly createPassphrases: string[] = []
  readonly importPassphrases: string[] = []
  readonly createPasswords: string[] = []
  readonly importPasswords: string[] = []
  readonly unlockPasswords: string[] = []
  readonly rejectedRequests: number[] = []
  readonly lockedSessions: number[] = []
  readonly peaRequests: string[] = []
  lockAllCalls = 0
  freeCalls = 0
  nextSessionId = 1
  nextRequestId = 1
  evmAccount: unknown = EVM_ACCOUNT

  coreInfo(): unknown {
    return { apiVersion: 2, vaultVersions: [1, 2], capabilities: [] }
  }

  createWallet(wordCount: number, password: string, bip39Passphrase: string): unknown {
    this.createPasswords.push(password)
    this.createPassphrases.push(bip39Passphrase)
    return {
      mnemonic: wordCount === 12 ? MNEMONIC : `${Array(23).fill('abandon').join(' ')} art`,
      vault: VAULT
    }
  }

  importWallet(_mnemonic: string, password: string, bip39Passphrase: string): unknown {
    this.importPasswords.push(password)
    this.importPassphrases.push(bip39Passphrase)
    return VAULT
  }

  importPrivateKey(_request: unknown, password: string): unknown {
    this.importPasswords.push(password)
    return PRIVATE_KEY_VAULT
  }

  exportPrivateKey(_sessionId: number, _vault: unknown, _password: string): unknown {
    return {
      chainId: 'eip155:1',
      format: 'hex',
      privateKey: `0x${'01'.repeat(32)}`,
      hex: `0x${'01'.repeat(32)}`
    }
  }

  sessionInfo(sessionId: number): unknown {
    return { sessionId, kind: 'mnemonic' }
  }

  unlock(_vault: unknown, password: string): unknown {
    this.unlockPasswords.push(password)
    return {
      sessionId: this.nextSessionId++,
      ...((_vault as { version?: unknown }).version === 2
        ? { kind: 'private_key', chainFamily: 'eip155' }
        : { kind: 'mnemonic' })
    }
  }

  lock(sessionId: number): boolean {
    this.lockedSessions.push(sessionId)
    return true
  }

  lockAll(): void {
    this.lockAllCalls += 1
  }

  deriveEvmAccount(): unknown {
    return this.evmAccount
  }

  derivePeaAccount(_sessionId: number, requestJson: string): unknown {
    this.peaRequests.push(requestJson)
    return GLOBAL_PEA
  }

  deriveSolanaAccount(): unknown {
    return SOLANA_ACCOUNT
  }

  deriveNearAccount(): unknown {
    return NEAR_ACCOUNT
  }

  readonly quantusChainIds: string[] = []
  quantusAccountFor: ((chainId: string) => unknown) | null = null

  deriveQuantusAccount(
    _sessionId: number,
    chainId: string,
    scheme: 'ml-dsa-87' | 'ml-dsa-65',
    accountIndex: number,
    change: boolean,
    addressIndex: number
  ): unknown {
    this.quantusChainIds.push(chainId)
    if (this.quantusAccountFor) return this.quantusAccountFor(chainId)
    return quantusAccount(
      scheme,
      accountIndex,
      change,
      addressIndex,
      chainId === 'quantus:mainnet' ? 'mainnet' : 'dev'
    )
  }

  deriveQuantusAccounts(
    _sessionId: number,
    chainId: string,
    scheme: 'ml-dsa-87' | 'ml-dsa-65',
    accountIndex: number,
    change: boolean,
    startAddressIndex: number,
    count: number
  ): unknown {
    this.quantusChainIds.push(chainId)
    return Array.from({ length: count }, (_, offset) =>
      quantusAccount(
        scheme,
        accountIndex,
        change,
        startAddressIndex + offset,
        chainId === 'quantus:mainnet' ? 'mainnet' : 'dev'
      )
    )
  }

  deriveQuantusWormhole(): never {
    throw new Error('Unexpected Quantus wormhole derivation')
  }

  prepareQuantusCall(): never {
    throw new Error('Unexpected Quantus call prepare')
  }

  readonly quantusTransferRequests: unknown[] = []
  readonly quantusConfirmRequests: number[] = []
  quantusSummaryOverrides: Record<string, unknown> | null = null
  quantusSignedOverrides: Record<string, unknown> | null = null

  readonly quantusNetworkRegistrations: Array<{ chainId: string; genesisHash: string }> = []
  quantusTransferOverrides: Record<string, unknown> | null = null

  registerQuantusNetwork(chainId: string, genesisHash: string): void {
    this.quantusNetworkRegistrations.push({ chainId, genesisHash })
  }

  prepareQuantusTransfer(_sessionId: number, request: unknown): unknown {
    this.quantusTransferRequests.push(request)
    const transfer = request as {
      chainId: string
      scheme: 'ml-dsa-87' | 'ml-dsa-65'
      accountIndex: number
      recipient: string
      amount: string
      keepAlive: boolean
      nonce: number
      tip: string
      period: number
      blockNumber: number
      allowImmortal: boolean
    }
    const network = transfer.chainId === 'quantus:mainnet' ? 'mainnet' : 'dev'
    const call = QUANTUS_CALL
    return {
      requestId: this.nextRequestId++,
      account: quantusAccount(transfer.scheme, transfer.accountIndex, false, 0, network),
      call,
      transfer: {
        recipient: `0x${bytesToHex(decodeQuantusAccountId(transfer.recipient))}`,
        amount: transfer.amount,
        keepAlive: transfer.keepAlive,
        ...(this.quantusTransferOverrides ?? {})
      },
      summary: {
        chainId: transfer.chainId,
        network,
        genesisHash: transfer.genesisHash,
        address: QUANTUS_ADDRESS,
        accountId: `0x${'cd'.repeat(32)}`,
        scheme: transfer.scheme,
        nonce: transfer.nonce,
        tip: transfer.tip,
        period: transfer.period,
        blockNumber: transfer.blockNumber,
        callHash: QUANTUS_CALL_HASH,
        callLength: QUANTUS_CALL_BYTES.byteLength,
        allowImmortal: transfer.allowImmortal,
        ...(this.quantusSummaryOverrides ?? {})
      }
    }
  }

  confirmQuantusCall(_sessionId: number, requestId: number): unknown {
    this.quantusConfirmRequests.push(requestId)
    return {
      extrinsic: '0x8400',
      extrinsicHash: `0x${'55'.repeat(32)}`,
      callHash: `0x${'44'.repeat(32)}`,
      address: QUANTUS_ADDRESS,
      accountId: `0x${'cd'.repeat(32)}`,
      scheme: 'ml-dsa-87',
      nonce: 7,
      ...(this.quantusSignedOverrides ?? {})
    }
  }

  deriveBitcoinAccount(): never {
    throw new Error('Unexpected Bitcoin derivation')
  }

  deriveBitcoinAccounts(): never {
    throw new Error('Unexpected Bitcoin batch derivation')
  }

  prepareEvmPersonalMessage(
    _sessionId: number,
    chainId: string,
    _addressIndex: number,
    message: Uint8Array
  ): unknown {
    return {
      requestId: this.nextRequestId++,
      account: EVM_ACCOUNT,
      summary: {
        chainId,
        from: EVM_ACCOUNT.address,
        byteLength: message.byteLength,
        utf8Preview: new TextDecoder().decode(message),
        previewTruncated: false
      }
    }
  }

  preparePeaEvmPersonalMessage(
    _sessionId: number,
    requestJson: string,
    message: Uint8Array
  ): unknown {
    this.peaRequests.push(requestJson)
    return {
      requestId: this.nextRequestId++,
      account: GLOBAL_PEA,
      summary: {
        from: GLOBAL_PEA.address,
        byteLength: message.byteLength,
        utf8Preview: new TextDecoder().decode(message),
        previewTruncated: false
      }
    }
  }

  prepareEvmTransaction(): never {
    throw new Error('Unexpected EVM transaction')
  }

  preparePeaEvmTransaction(): never {
    throw new Error('Unexpected PEA EVM transaction')
  }

  confirmEvmTransaction(): never {
    throw new Error('Unexpected EVM transaction confirmation')
  }

  confirmEvmPersonalMessage(): unknown {
    return {
      signature: `0x${'11'.repeat(65)}`,
      signingHash: `0x${'22'.repeat(32)}`
    }
  }

  prepareEvmTypedData(): never {
    throw new Error('Unexpected EVM typed data')
  }

  preparePeaEvmTypedData(): never {
    throw new Error('Unexpected PEA EVM typed data')
  }

  confirmEvmTypedData(): never {
    throw new Error('Unexpected EVM typed data confirmation')
  }

  prepareBitcoinPsbt(): never {
    throw new Error('Unexpected Bitcoin PSBT')
  }

  confirmBitcoinPsbt(): never {
    throw new Error('Unexpected Bitcoin PSBT confirmation')
  }

  prepareBitcoinMessage(): never {
    throw new Error('Unexpected Bitcoin message')
  }

  confirmBitcoinMessage(): never {
    throw new Error('Unexpected Bitcoin message confirmation')
  }

  verifyBitcoinMessage(): boolean {
    return false
  }

  rejectSigningRequest(_sessionId: number, requestId: number): boolean {
    this.rejectedRequests.push(requestId)
    return true
  }

  free(): void {
    this.freeCalls += 1
  }
}

let sequence = 0

function command(
  operation: string,
  payload: Record<string, unknown>,
  binding: Record<string, unknown> = BINDING
) {
  sequence += 1
  return {
    protocolVersion: 2,
    commandId: `keyring-command:runtime:${sequence}`,
    engine: 'multichain',
    operation,
    binding,
    deadlineAt: Date.now() + 60_000,
    payload
  }
}

function quantusPayload(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'quantus-transfer',
    chainId: 'quantus:mainnet',
    scheme: 'ml-dsa-87',
    accountIndex: 0,
    toAddress: QUANTUS_RECIPIENT,
    amountRaw: '1000000000000',
    feeLimitRaw: '10000000000',
    keepAlive: true,
    nonce: 7,
    tip: '0',
    period: 64,
    blockNumber: 128,
    genesisHash: `0x${'11'.repeat(32)}`,
    blockHash: `0x${'22'.repeat(32)}`,
    specVersion: 153,
    transactionVersion: 1,
    allowImmortal: false,
    ...overrides
  }
}

function expectSuccess(result: Awaited<ReturnType<MultichainWorkerRuntime['execute']>>) {
  expect(result).toMatchObject({ ok: true })
  if (!result.ok) throw new Error('Expected a successful keyring result')
  return result.value
}

function expectFailure(
  result: Awaited<ReturnType<MultichainWorkerRuntime['execute']>>,
  code: string
) {
  expect(result).toMatchObject({ ok: false, error: { code } })
}

function createRuntime(engine: FakeWalletEngine, options = {}) {
  return new MultichainWorkerRuntime(
    engine,
    {
      abiVersion: 'test-abi',
      sourceCommit: 'test-commit',
      capabilities: []
    },
    options
  )
}

function expectedVaultPassword(password: string): string {
  return createHash('sha256')
    .update('NoirWallet/multichain-vault-password/v1\0', 'utf8')
    .update(password, 'utf8')
    .digest('hex')
}

test.describe('Multichain Worker runtime boundaries', () => {
  test('accepts only the WASM hex vault representation', () => {
    expect(parseRawEncryptedVault(VAULT)).toEqual(VAULT)
    const currentVault = {
      ...VAULT,
      version: 2,
      kdfParams: { memoryKib: 64 * 1024, iterations: 3, parallelism: 1 }
    }
    expect(parseRawEncryptedVault(currentVault)).toEqual(currentVault)
    expect(() => parseRawEncryptedVault({ ...currentVault, version: 1 })).toThrow()
    expect(() => parseRawEncryptedVault({ ...VAULT, salt: 'EREREREREREREREREREREQ==' })).toThrow()
    expect(() => parseRawEncryptedVault({ ...VAULT, nonce: 'AA'.repeat(24) })).toThrow()
    expect(() =>
      parseRawEncryptedVault({
        ...VAULT,
        kdfParams: { ...VAULT.kdfParams, iterations: 3 }
      })
    ).toThrow()
    expect(() =>
      parseRawEncryptedVault({
        ...VAULT,
        kdfParams: { memoryKib: 64 * 1024, iterations: 2, parallelism: 1 }
      })
    ).toThrow()
    expect(() =>
      parseRawEncryptedVault({
        ...VAULT,
        kdfParams: { memoryKib: 64 * 1024, iterations: 3, parallelism: 2 }
      })
    ).toThrow()
  })

  test('round-trips binary payloads through the Chrome JSON message codec', () => {
    const input = {
      operation: 'signing.prepare',
      payload: { message: new Uint8Array([0, 1, 2, 254, 255]) }
    }
    const encoded = encodeChromeRuntimeCommand(input)
    expect(encoded).toEqual({
      operation: 'signing.prepare',
      payload: { message: { $noirWalletBytes: 'AAEC/v8=' } }
    })
    expect(decodeChromeRuntimeCommand(encoded)).toEqual(input)
    expect(() => decodeChromeRuntimeCommand({ $noirWalletBytes: 'not-base64' })).toThrow()
    expect(() => decodeChromeRuntimeCommand({ $noirWalletBytes: '', extra: true })).toThrow()
  })

  test('accepts NEP-413 Base64 signatures without confusing them with NEAR public keys', () => {
    const signature = Buffer.alloc(64, 7).toString('base64')
    expect(
      parseRawSignedNearMessage({
        accountId: NEAR_ACCOUNT.address,
        publicKey: NEAR_ACCOUNT.publicKey,
        signature,
        state: null,
        signingHash: `0x${'22'.repeat(32)}`
      })
    ).toMatchObject({ signature, publicKey: NEAR_ACCOUNT.publicKey })
    expect(() =>
      parseRawSignedNearMessage({
        accountId: NEAR_ACCOUNT.address,
        publicKey: NEAR_ACCOUNT.publicKey,
        signature: `ed25519:${NEAR_ACCOUNT.address}`,
        state: null,
        signingHash: `0x${'22'.repeat(32)}`
      })
    ).toThrow(/base64/i)
  })

  test('always passes an empty BIP-39 passphrase and keeps raw session IDs private', async () => {
    const engine = new FakeWalletEngine()
    const runtime = createRuntime(engine)

    const created = expectSuccess(
      await runtime.execute(command('credential.create', { wordCount: 12, password: 'password' }))
    )
    expect(created).toEqual({ mnemonic: MNEMONIC, vault: VAULT })
    const vault = expectSuccess(
      await runtime.execute(
        command('credential.import', { mnemonic: MNEMONIC, password: 'password' })
      )
    )
    expect(engine.createPassphrases).toEqual([''])
    expect(engine.importPassphrases).toEqual([''])
    expect(engine.createPasswords).toEqual([expectedVaultPassword('password')])
    expect(engine.importPasswords).toEqual([expectedVaultPassword('password')])

    const unlocked = expectSuccess(
      await runtime.execute(command('credential.unlock', { vault, password: 'password' }))
    )
    expect(engine.unlockPasswords).toEqual([expectedVaultPassword('password')])
    expect(unlocked).toEqual({ state: 'unlocked' })
    expect(JSON.stringify(unlocked)).not.toContain('sessionId')

    const account = expectSuccess(
      await runtime.execute(
        command('account.derive-public', {
          family: 'evm',
          chainId: 'eip155:1',
          addressIndex: 0
        })
      )
    )
    expect(account).toMatchObject({ identity: { value: EVM_ACCOUNT.address } })

    expectFailure(
      await runtime.execute(
        command(
          'account.derive-public',
          { family: 'evm', chainId: 'eip155:1', addressIndex: 0 },
          { ...BINDING, credentialGenerationId: 'credential-generation:stale' }
        )
      ),
      'CREDENTIAL_LOCKED'
    )
  })

  test('derives and signs with the Global PEA without accepting a dApp scope', async () => {
    const engine = new FakeWalletEngine()
    const runtime = createRuntime(engine, {
      createSigningCommandId: () => 'signing-command:pea'
    })
    expectSuccess(
      await runtime.execute(command('credential.unlock', { vault: VAULT, password: 'password' }))
    )

    const pea = expectSuccess(
      await runtime.execute(command('account.derive-public', { family: 'pea', addressIndex: 0 }))
    )
    expect(pea).toEqual(GLOBAL_PEA)

    const prepared = expectSuccess(
      await runtime.execute(
        command('signing.prepare', {
          kind: 'pea-evm-personal-message',
          chainId: 'eip155:1',
          addressIndex: 0,
          message: new TextEncoder().encode('PEA proof')
        })
      )
    ) as { commandId: string }
    const signed = expectSuccess(
      await runtime.execute(command('signing.confirm', { signingCommandId: prepared.commandId }))
    )
    expect(signed).toMatchObject({ kind: 'signature', address: GLOBAL_PEA.address })
    expect(engine.peaRequests).toEqual([
      '{"version":1,"parent":{"addressIndex":0}}',
      '{"version":1,"parent":{"addressIndex":0}}'
    ])
  })

  test('binds exact legacy passwords before the WASM 1024-byte boundary', async () => {
    const engine = new FakeWalletEngine()
    const runtime = createRuntime(engine)
    const legacyPassword = `  ${'\u65e7🔐'.repeat(300)}  `
    expect(new TextEncoder().encode(legacyPassword).byteLength).toBeGreaterThan(1_024)

    expectSuccess(
      await runtime.execute(
        command('credential.import', { mnemonic: MNEMONIC, password: legacyPassword })
      )
    )
    expectSuccess(
      await runtime.execute(
        command('credential.unlock', { vault: VAULT, password: legacyPassword })
      )
    )

    const expected = expectedVaultPassword(legacyPassword)
    expect(engine.importPasswords).toEqual([expected])
    expect(engine.unlockPasswords).toEqual([expected])
    expect(expected).toHaveLength(64)
    expect(expected).not.toBe(expectedVaultPassword(legacyPassword.trim()))
  })

  test('imports, exports and rewraps an EVM private-key vault without returning the key from rewrap', async () => {
    const engine = new FakeWalletEngine()
    engine.evmAccount = IMPORTED_EVM_ACCOUNT
    const runtime = createRuntime(engine)

    const vault = expectSuccess(
      await runtime.execute(
        command('credential.import-private-key', {
          privateKey: `0x${'01'.repeat(32)}`,
          password: 'password',
          chainFamily: 'eip155'
        })
      )
    )
    expect(vault).toEqual(PRIVATE_KEY_VAULT)
    expectSuccess(
      await runtime.execute(command('credential.unlock', { vault, password: 'password' }))
    )
    const account = expectSuccess(
      await runtime.execute(
        command('account.derive-public', {
          family: 'evm',
          chainId: 'eip155:1',
          addressIndex: 0
        })
      )
    )
    expect(account).toMatchObject({ derivation: { scheme: 'imported', path: 'm' } })

    const exported = expectSuccess(
      await runtime.execute(
        command('credential.export-private-key', {
          vault,
          password: 'password',
          chainId: 'eip155:1',
          addressIndex: 0
        })
      )
    )
    expect(exported).toMatchObject({ format: 'hex', privateKey: `0x${'01'.repeat(32)}` })

    const rewrapped = expectSuccess(
      await runtime.execute(
        command('credential.rewrap-private-key', {
          vault,
          currentPassword: 'password',
          newPassword: 'new-password',
          chainFamily: 'eip155'
        })
      )
    )
    expect(rewrapped).toEqual(PRIVATE_KEY_VAULT)
    expect(JSON.stringify(rewrapped)).not.toContain(`0x${'01'.repeat(32)}`)
  })

  test('derives Solana and NEAR accounts through the same isolated credential session', async () => {
    const runtime = createRuntime(new FakeWalletEngine())
    expectSuccess(
      await runtime.execute(command('credential.unlock', { vault: VAULT, password: 'password' }))
    )

    const solana = expectSuccess(
      await runtime.execute(
        command('account.derive-public', {
          family: 'solana',
          chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
          accountIndex: 0
        })
      )
    )
    expect(solana).toMatchObject({
      identity: { value: SOLANA_ACCOUNT.address },
      derivation: { scheme: 'slip10', path: "m/44'/501'/0'/0'" }
    })

    const near = expectSuccess(
      await runtime.execute(
        command('account.derive-public', {
          family: 'near',
          chainId: 'near:testnet',
          accountIndex: 0
        })
      )
    )
    expect(near).toMatchObject({
      identity: { value: NEAR_ACCOUNT.address },
      derivation: { scheme: 'slip10', path: "m/44'/397'/0'" }
    })
  })

  test('reports stable input errors instead of internal failures', async () => {
    const runtime = createRuntime(new FakeWalletEngine())

    expectFailure(
      await runtime.execute(command('credential.create', { wordCount: 18, password: 'password' })),
      'INVALID_COMMAND'
    )
    expectFailure(
      await runtime.execute(command('credential.import', { mnemonic: 'not valid', password: 'x' })),
      'INVALID_CREDENTIAL'
    )
    expectFailure(
      await runtime.execute(command('capabilities.get', { unexpected: true }, { kind: 'unbound' })),
      'INVALID_COMMAND'
    )
    expectSuccess(
      await runtime.execute(command('credential.unlock', { vault: VAULT, password: 'password' }))
    )
    expectFailure(
      await runtime.execute(
        command('account.derive-public', {
          family: 'evm',
          chainId: 'eip155:1',
          addressIndex: 0x80000000
        })
      ),
      'INVALID_COMMAND'
    )
  })

  test('rejects a raw account response that does not match the requested derivation', async () => {
    const engine = new FakeWalletEngine()
    const runtime = createRuntime(engine)
    expectSuccess(
      await runtime.execute(command('credential.unlock', { vault: VAULT, password: 'password' }))
    )
    engine.evmAccount = { ...EVM_ACCOUNT, derivationPath: "m/44'/60'/0'/0/1" }

    expectFailure(
      await runtime.execute(
        command('account.derive-public', {
          family: 'evm',
          chainId: 'eip155:1',
          addressIndex: 0
        })
      ),
      'INVALID_RESPONSE'
    )
  })

  test('enforces pending signing capacity and reports the requested command as expired', async () => {
    let now = 1_000
    let signingSequence = 0
    const engine = new FakeWalletEngine()
    const runtime = createRuntime(engine, {
      now: () => now,
      maxPendingSigning: 1,
      signingTtlMs: 10,
      createSigningCommandId: () => `signing-command:test:${++signingSequence}`
    })
    expectSuccess(
      await runtime.execute(command('credential.unlock', { vault: VAULT, password: 'password' }))
    )
    const prepared = expectSuccess(
      await runtime.execute(
        command('signing.prepare', {
          kind: 'evm-personal-message',
          chainId: 'eip155:1',
          addressIndex: 0,
          message: new TextEncoder().encode('Noir Wallet')
        })
      )
    )
    if (
      typeof prepared !== 'object' ||
      prepared === null ||
      !('commandId' in prepared) ||
      typeof prepared.commandId !== 'string'
    ) {
      throw new Error('Prepared signing command is invalid')
    }

    expectFailure(
      await runtime.execute(
        command('signing.prepare', {
          kind: 'evm-personal-message',
          chainId: 'eip155:1',
          addressIndex: 0,
          message: new Uint8Array([1])
        })
      ),
      'CAPACITY_EXCEEDED'
    )

    now += 11
    expectFailure(
      await runtime.execute(command('signing.confirm', { signingCommandId: prepared.commandId })),
      'SIGNING_COMMAND_EXPIRED'
    )
    expect(engine.rejectedRequests).toEqual([1])
  })

  test('routes Quantus derivation through identifiers the packaged engine accepts', async () => {
    const engine = new FakeWalletEngine()
    const runtime = createRuntime(engine)
    const vault = expectSuccess(
      await runtime.execute(
        command('credential.import', { mnemonic: MNEMONIC, password: 'password' })
      )
    )
    expectSuccess(
      await runtime.execute(command('credential.unlock', { vault, password: 'password' }))
    )

    const mainnet = expectSuccess(
      await runtime.execute(
        command('account.derive-public', {
          family: 'quantus',
          chainId: 'quantus:mainnet',
          scheme: 'ml-dsa-87',
          accountIndex: 0,
          change: false,
          addressIndex: 0
        })
      )
    )
    expect(mainnet).toMatchObject({
      chainId: 'quantus:mainnet',
      derivation: { scheme: 'bip44', path: "m/44'/189189'/0'/0'/0'" },
      identity: { kind: 'account-identifier', value: QUANTUS_ADDRESS },
      addresses: [{ scheme: 'quantus', purpose: 'receive' }]
    })

    // The CAIP-2 testnet reference is mapped to the only live testnet identifier
    // the WASM accepts; the response keeps the host chain ID.
    const planck = expectSuccess(
      await runtime.execute(
        command('account.derive-public', {
          family: 'quantus',
          chainId: 'quantus:planck',
          scheme: 'ml-dsa-87',
          accountIndex: 0,
          change: false,
          addressIndex: 0
        })
      )
    )
    expect(planck).toMatchObject({ chainId: 'quantus:planck' })
    expect(engine.quantusChainIds).toEqual(['quantus:mainnet', 'quantus:dev'])

    const batch = expectSuccess(
      await runtime.execute(
        command('account.derive-public', {
          family: 'quantus',
          chainId: 'quantus:mainnet',
          scheme: 'ml-dsa-65',
          accountIndex: 2,
          change: false,
          startAddressIndex: 1,
          count: 2
        })
      )
    )
    expect(batch).toHaveLength(2)

    expectFailure(
      await runtime.execute(
        command('account.derive-public', {
          family: 'quantus',
          chainId: 'quantus:dev',
          scheme: 'ml-dsa-87',
          accountIndex: 0,
          change: false,
          addressIndex: 0
        })
      ),
      'UNSUPPORTED_CHAIN'
    )
    expectFailure(
      await runtime.execute(
        command('account.derive-public', {
          family: 'quantus',
          chainId: 'quantus:mainnet',
          scheme: 'sr25519',
          accountIndex: 0,
          change: false,
          addressIndex: 0
        })
      ),
      'INVALID_COMMAND'
    )

    engine.quantusAccountFor = () => ({
      ...quantusAccount('ml-dsa-87', 0, false, 1, 'mainnet')
    })
    expectFailure(
      await runtime.execute(
        command('account.derive-public', {
          family: 'quantus',
          chainId: 'quantus:mainnet',
          scheme: 'ml-dsa-87',
          accountIndex: 0,
          change: false,
          addressIndex: 0
        })
      ),
      'INVALID_RESPONSE'
    )
  })

  test('routes Quantus native transfers through prepare and confirmQuantusCall', async () => {
    const engine = new FakeWalletEngine()
    const runtime = createRuntime(engine, {
      createSigningCommandId: () => 'signing-command:quantus'
    })
    const vault = expectSuccess(
      await runtime.execute(
        command('credential.import', { mnemonic: MNEMONIC, password: 'password' })
      )
    )
    expectSuccess(
      await runtime.execute(command('credential.unlock', { vault, password: 'password' }))
    )

    const prepared = expectSuccess(
      await runtime.execute(command('signing.prepare', quantusPayload()))
    ) as { commandId: string; summary: { schema: string; fields: Record<string, unknown> } }

    expect(engine.quantusTransferRequests).toHaveLength(1)
    // Mainnet pins its genesis hash in the engine, so nothing is registered.
    expect(engine.quantusNetworkRegistrations).toEqual([])
    expect(engine.quantusTransferRequests[0]).toMatchObject({
      chainId: 'quantus:mainnet',
      recipient: QUANTUS_RECIPIENT,
      amount: '1000000000000'
    })
    expect(prepared.summary).toMatchObject({
      schema: 'quantus.transfer.v1',
      fields: { signerAddress: QUANTUS_ADDRESS, recipient: QUANTUS_RECIPIENT, nonce: '7' }
    })

    const signed = expectSuccess(
      await runtime.execute(command('signing.confirm', { signingCommandId: prepared.commandId }))
    )
    expect(signed).toMatchObject({
      kind: 'signed-payload',
      payload: { encoding: 'hex', value: '0x8400' },
      transactionId: `0x${'55'.repeat(32)}`
    })
  })

  test('keeps the host Planck chain ID across Quantus prepare and confirm', async () => {
    const engine = new FakeWalletEngine()
    const runtime = createRuntime(engine, {
      createSigningCommandId: () => 'signing-command:quantus-planck'
    })
    expectSuccess(
      await runtime.execute(command('credential.unlock', { vault: VAULT, password: 'password' }))
    )

    const prepared = expectSuccess(
      await runtime.execute(
        command('signing.prepare', quantusPayload({ chainId: 'quantus:planck' }))
      )
    ) as { commandId: string; summary: { chainId: string } }

    // Only the engine boundary sees the WASM identifier.
    expect(engine.quantusTransferRequests[0]).toMatchObject({ chainId: 'quantus:dev' })
    // The engine refuses to sign through a non-mainnet reference until the host
    // binds it to the configured genesis hash.
    expect(engine.quantusNetworkRegistrations).toEqual([
      { chainId: 'quantus:dev', genesisHash: `0x${'11'.repeat(32)}` }
    ])
    expect(prepared.summary.chainId).toBe('quantus:planck')

    expectSuccess(
      await runtime.execute(command('signing.confirm', { signingCommandId: prepared.commandId }))
    )
    expect(engine.quantusConfirmRequests).toEqual([1])
  })

  test('rejects unsolicited Quantus signing coordinates the engine would ignore', async () => {
    const engine = new FakeWalletEngine()
    const runtime = createRuntime(engine)
    expectSuccess(
      await runtime.execute(command('credential.unlock', { vault: VAULT, password: 'password' }))
    )

    expectFailure(
      await runtime.execute(command('signing.prepare', quantusPayload({ addressIndex: 0 }))),
      'UNSUPPORTED_PAYLOAD'
    )
    expectFailure(
      await runtime.execute(command('signing.prepare', quantusPayload({ change: false }))),
      'UNSUPPORTED_PAYLOAD'
    )
    expect(engine.quantusTransferRequests).toEqual([])
  })

  test('rejects a Quantus prepared or signed result that does not match the reviewed request', async () => {
    const engine = new FakeWalletEngine()
    const runtime = createRuntime(engine, {
      createSigningCommandId: () => 'signing-command:quantus-mismatch'
    })
    expectSuccess(
      await runtime.execute(command('credential.unlock', { vault: VAULT, password: 'password' }))
    )

    engine.quantusSummaryOverrides = { nonce: 8 }
    expectFailure(
      await runtime.execute(command('signing.prepare', quantusPayload())),
      'INVALID_RESPONSE'
    )
    // A rejected prepare cancels the WASM request instead of leaving it pending.
    expect(engine.rejectedRequests).toEqual([1])

    engine.quantusSummaryOverrides = null
    engine.quantusSignedOverrides = { address: QUANTUS_RECIPIENT }
    const prepared = expectSuccess(
      await runtime.execute(command('signing.prepare', quantusPayload()))
    ) as { commandId: string }
    expectFailure(
      await runtime.execute(command('signing.confirm', { signingCommandId: prepared.commandId })),
      'INVALID_RESPONSE'
    )
  })
})
