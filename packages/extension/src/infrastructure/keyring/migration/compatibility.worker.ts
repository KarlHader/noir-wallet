import { validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import { BITCOIN_ADDRESS_POLICY } from '@/core/chains/bitcoin'
import initZcash, {
  mnemonic_to_addresses,
  parse_unified_address
} from '../../../lib/wasm-pkg/zcash_wallet_wasm.js'
import { loadPinnedZcashWasmBinary } from '../../../core/zcash/pinned-wasm'
import { bindMultichainVaultPassword } from '../multichain/password-binding'
import { createPinnedMultichainEngine } from '../multichain/pinned-wasm-engine'
import {
  assertRawBitcoinAccountMatches,
  assertRawEvmAccountMatches,
  parseRawBitcoinAccount,
  parseRawEncryptedVault,
  parseRawEvmAccount,
  parseRawSessionInfo,
  readRecord,
  readString
} from '../multichain/raw-wallet-engine'
import {
  type CompatibilityAccountAnchors,
  parseCompatibilityWorkerRequest,
  type CompatibilityVerificationAnchor,
  type CompatibilityWorkerErrorCode,
  type CompatibilityWorkerRequest,
  type CompatibilityWorkerResponse,
  type CompatibilityWorkerResult
} from './compatibility-worker-protocol'
import {
  parseV1EncryptedCredentialEnvelope,
  type V1EncryptedCredentialEnvelope
} from './v1-credential-envelope'

interface DedicatedWorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
  postMessage(message: CompatibilityWorkerResponse): void
  close(): void
}

class CompatibilityMigrationError extends Error {
  constructor(readonly code: CompatibilityWorkerErrorCode) {
    super(code)
  }
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function bytesToBase64(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

async function encryptMnemonic(
  mnemonic: string,
  password: string
): Promise<V1EncryptedCredentialEnvelope> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(JSON.stringify({ seedPhrase: mnemonic }))
  try {
    const passwordKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    )
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
      passwordKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt']
    )
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
    return parseV1EncryptedCredentialEnvelope({
      encryptedData: bytesToBase64(encrypted),
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv)
    })
  } catch {
    throw new CompatibilityMigrationError('MIGRATION_FAILED')
  } finally {
    plaintext.fill(0)
  }
}

async function decryptMnemonic(request: CompatibilityWorkerRequest): Promise<string> {
  const salt = base64ToBytes(request.envelope.salt)
  const iv = base64ToBytes(request.envelope.iv)
  const encryptedData = base64ToBytes(request.envelope.encryptedData)
  let decrypted: ArrayBuffer
  try {
    const passwordKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(request.password),
      'PBKDF2',
      false,
      ['deriveKey']
    )
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: salt as BufferSource, iterations: 100_000, hash: 'SHA-256' },
      passwordKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    )
    decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      encryptedData as BufferSource
    )
  } catch {
    throw new CompatibilityMigrationError('DECRYPTION_FAILED')
  } finally {
    salt.fill(0)
    iv.fill(0)
    encryptedData.fill(0)
  }

  const bytes = new Uint8Array(decrypted)
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      !Object.prototype.hasOwnProperty.call(value, 'seedPhrase') ||
      typeof (value as { seedPhrase?: unknown }).seedPhrase !== 'string'
    ) {
      throw new Error('Invalid decrypted credential')
    }
    const mnemonic = (value as { seedPhrase: string }).seedPhrase
    const words = mnemonic.split(' ')
    if (
      (words.length !== 12 && words.length !== 24) ||
      words.some(word => word.length === 0) ||
      !validateMnemonic(mnemonic, wordlist)
    ) {
      throw new Error('Invalid mnemonic')
    }
    return mnemonic
  } catch {
    throw new CompatibilityMigrationError('INVALID_MNEMONIC')
  } finally {
    bytes.fill(0)
  }
}

function anchor(
  account: {
    readonly address: string
    readonly derivationPath: string
    readonly publicKey: string
  },
  chainId: string
): CompatibilityVerificationAnchor {
  return Object.freeze({
    chainId,
    derivationPath: account.derivationPath,
    identity: account.address,
    publicKey: account.publicKey
  })
}

function parseZcashAddresses(value: unknown): {
  readonly unified: string
  readonly fullUnified: string
  readonly transparent: string
} {
  const record = readRecord(value, 'Zcash derived addresses')
  return Object.freeze({
    unified: readString(record.unified, 'Zcash unified address', 4_096),
    fullUnified: readString(record.full_unified, 'Zcash full unified address', 4_096),
    transparent: readString(record.transparent, 'Zcash transparent address', 256)
  })
}

function assertZcashAccountMatches(
  derived: ReturnType<typeof parseZcashAddresses>,
  request: CompatibilityWorkerRequest['accounts'][number],
  network: CompatibilityWorkerRequest['zcashNetwork']
): void {
  if (derived.transparent !== request.expectedZcash.transparent) {
    throw new CompatibilityMigrationError('MIGRATION_FAILED')
  }

  const assertReceiveAddress = (value: string): void => {
    try {
      const parsed = readRecord(
        parse_unified_address(network === 'mainnet' ? 'main' : 'test', value),
        'V1 Zcash receive address'
      )
      if (
        parsed.transparent !== undefined &&
        parsed.transparent !== null &&
        readString(parsed.transparent, 'V1 Zcash transparent receiver', 256) !== derived.transparent
      ) {
        throw new Error('V1 Zcash transparent receiver mismatch')
      }
    } catch {
      throw new CompatibilityMigrationError('MIGRATION_FAILED')
    }
  }

  // V1 persists the current shielded receive address, which can advance after
  // the user rotates it. The transparent receiver remains the stable account
  // anchor; receive addresses are validated for network and preserved below.
  assertReceiveAddress(request.expectedZcash.shielded)
  if (request.expectedZcash.fullUnified !== undefined) {
    assertReceiveAddress(request.expectedZcash.fullUnified)
  }
}

function zcashAnchor(
  derived: ReturnType<typeof parseZcashAddresses>,
  request: CompatibilityWorkerRequest,
  accountIndex: number
): CompatibilityVerificationAnchor {
  const coinType = request.zcashNetwork === 'mainnet' ? 133 : 1
  return Object.freeze({
    chainId: request.zcashChainId,
    derivationPath: `m/32'/${coinType}'/${accountIndex}'`,
    identity: derived.fullUnified
  })
}

async function migrate(request: CompatibilityWorkerRequest): Promise<CompatibilityWorkerResult> {
  const mnemonic = await decryptMnemonic(request)
  let engine
  try {
    engine = await createPinnedMultichainEngine()
    const zcashWasmUrl = (await import('../../../lib/wasm-pkg/zcash_wallet_wasm_bg.wasm?url'))
      .default
    const zcashWasmBytes = await loadPinnedZcashWasmBinary(zcashWasmUrl)
    await initZcash({ module_or_path: zcashWasmBytes })
  } catch {
    throw new CompatibilityMigrationError('WASM_INTEGRITY_FAILURE')
  }
  try {
    const targetPassword = request.targetPassword ?? request.password
    const password = await bindMultichainVaultPassword(targetPassword)
    const vault =
      request.targetVault ?? parseRawEncryptedVault(engine.importWallet(mnemonic, password, ''))
    const sessionId = parseRawSessionInfo(engine.unlock(vault, password)).sessionId
    const accounts = request.accounts.map(accountRequest => {
      const accountIndex = accountRequest.accountIndex
      const zcash = parseZcashAddresses(
        mnemonic_to_addresses(
          request.zcashNetwork === 'mainnet' ? 'main' : 'test',
          mnemonic,
          '',
          accountIndex
        )
      )
      assertZcashAccountMatches(zcash, accountRequest, request.zcashNetwork)
      const evm = parseRawEvmAccount(
        engine.deriveEvmAccount(sessionId, request.evmChainId, accountIndex)
      )
      assertRawEvmAccountMatches(evm, request.evmChainId, accountIndex)
      const bitcoin = parseRawBitcoinAccount(
        engine.deriveBitcoinAccount(
          sessionId,
          request.bitcoinChainId,
          BITCOIN_ADDRESS_POLICY.defaultCreate.addressType,
          accountIndex,
          false,
          0
        )
      )
      assertRawBitcoinAccountMatches(
        bitcoin,
        request.bitcoinChainId,
        BITCOIN_ADDRESS_POLICY.defaultCreate.addressType,
        accountIndex,
        false,
        0
      )
      return Object.freeze({
        accountIndex,
        zcash: zcashAnchor(zcash, request, accountIndex),
        evm: anchor(evm, request.evmChainId),
        bitcoin: anchor(bitcoin, request.bitcoinChainId)
      }) satisfies CompatibilityAccountAnchors
    })
    const commonResult = {
      vault,
      mnemonicWordCount: mnemonic.split(' ').length as 12 | 24,
      accounts: Object.freeze(accounts)
    } as const
    return request.operation === 'migrate'
      ? Object.freeze({ ...commonResult, operation: 'migrate' as const })
      : Object.freeze({
          ...commonResult,
          operation: 'change-password' as const,
          retainedV1Envelope:
            request.targetVault === undefined
              ? await encryptMnemonic(mnemonic, request.targetPassword as string)
              : request.envelope
        })
  } catch (error) {
    if (error instanceof CompatibilityMigrationError) throw error
    throw new CompatibilityMigrationError('MIGRATION_FAILED')
  } finally {
    engine.lockAll()
    engine.free()
  }
}

const scope = globalThis as unknown as DedicatedWorkerScope
let handled = false
scope.addEventListener('message', event => {
  if (handled) return
  handled = true
  let request: CompatibilityWorkerRequest
  try {
    request = parseCompatibilityWorkerRequest(event.data)
  } catch {
    scope.postMessage({ id: 'invalid', error: 'INVALID_REQUEST' })
    scope.close()
    return
  }
  void migrate(request)
    .then(result => scope.postMessage({ id: request.id, result }))
    .catch(error =>
      scope.postMessage({
        id: request.id,
        error: error instanceof CompatibilityMigrationError ? error.code : 'MIGRATION_FAILED'
      })
    )
    .finally(() => scope.close())
})
