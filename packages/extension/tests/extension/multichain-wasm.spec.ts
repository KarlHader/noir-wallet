import type { Page } from '@playwright/test'
import { address, networks, Transaction } from 'bitcoinjs-lib'
import {
  createAssetRegistry,
  createEvmBitcoinChainRegistry,
  getBundledEvmAssetDefinitions,
  parseChainId
} from '../../src/core/chains/registry'
import {
  assertSignedEvmTransactionMatchesPrepared,
  assertEvmTransferFresh,
  buildEvmTransfer,
  createEvmSigningPreparePayload
} from '../../src/infrastructure/chains/evm'
import {
  assertBitcoinSigningSummaryMatchesPrepared,
  buildBitcoinPsbt,
  finalizeBitcoinPsbt,
  selectBitcoinCoins
} from '../../src/infrastructure/chains/bitcoin'
import { buildSolanaNativeTransfer } from '../../src/infrastructure/chains/solana/solana-transaction-builder'
import { test, expect, waitForBackgroundWalletInitialization } from '../helpers/extension-fixtures'

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const PASSWORD = 'multichain-e2e-password'
const BITCOIN_MAINNET = 'bip122:000000000019d6689c085ae165831e93'
const BITCOIN_TESTNET = 'bip122:000000000933ea01ad0ee984209779ba'
const BIP84_PSBT =
  'cHNidP8BAHECAAAAAfk1QvcUM0HGNY9fxRgcgFU8JIoYvg22wORHl2qk+vpMAAAAAAD9////AmDqAAAAAAAAFgAUuZAt225g/uZ9M6gzT3zKA1KDhuRYmAAAAAAAABYAFD40mF3Kb93J+zaZQOTH2OKHP1KcAAAAAAABAFICAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/////wD/////AaCGAQAAAAAAFgAUwM681sPTyox13F7GLr5VMw75EOIAAAAAAQEfoIYBAAAAAAAWABTAzrzWw9PKjHXcXsYuvlUzDvkQ4iIGAzDVT9DdQgpuX402JPXzSCyuNQ951fB1O/W+75wtka88GHPF2gpUAACAAAAAgAAAAIAAAAAAAAAAAAAAIgIDAlMkiI5Cmrjj268feAJki5zQHptBhIXF+kwbm1cA4aYYc8XaClQAAIAAAACAAAAAgAEAAAAAAAAAAA=='
const CREDENTIAL_BINDING = Object.freeze({
  kind: 'credential',
  keyDomainId: 'key-domain:multichain-e2e',
  credentialGenerationId: 'credential-generation:multichain-e2e',
  globalUnlockEpoch: 'global-unlock:multichain-e2e'
})

let commandSequence = 0

function decodeSolanaBase58(value: string): Uint8Array {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  const bytes = [0]
  for (const character of value) {
    const digit = alphabet.indexOf(character)
    if (digit < 0) throw new Error('Invalid Solana base58 test vector')
    let carry = digit
    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index] * 58
      bytes[index] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  let leadingZeros = 0
  while (value[leadingZeros] === alphabet[0]) leadingZeros += 1
  const significantBytes = bytes.length === 1 && bytes[0] === 0 ? [] : bytes.reverse()
  const decoded = Uint8Array.from([
    ...Array.from({ length: leadingZeros }, () => 0),
    ...significantBytes
  ])
  if (decoded.byteLength !== 32) throw new Error('Invalid Solana 32-byte test vector')
  return decoded
}

function buildSolanaPriorityFeeTransfer(input: {
  readonly sender: string
  readonly recipient: string
  readonly recentBlockhash: string
  readonly lamports: string
  readonly computeUnitLimit: number
  readonly computeUnitPriceMicroLamports: bigint
}): string {
  const computeProgram = 'ComputeBudget111111111111111111111111111111'
  const systemProgram = '11111111111111111111111111111111'
  const unitLimitData = Buffer.alloc(5)
  unitLimitData[0] = 2
  unitLimitData.writeUInt32LE(input.computeUnitLimit, 1)
  const unitPriceData = Buffer.alloc(9)
  unitPriceData[0] = 3
  unitPriceData.writeBigUInt64LE(input.computeUnitPriceMicroLamports, 1)
  const transferData = Buffer.alloc(12)
  transferData.writeUInt32LE(2, 0)
  transferData.writeBigUInt64LE(BigInt(input.lamports), 4)
  const message = Buffer.concat([
    Buffer.from([1, 0, 2, 4]),
    Buffer.from(decodeSolanaBase58(input.sender)),
    Buffer.from(decodeSolanaBase58(input.recipient)),
    Buffer.from(decodeSolanaBase58(computeProgram)),
    Buffer.from(decodeSolanaBase58(systemProgram)),
    Buffer.from(decodeSolanaBase58(input.recentBlockhash)),
    Buffer.from([3, 2, 0, unitLimitData.length]),
    unitLimitData,
    Buffer.from([2, 0, unitPriceData.length]),
    unitPriceData,
    Buffer.from([3, 2, 0, 1, transferData.length]),
    transferData
  ])
  return Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]).toString('base64')
}

function createRawCommand(
  operation: string,
  payload: Record<string, unknown>,
  binding: Record<string, unknown> = CREDENTIAL_BINDING
) {
  commandSequence += 1
  return {
    protocolVersion: 2,
    commandId: `keyring-command:multichain-e2e:${commandSequence}`,
    engine: 'multichain',
    operation,
    binding,
    deadlineAt: Date.now() + 60_000,
    payload
  }
}

interface TestFailureResult {
  readonly ok: false
  readonly error: { readonly code: string }
}

interface TestSuccessResult<T> {
  readonly ok: true
  readonly value: T
}

type TestResult<T> = TestFailureResult | TestSuccessResult<T>

interface CapabilitiesValue {
  readonly abiVersion: string
  readonly sourceCommit: string
  readonly capabilities: readonly string[]
}

interface VaultValue {
  readonly version: number
  readonly kdf: string
  readonly cipher: string
  readonly kdfParams: Readonly<Record<string, number>>
  readonly salt: string
  readonly nonce: string
  readonly ciphertext: string
}

interface CreatedWalletValue {
  readonly mnemonic: string
  readonly vault: VaultValue
}

interface SessionValue {
  readonly state: 'unlocked'
}

interface ExportedPrivateKeyValue {
  readonly chainId: string
  readonly format: 'hex' | 'wif' | 'base58' | 'near_ed25519'
  readonly privateKey: string
  readonly hex: string
}

interface AccountValue {
  readonly chainId: string
  readonly identity: { readonly kind: string; readonly value: string }
  readonly derivation: { readonly scheme: string; readonly path: string }
  readonly addresses: readonly [{ readonly value: string }]
  readonly publicKey: string
  readonly masterFingerprint?: string
  readonly scriptPubKey?: string
  readonly redeemScript?: string
}

interface PeaAccountValue {
  readonly address: string
  readonly publicKey: string
  readonly derivationScheme: 'pea_v1'
  readonly parent: { readonly addressIndex: number }
}

interface PreparedSigningValue {
  readonly commandId: string
  readonly operation: string
  readonly summary: unknown
  readonly execution: unknown
}

interface SignatureValue {
  readonly kind: string
  readonly signature: { readonly encoding: string; readonly value: string }
  readonly publicKey?: string
  readonly address: string
}

interface SignedTransactionValue {
  readonly kind: string
  readonly payload: { readonly encoding: string; readonly value: string }
  readonly transactionId: string
}

interface SignedPayloadValue {
  readonly kind: string
  readonly payload: { readonly encoding: string; readonly value: string }
}

interface VerificationValue {
  readonly verified: boolean
}

function parseTestResult<T>(value: unknown): TestResult<T> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a keyring result object')
  }
  const record = value as Record<string, unknown>
  if (record.ok === true && Object.prototype.hasOwnProperty.call(record, 'value')) {
    return { ok: true, value: record.value as T }
  }
  if (
    record.ok === false &&
    typeof record.error === 'object' &&
    record.error !== null &&
    !Array.isArray(record.error) &&
    typeof (record.error as Record<string, unknown>).code === 'string'
  ) {
    return {
      ok: false,
      error: { code: (record.error as Record<string, unknown>).code as string }
    }
  }
  throw new Error('Expected a successful or failed keyring result')
}

async function execute<T = unknown>(
  popup: Page,
  operation: string,
  payload: Record<string, unknown>,
  binding: Record<string, unknown> = CREDENTIAL_BINDING
): Promise<TestResult<T>> {
  const command = createRawCommand(operation, payload, binding)
  const response = await popup.evaluate(async input => {
    const command = structuredClone(input)
    if (Array.isArray(command.payload.message)) {
      command.payload.message = {
        $noirWalletBytes: btoa(String.fromCharCode(...command.payload.message))
      }
    }
    const request = command.payload.request
    if (
      typeof request === 'object' &&
      request !== null &&
      Array.isArray((request as Record<string, unknown>).nonce)
    ) {
      const nonce = (request as Record<string, unknown>).nonce as number[]
      ;(request as Record<string, unknown>).nonce = {
        $noirWalletBytes: btoa(String.fromCharCode(...nonce))
      }
    }
    return chrome.runtime.sendMessage({
      type: 'WORKER_RPC',
      method: 'multichain.conformance-execute',
      payload: { command }
    })
  }, command)
  expect(response).toEqual({
    result: expect.objectContaining({
      protocolVersion: 2,
      commandId: command.commandId
    })
  })
  return parseTestResult<T>(response.result)
}

async function executeAndAbort(popup: Page, operation: string, payload: Record<string, unknown>) {
  const command = createRawCommand(operation, payload)
  const response = await popup.evaluate(async input => {
    const pending = chrome.runtime.sendMessage({
      type: 'WORKER_RPC',
      method: 'multichain.conformance-execute',
      payload: { command: input }
    })
    const abort = await chrome.runtime.sendMessage({
      type: 'WORKER_RPC',
      method: 'multichain.abort',
      payload: { commandId: input.commandId }
    })
    return { abort, executed: await pending }
  }, command)
  return {
    abort: response.abort,
    result: parseTestResult(response.executed.result)
  }
}

async function executeZcashRpc<T>(
  popup: Page,
  method: string,
  payload: Record<string, unknown>
): Promise<{ result?: T; error?: string }> {
  return popup.evaluate(
    input =>
      chrome.runtime.sendMessage({
        type: 'WORKER_RPC',
        method: input.method,
        payload: input.payload
      }),
    { method, payload }
  )
}

function expectSuccess<T>(result: TestResult<T>): T {
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true })
  if (!result.ok) throw new Error(`Expected success, received ${result.error.code}`)
  return result.value
}

function requireBitcoinMasterFingerprint(account: AccountValue): string {
  expect(account.masterFingerprint).toMatch(/^0x[0-9a-f]{8}$/)
  if (account.masterFingerprint === undefined) {
    throw new Error('Expected a Bitcoin master fingerprint')
  }
  return account.masterFingerprint
}

test.describe('pinned Multichain WASM in the real MV3 extension', () => {
  test('creates 12/24-word credentials that the real Zcash WASM accepts', async ({ popup }) => {
    test.setTimeout(180_000)
    await waitForBackgroundWalletInitialization(popup)

    for (const wordCount of [12, 24] as const) {
      const created = expectSuccess(
        await execute<CreatedWalletValue>(popup, 'credential.create', {
          wordCount,
          password: PASSWORD
        })
      )
      expect(created.mnemonic.split(' ')).toHaveLength(wordCount)
      expect(created.vault).toMatchObject({
        version: 2,
        kdf: 'argon2id',
        cipher: 'xchacha20poly1305'
      })

      const zcashValidation = await popup.evaluate(
        phrase =>
          chrome.runtime.sendMessage({
            type: 'WORKER_RPC',
            method: 'mnemonic.validate',
            payload: { phrase }
          }),
        created.mnemonic
      )
      expect(zcashValidation).toEqual({ result: true })

      const zcashAddresses = await popup.evaluate(
        phrase =>
          chrome.runtime.sendMessage({
            type: 'WORKER_RPC',
            method: 'mnemonic.toAddresses',
            payload: { phrase, accountIndex: 0, network: 'mainnet' }
          }),
        created.mnemonic
      )
      expect(zcashAddresses).toMatchObject({
        result: {
          transparent: expect.stringMatching(/^t1/),
          unified: expect.stringMatching(/^u1/),
          full_unified: expect.stringMatching(/^u1/)
        }
      })

      expectSuccess(
        await execute(popup, 'credential.unlock', {
          vault: created.vault,
          password: PASSWORD
        })
      )
      expectSuccess(
        await execute<AccountValue>(popup, 'account.derive-public', {
          family: 'evm',
          chainId: 'eip155:1',
          addressIndex: 0
        })
      )
      expectSuccess(
        await execute<AccountValue>(popup, 'account.derive-public', {
          family: 'bitcoin',
          chainId: BITCOIN_MAINNET,
          addressType: 'p2wpkh',
          accountIndex: 0,
          change: false,
          addressIndex: 0
        })
      )
      expectSuccess(await execute(popup, 'credential.lock', {}))
    }
  })

  test('imports, scopes, signs, and exports multichain private-key vaults', async ({ popup }) => {
    test.setTimeout(180_000)
    await waitForBackgroundWalletInitialization(popup)

    const privateKey = `0x${'00'.repeat(31)}01`
    const evmVault = expectSuccess(
      await execute<VaultValue>(popup, 'credential.import-private-key', {
        privateKey,
        chainFamily: 'eip155',
        password: PASSWORD
      })
    )
    expect(evmVault).toMatchObject({ version: 2 })
    const evmSession = expectSuccess(
      await execute<SessionValue>(popup, 'credential.unlock', {
        vault: evmVault,
        password: PASSWORD
      })
    )
    expect(evmSession).toEqual({ state: 'unlocked' })
    const evmAccount = expectSuccess(
      await execute<AccountValue>(popup, 'account.derive-public', {
        family: 'evm',
        chainId: 'eip155:1',
        addressIndex: 0
      })
    )
    expect(evmAccount).toMatchObject({
      identity: { value: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf' },
      derivation: { scheme: 'imported', path: 'm' }
    })
    const evmMessage = [...new TextEncoder().encode('Imported EVM private-key ownership proof')]
    const preparedEvmMessage = expectSuccess(
      await execute<PreparedSigningValue>(popup, 'signing.prepare', {
        kind: 'evm-personal-message',
        chainId: 'eip155:1',
        addressIndex: 0,
        message: evmMessage
      })
    )
    expect(preparedEvmMessage.summary).toMatchObject({
      schema: 'evm.personal-message.v1',
      fields: { signer: evmAccount.identity.value }
    })
    expect(
      expectSuccess(
        await execute<SignatureValue>(popup, 'signing.confirm', {
          signingCommandId: preparedEvmMessage.commandId
        })
      ).signature.value
    ).toMatch(/^0x[0-9a-f]{130}$/)
    expect(
      await execute(popup, 'account.derive-public', {
        family: 'bitcoin',
        chainId: BITCOIN_MAINNET,
        addressType: 'p2wpkh',
        accountIndex: 0,
        change: false,
        addressIndex: 0
      })
    ).toMatchObject({ ok: false })
    expect(
      await execute(popup, 'credential.export-private-key', {
        vault: evmVault,
        password: 'wrong-password',
        chainId: 'eip155:1',
        addressIndex: 0
      })
    ).toMatchObject({ ok: false })
    expect(
      expectSuccess(
        await execute<ExportedPrivateKeyValue>(popup, 'credential.export-private-key', {
          vault: evmVault,
          password: PASSWORD,
          chainId: 'eip155:1',
          addressIndex: 0
        })
      )
    ).toEqual({
      chainId: 'eip155:1',
      format: 'hex',
      privateKey,
      hex: privateKey
    })
    const nextPassword = `${PASSWORD}-next`
    const rewrappedEvmVault = expectSuccess(
      await execute<VaultValue>(popup, 'credential.rewrap-private-key', {
        vault: evmVault,
        currentPassword: PASSWORD,
        newPassword: nextPassword,
        chainFamily: 'eip155'
      })
    )
    expect(JSON.stringify(rewrappedEvmVault)).not.toContain(privateKey.slice(2))
    expectSuccess(await execute(popup, 'credential.lock', {}))
    expect(
      await execute(popup, 'credential.unlock', { vault: rewrappedEvmVault, password: PASSWORD })
    ).toMatchObject({ ok: false })
    expectSuccess(
      await execute<SessionValue>(popup, 'credential.unlock', {
        vault: rewrappedEvmVault,
        password: nextPassword
      })
    )
    expect(
      expectSuccess(
        await execute<AccountValue>(popup, 'account.derive-public', {
          family: 'evm',
          chainId: 'eip155:8453',
          addressIndex: 0
        })
      ).identity.value
    ).toBe(evmAccount.identity.value)
    expectSuccess(await execute(popup, 'credential.lock', {}))

    const bitcoinVault = expectSuccess(
      await execute<VaultValue>(popup, 'credential.import-private-key', {
        privateKey,
        chainFamily: 'bip122',
        bitcoinNetwork: 'testnet',
        password: PASSWORD
      })
    )
    expectSuccess(
      await execute<SessionValue>(popup, 'credential.unlock', {
        vault: bitcoinVault,
        password: PASSWORD
      })
    )
    let bitcoinAddress = ''
    for (const [addressType, prefix] of [
      ['p2pkh', /^[mn]/],
      ['p2sh_p2wpkh', /^2/],
      ['p2wpkh', /^tb1q/],
      ['p2tr', /^tb1p/]
    ] as const) {
      const account = expectSuccess(
        await execute<AccountValue>(popup, 'account.derive-public', {
          family: 'bitcoin',
          chainId: BITCOIN_TESTNET,
          addressType,
          accountIndex: 0,
          change: false,
          addressIndex: 0
        })
      )
      expect(account.identity.value).toMatch(prefix)
      expect(account.derivation).toEqual({ scheme: 'imported', path: 'm' })
      if (addressType === 'p2wpkh') bitcoinAddress = account.identity.value
    }
    const bitcoinMessage = [
      ...new TextEncoder().encode('Imported Bitcoin private-key ownership proof')
    ]
    const preparedBitcoinMessage = expectSuccess(
      await execute<PreparedSigningValue>(popup, 'signing.prepare', {
        kind: 'bitcoin-bip322-message',
        chainId: BITCOIN_TESTNET,
        addressType: 'p2wpkh',
        accountIndex: 0,
        change: false,
        addressIndex: 0,
        message: bitcoinMessage
      })
    )
    expect(preparedBitcoinMessage.summary).toMatchObject({
      schema: 'bitcoin.bip322-message.v1',
      fields: { address: bitcoinAddress }
    })
    const signedBitcoinMessage = expectSuccess(
      await execute<SignatureValue>(popup, 'signing.confirm', {
        signingCommandId: preparedBitcoinMessage.commandId
      })
    )
    expect(
      expectSuccess(
        await execute<VerificationValue>(
          popup,
          'signing.verify',
          {
            kind: 'bitcoin-bip322-message',
            chainId: BITCOIN_TESTNET,
            address: bitcoinAddress,
            message: bitcoinMessage,
            signature: signedBitcoinMessage.signature.value
          },
          { kind: 'unbound' }
        )
      )
    ).toEqual({ verified: true })
    expect(
      await execute(popup, 'account.derive-public', {
        family: 'bitcoin',
        chainId: BITCOIN_MAINNET,
        addressType: 'p2wpkh',
        accountIndex: 0,
        change: false,
        addressIndex: 0
      })
    ).toMatchObject({ ok: false })
    const exportedBitcoin = expectSuccess(
      await execute<ExportedPrivateKeyValue>(popup, 'credential.export-private-key', {
        vault: bitcoinVault,
        password: PASSWORD,
        chainId: BITCOIN_TESTNET,
        addressType: 'p2wpkh',
        accountIndex: 0,
        change: false,
        addressIndex: 0
      })
    )
    expect(exportedBitcoin).toMatchObject({
      chainId: BITCOIN_TESTNET,
      format: 'wif',
      privateKey: expect.stringMatching(/^c[1-9A-HJ-NP-Za-km-z]{51}$/),
      hex: privateKey
    })
    expectSuccess(await execute(popup, 'credential.lock', {}))

    const solanaPrivateKey = 'US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx'
    const solanaVault = expectSuccess(
      await execute<VaultValue>(popup, 'credential.import-private-key', {
        privateKey: solanaPrivateKey,
        chainFamily: 'solana',
        password: PASSWORD
      })
    )
    expectSuccess(
      await execute<SessionValue>(popup, 'credential.unlock', {
        vault: solanaVault,
        password: PASSWORD
      })
    )
    const importedSolana = expectSuccess(
      await execute<AccountValue>(popup, 'account.derive-public', {
        family: 'solana',
        chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        accountIndex: 0
      })
    )
    expect(importedSolana).toMatchObject({
      derivation: { scheme: 'imported', path: 'm' },
      identity: { value: importedSolana.publicKey }
    })
    const importedSolanaMessage = [
      ...new TextEncoder().encode('Imported Solana private-key ownership proof')
    ]
    const preparedImportedSolanaMessage = expectSuccess(
      await execute<PreparedSigningValue>(popup, 'signing.prepare', {
        kind: 'solana-message',
        chainId: importedSolana.chainId,
        accountIndex: 0,
        message: importedSolanaMessage
      })
    )
    expect(
      expectSuccess(
        await execute<SignatureValue>(popup, 'signing.confirm', {
          signingCommandId: preparedImportedSolanaMessage.commandId
        })
      ).signature.value
    ).toMatch(/^[1-9A-HJ-NP-Za-km-z]{87,88}$/)
    expect(
      expectSuccess(
        await execute<ExportedPrivateKeyValue>(popup, 'credential.export-private-key', {
          vault: solanaVault,
          password: PASSWORD,
          chainId: importedSolana.chainId,
          accountIndex: 0,
          addressIndex: 0
        })
      )
    ).toMatchObject({
      format: 'base58',
      privateKey: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{87,88}$/),
      hex: `0x${'07'.repeat(32)}`
    })
    expectSuccess(await execute(popup, 'credential.lock', {}))

    const nearPrivateKey = 'ed25519:cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN'
    const nearVault = expectSuccess(
      await execute<VaultValue>(popup, 'credential.import-private-key', {
        privateKey: nearPrivateKey,
        chainFamily: 'near',
        password: PASSWORD
      })
    )
    expectSuccess(
      await execute<SessionValue>(popup, 'credential.unlock', {
        vault: nearVault,
        password: PASSWORD
      })
    )
    const importedNear = expectSuccess(
      await execute<AccountValue>(popup, 'account.derive-public', {
        family: 'near',
        chainId: 'near:mainnet',
        accountIndex: 0
      })
    )
    expect(importedNear.derivation).toEqual({ scheme: 'imported', path: 'm' })
    const importedNearRequest = {
      chainId: importedNear.chainId,
      accountIndex: 0,
      accountId: importedNear.identity.value,
      message: 'Imported NEAR private-key ownership proof',
      recipient: 'noirwallet.near',
      nonce: Array.from({ length: 32 }, (_, index) => index),
      callbackUrl: null,
      state: null
    }
    const preparedImportedNearMessage = expectSuccess(
      await execute<PreparedSigningValue>(popup, 'signing.prepare', {
        kind: 'near-nep413-message',
        chainId: importedNear.chainId,
        accountIndex: 0,
        request: importedNearRequest
      })
    )
    expect(
      expectSuccess(
        await execute<SignatureValue>(popup, 'signing.confirm', {
          signingCommandId: preparedImportedNearMessage.commandId
        })
      ).signature
    ).toMatchObject({
      encoding: 'base64',
      value: expect.stringMatching(/^(?:[A-Za-z0-9+/]{4}){21}[A-Za-z0-9+/]{2}==$/)
    })
    expect(
      expectSuccess(
        await execute<ExportedPrivateKeyValue>(popup, 'credential.export-private-key', {
          vault: nearVault,
          password: PASSWORD,
          chainId: importedNear.chainId,
          accountIndex: 0,
          addressIndex: 0
        })
      )
    ).toMatchObject({
      format: 'near_ed25519',
      privateKey: expect.stringMatching(/^ed25519:[1-9A-HJ-NP-Za-km-z]{87,88}$/),
      hex: `0x${'09'.repeat(32)}`
    })
    expectSuccess(await execute(popup, 'credential.lock', {}))
  })

  test('invalidates pending work on abort, restart, and global lock', async ({ popup }) => {
    test.setTimeout(180_000)
    await waitForBackgroundWalletInitialization(popup)

    const aborted = await executeAndAbort(popup, 'credential.import', {
      mnemonic: MNEMONIC,
      password: PASSWORD
    })
    expect(aborted.abort).toEqual({ result: true })
    expect(aborted.result).toMatchObject({
      ok: false,
      error: { code: 'SIGNING_COMMAND_CANCELLED' }
    })

    const vault = expectSuccess(
      await execute<VaultValue>(popup, 'credential.import', {
        mnemonic: MNEMONIC,
        password: PASSWORD
      })
    )
    expectSuccess(await execute(popup, 'credential.unlock', { vault, password: PASSWORD }))
    const message = [...new TextEncoder().encode('pending signing lifecycle')]

    const cancelledSigning = expectSuccess(
      await execute<PreparedSigningValue>(popup, 'signing.prepare', {
        kind: 'evm-personal-message',
        chainId: 'eip155:1',
        addressIndex: 0,
        message
      })
    )
    expectSuccess(await execute(popup, 'signing.cancel-all', {}))
    expect(
      await execute(popup, 'signing.confirm', {
        signingCommandId: cancelledSigning.commandId
      })
    ).toMatchObject({ ok: false, error: { code: 'SIGNING_COMMAND_NOT_FOUND' } })

    const restartedSigning = expectSuccess(
      await execute<PreparedSigningValue>(popup, 'signing.prepare', {
        kind: 'evm-personal-message',
        chainId: 'eip155:1',
        addressIndex: 0,
        message
      })
    )
    await expect(
      popup.evaluate(() =>
        chrome.runtime.sendMessage({
          type: 'WORKER_RPC',
          method: 'multichain.conformance-restart',
          payload: {}
        })
      )
    ).resolves.toEqual({ result: true })
    expect(
      await execute(popup, 'signing.confirm', {
        signingCommandId: restartedSigning.commandId
      })
    ).toMatchObject({ ok: false, error: { code: 'SIGNING_COMMAND_NOT_FOUND' } })

    expectSuccess(await execute(popup, 'credential.unlock', { vault, password: PASSWORD }))
    const lockedSigning = expectSuccess(
      await execute<PreparedSigningValue>(popup, 'signing.prepare', {
        kind: 'evm-personal-message',
        chainId: 'eip155:1',
        addressIndex: 0,
        message
      })
    )

    const zcashWalletId = `dual-lock-${crypto.randomUUID()}`
    const zcashDbKey = `mainnet_${zcashWalletId}`
    expect(
      await executeZcashRpc<boolean | 'empty'>(popup, 'init', {
        walletId: zcashWalletId,
        network: 'mainnet',
        lightwalletdUrl: 'https://zcash-wallet-grpc-self.deltarpc.com',
        dbKey: zcashDbKey
      })
    ).toEqual({ result: expect.anything() })
    expect(
      await executeZcashRpc<number>(popup, 'wallet.createAccount', {
        walletId: zcashWalletId,
        seedPhrase: MNEMONIC,
        accountIndex: 0,
        birthdayHeight: 3_000_000
      })
    ).toEqual({ result: expect.any(Number) })
    expect(
      await executeZcashRpc<number[]>(popup, 'wallet.getAccountIds', {
        walletId: zcashWalletId
      })
    ).toEqual({ result: [expect.any(Number)] })
    expect(
      await executeZcashRpc<boolean>(popup, 'wallet.persistDb', {
        walletId: zcashWalletId,
        key: zcashDbKey
      })
    ).toEqual({ result: true })

    await expect(
      popup.evaluate(() => chrome.runtime.sendMessage({ type: 'WALLET_LOCKED' }))
    ).resolves.toEqual({ success: true })
    expect(
      await execute(popup, 'signing.confirm', {
        signingCommandId: lockedSigning.commandId
      })
    ).toMatchObject({ ok: false, error: { code: 'SIGNING_COMMAND_NOT_FOUND' } })
    expect(
      await executeZcashRpc<number[]>(popup, 'wallet.getAccountIds', {
        walletId: zcashWalletId
      })
    ).toEqual({ error: expect.stringMatching(/not initialized/i) })
  })

  test('rejects oversized commands without poisoning the Worker route', async ({ popup }) => {
    test.setTimeout(120_000)
    await waitForBackgroundWalletInitialization(popup)
    const command = createRawCommand('signing.prepare', {
      oversized: 'x'.repeat(1_048_577)
    })
    await expect(
      popup.evaluate(
        input =>
          chrome.runtime.sendMessage({
            type: 'WORKER_RPC',
            method: 'multichain.conformance-execute',
            payload: { command: input }
          }),
        command
      )
    ).resolves.toEqual({ error: 'Invalid Multichain Worker command' })

    expectSuccess(
      await execute<CapabilitiesValue>(popup, 'capabilities.get', {}, { kind: 'unbound' })
    )
  })

  test('imports one mnemonic and runs multichain derive/sign flows', async ({ popup }) => {
    test.setTimeout(180_000)
    await waitForBackgroundWalletInitialization(popup)

    const capabilities = expectSuccess(
      await execute<CapabilitiesValue>(popup, 'capabilities.get', {}, { kind: 'unbound' })
    )
    expect(capabilities).toMatchObject({
      abiVersion: 'wallet-engine-cbd8ffb-v5',
      sourceCommit: 'cbd8ffbb192d67a3bd19eb5a4dcc38669f5e4f7a'
    })
    expect(capabilities.capabilities).toEqual(
      expect.arrayContaining([
        'account.evm.derive',
        'account.solana.derive',
        'account.near.derive',
        'account.bitcoin.batch-derive',
        'account.bitcoin.derive',
        'bitcoin.bip322.full.sign',
        'bitcoin.bip322.full.verify',
        'evm.transaction.sign',
        'evm.pea-v1.transaction.sign',
        'bitcoin.psbt-v0.sign',
        'credential.export-private-key',
        'credential.import-private-key-bip122',
        'credential.import-private-key-eip155',
        'credential.import-private-key-solana',
        'credential.import-private-key-near',
        'vault.private-key-v2'
      ])
    )

    const vault = expectSuccess(
      await execute<VaultValue>(popup, 'credential.import', {
        mnemonic: MNEMONIC,
        password: PASSWORD
      })
    )
    expect(vault).toMatchObject({
      version: 2,
      kdf: 'argon2id',
      cipher: 'xchacha20poly1305'
    })
    expectSuccess(await execute(popup, 'credential.unlock', { vault, password: PASSWORD }))

    const evm = expectSuccess(
      await execute<AccountValue>(popup, 'account.derive-public', {
        family: 'evm',
        chainId: 'eip155:1',
        addressIndex: 0
      })
    )
    expect(evm).toMatchObject({
      chainId: 'eip155:1',
      identity: {
        kind: 'account-identifier',
        value: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
      },
      derivation: { scheme: 'bip44', path: "m/44'/60'/0'/0/0" }
    })

    const pea = expectSuccess(
      await execute<PeaAccountValue>(popup, 'account.derive-public', {
        family: 'pea',
        addressIndex: 0
      })
    )
    expect(pea).toMatchObject({
      address: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/),
      publicKey: expect.stringMatching(/^0x0[23][0-9a-f]{64}$/),
      derivationScheme: 'pea_v1',
      parent: { addressIndex: 0 }
    })

    const evmAccountOne = expectSuccess(
      await execute<AccountValue>(popup, 'account.derive-public', {
        family: 'evm',
        chainId: 'eip155:1',
        addressIndex: 1
      })
    )
    expect(evmAccountOne).toMatchObject({
      chainId: 'eip155:1',
      identity: {
        kind: 'account-identifier',
        value: '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0'
      },
      derivation: { scheme: 'bip44', path: "m/44'/60'/0'/0/1" }
    })

    const solana = expectSuccess(
      await execute<AccountValue>(popup, 'account.derive-public', {
        family: 'solana',
        chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        accountIndex: 0
      })
    )
    expect(solana).toMatchObject({
      chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      identity: { value: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' },
      publicKey: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk',
      derivation: { scheme: 'slip10', path: "m/44'/501'/0'/0'" }
    })

    const solanaTransfer = buildSolanaNativeTransfer({
      chainId: solana.chainId,
      sender: solana.identity.value,
      recipient: 'SysvarRent111111111111111111111111111111111',
      recentBlockhash: 'SysvarC1ock11111111111111111111111111111111',
      lamports: '5000'
    })
    const preparedSolanaTransfer = expectSuccess(
      await execute<PreparedSigningValue>(popup, 'signing.prepare', {
        kind: 'solana-transaction',
        chainId: solana.chainId,
        accountIndex: 0,
        transaction: solanaTransfer.transactionBase64
      })
    )
    expect(preparedSolanaTransfer).toMatchObject({
      operation: 'transaction',
      summary: {
        schema: 'solana.transaction.v1',
        review: { level: 'standard', issues: [] },
        fields: {
          feePayer: solana.identity.value,
          instructions: [
            {
              programId: '11111111111111111111111111111111',
              interpretation: {
                kind: 'system-transfer',
                from: solana.identity.value,
                to: solanaTransfer.recipient,
                lamports: solanaTransfer.lamports
              }
            }
          ]
        }
      }
    })
    const signedSolanaTransfer = expectSuccess(
      await execute<SignedTransactionValue>(popup, 'signing.confirm', {
        signingCommandId: preparedSolanaTransfer.commandId
      })
    )
    expect(signedSolanaTransfer).toMatchObject({
      kind: 'signed-payload',
      payload: { encoding: 'base64' },
      transactionId: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{87,88}$/)
    })

    const priorityFeeTransaction = buildSolanaPriorityFeeTransfer({
      sender: solana.identity.value,
      recipient: solanaTransfer.recipient,
      recentBlockhash: 'SysvarC1ock11111111111111111111111111111111',
      lamports: '5000',
      computeUnitLimit: 200_000,
      computeUnitPriceMicroLamports: 250n
    })
    const preparedPriorityFeeTransfer = expectSuccess(
      await execute<PreparedSigningValue>(popup, 'signing.prepare', {
        kind: 'solana-transaction',
        chainId: solana.chainId,
        accountIndex: 0,
        transaction: priorityFeeTransaction
      })
    )
    expect(preparedPriorityFeeTransfer.summary).toMatchObject({
      schema: 'solana.transaction.v1',
      review: { level: 'standard', issues: [] },
      fields: {
        computeUnitLimit: '200000',
        computeUnitPriceMicroLamports: '250',
        maximumPriorityFeeLamports: '50',
        instructions: [
          { interpretation: { kind: 'compute-unit-limit', units: '200000' } },
          { interpretation: { kind: 'compute-unit-price', microLamports: '250' } },
          {
            interpretation: {
              kind: 'system-transfer',
              from: solana.identity.value,
              to: solanaTransfer.recipient,
              lamports: '5000'
            }
          }
        ]
      }
    })
    expectSuccess(
      await execute<SignedTransactionValue>(popup, 'signing.confirm', {
        signingCommandId: preparedPriorityFeeTransfer.commandId
      })
    )

    const near = expectSuccess(
      await execute<AccountValue>(popup, 'account.derive-public', {
        family: 'near',
        chainId: 'near:mainnet',
        accountIndex: 0
      })
    )
    expect(near).toMatchObject({
      chainId: 'near:mainnet',
      identity: {
        value: '5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412'
      },
      publicKey: 'ed25519:6j4b6zUaty6fD1awqcGCCU9JYGCWYUgdJhQrzfZhqE25',
      derivation: { scheme: 'slip10', path: "m/44'/397'/0'" }
    })

    const nearTransaction = {
      chainId: near.chainId,
      accountIndex: 0,
      signerId: near.identity.value,
      receiverId: 'alice.near',
      nonce: '1',
      blockHash: 'SysvarC1ock11111111111111111111111111111111',
      actions: [{ type: 'transfer', depositYocto: '1' }]
    }
    const preparedNearTransfer = expectSuccess(
      await execute<PreparedSigningValue>(popup, 'signing.prepare', {
        kind: 'near-transaction',
        chainId: near.chainId,
        accountIndex: 0,
        transaction: nearTransaction
      })
    )
    expect(preparedNearTransfer).toMatchObject({
      operation: 'transaction',
      summary: {
        schema: 'near.transaction.v1',
        review: { level: 'standard', issues: [] },
        fields: {
          signerId: near.identity.value,
          publicKey: near.publicKey,
          nonce: '1',
          receiverId: 'alice.near',
          actions: [{ kind: 'transfer', depositYocto: '1' }]
        }
      }
    })
    const signedNearTransfer = expectSuccess(
      await execute<SignedTransactionValue>(popup, 'signing.confirm', {
        signingCommandId: preparedNearTransfer.commandId
      })
    )
    expect(signedNearTransfer).toMatchObject({
      kind: 'signed-payload',
      payload: { encoding: 'base64' },
      transactionId: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
    })

    const solanaMessage = [...new TextEncoder().encode('Noir Wallet Solana ownership proof')]
    const preparedSolanaMessage = expectSuccess(
      await execute<PreparedSigningValue>(popup, 'signing.prepare', {
        kind: 'solana-message',
        chainId: solana.chainId,
        accountIndex: 0,
        message: solanaMessage
      })
    )
    expect(preparedSolanaMessage).toMatchObject({
      operation: 'message',
      summary: {
        schema: 'solana.message.v1',
        fields: {
          signer: solana.identity.value,
          domain: 'solana:raw-message'
        }
      },
      execution: { kind: 'internal' }
    })
    const signedSolanaMessage = expectSuccess(
      await execute<SignatureValue>(popup, 'signing.confirm', {
        signingCommandId: preparedSolanaMessage.commandId
      })
    )
    expect(signedSolanaMessage).toMatchObject({
      kind: 'signature',
      signature: {
        encoding: 'utf8',
        value: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{87,88}$/)
      },
      publicKey: solana.publicKey,
      address: solana.identity.value
    })

    const nearMessageRequest = {
      chainId: near.chainId,
      accountIndex: 0,
      accountId: near.identity.value,
      message: 'Noir Wallet NEAR ownership proof',
      recipient: 'noirwallet.test',
      nonce: Array.from({ length: 32 }, (_, index) => index),
      callbackUrl: null,
      state: null
    }
    const preparedNearMessage = expectSuccess(
      await execute<PreparedSigningValue>(popup, 'signing.prepare', {
        kind: 'near-nep413-message',
        chainId: near.chainId,
        accountIndex: 0,
        request: nearMessageRequest
      })
    )
    expect(preparedNearMessage).toMatchObject({
      operation: 'message',
      summary: {
        schema: 'near.nep413-message.v1',
        fields: {
          signerId: near.identity.value,
          publicKey: near.publicKey,
          recipient: nearMessageRequest.recipient
        }
      },
      execution: { kind: 'internal' }
    })
    const signedNearMessage = expectSuccess(
      await execute<SignatureValue>(popup, 'signing.confirm', {
        signingCommandId: preparedNearMessage.commandId
      })
    )
    expect(signedNearMessage).toMatchObject({
      kind: 'signature',
      signature: {
        encoding: 'base64',
        value: expect.stringMatching(/^(?:[A-Za-z0-9+/]{4}){21}[A-Za-z0-9+/]{2}==$/)
      },
      publicKey: near.publicKey,
      address: near.identity.value
    })

    const bitcoin = expectSuccess(
      await execute<AccountValue>(popup, 'account.derive-public', {
        family: 'bitcoin',
        chainId: BITCOIN_MAINNET,
        addressType: 'p2wpkh',
        accountIndex: 0,
        change: false,
        addressIndex: 0
      })
    )
    expect(bitcoin).toMatchObject({
      chainId: BITCOIN_MAINNET,
      masterFingerprint: '0x73c5da0a',
      identity: {
        value: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
      },
      derivation: { scheme: 'bip84', path: "m/84'/0'/0'/0/0" }
    })
    const bitcoinTestnet = expectSuccess(
      await execute<AccountValue>(popup, 'account.derive-public', {
        family: 'bitcoin',
        chainId: BITCOIN_TESTNET,
        addressType: 'p2wpkh',
        accountIndex: 0,
        change: false,
        addressIndex: 0
      })
    )
    expect(bitcoinTestnet).toMatchObject({
      chainId: BITCOIN_TESTNET,
      masterFingerprint: '0x73c5da0a',
      identity: { value: expect.stringMatching(/^tb1q/) },
      derivation: { scheme: 'bip84', path: "m/84'/1'/0'/0/0" }
    })
    const bitcoinTestnetChange = expectSuccess(
      await execute<AccountValue>(popup, 'account.derive-public', {
        family: 'bitcoin',
        chainId: BITCOIN_TESTNET,
        addressType: 'p2wpkh',
        accountIndex: 0,
        change: true,
        addressIndex: 0
      })
    )
    const bitcoinTestnetRecipient = expectSuccess(
      await execute<AccountValue>(popup, 'account.derive-public', {
        family: 'bitcoin',
        chainId: BITCOIN_TESTNET,
        addressType: 'p2wpkh',
        accountIndex: 0,
        change: false,
        addressIndex: 1
      })
    )
    const taproot = expectSuccess(
      await execute<AccountValue>(popup, 'account.derive-public', {
        family: 'bitcoin',
        chainId: BITCOIN_MAINNET,
        addressType: 'p2tr',
        accountIndex: 0,
        change: false,
        addressIndex: 0
      })
    )
    expect(taproot).toMatchObject({
      chainId: BITCOIN_MAINNET,
      masterFingerprint: '0x73c5da0a',
      identity: {
        value: 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr'
      },
      derivation: { scheme: 'bip86', path: "m/86'/0'/0'/0/0" }
    })
    const bitcoinChange = expectSuccess(
      await execute<AccountValue>(popup, 'account.derive-public', {
        family: 'bitcoin',
        chainId: BITCOIN_MAINNET,
        addressType: 'p2wpkh',
        accountIndex: 0,
        change: true,
        addressIndex: 0
      })
    )
    const taprootChange = expectSuccess(
      await execute<AccountValue>(popup, 'account.derive-public', {
        family: 'bitcoin',
        chainId: BITCOIN_MAINNET,
        addressType: 'p2tr',
        accountIndex: 0,
        change: true,
        addressIndex: 0
      })
    )
    const legacy = expectSuccess(
      await execute<AccountValue>(popup, 'account.derive-public', {
        family: 'bitcoin',
        chainId: BITCOIN_MAINNET,
        addressType: 'p2pkh',
        accountIndex: 0,
        change: false,
        addressIndex: 0
      })
    )
    expect(legacy).toMatchObject({
      derivation: { scheme: 'bip44', path: "m/44'/0'/0'/0/0" },
      scriptPubKey: expect.stringMatching(/^0x76a914[0-9a-f]{40}88ac$/)
    })
    const legacyChange = expectSuccess(
      await execute<AccountValue>(popup, 'account.derive-public', {
        family: 'bitcoin',
        chainId: BITCOIN_MAINNET,
        addressType: 'p2pkh',
        accountIndex: 0,
        change: true,
        addressIndex: 0
      })
    )
    const nested = expectSuccess(
      await execute<AccountValue>(popup, 'account.derive-public', {
        family: 'bitcoin',
        chainId: BITCOIN_MAINNET,
        addressType: 'p2sh_p2wpkh',
        accountIndex: 0,
        change: false,
        addressIndex: 0
      })
    )
    expect(nested).toMatchObject({
      derivation: { scheme: 'bip49', path: "m/49'/0'/0'/0/0" },
      scriptPubKey: expect.stringMatching(/^0xa914[0-9a-f]{40}87$/),
      redeemScript: expect.stringMatching(/^0x0014[0-9a-f]{40}$/)
    })
    const nestedChange = expectSuccess(
      await execute<AccountValue>(popup, 'account.derive-public', {
        family: 'bitcoin',
        chainId: BITCOIN_MAINNET,
        addressType: 'p2sh_p2wpkh',
        accountIndex: 0,
        change: true,
        addressIndex: 0
      })
    )
    const bitcoinBatch = expectSuccess(
      await execute<readonly AccountValue[]>(popup, 'account.derive-public', {
        family: 'bitcoin',
        chainId: BITCOIN_MAINNET,
        addressType: 'p2wpkh',
        accountIndex: 0,
        change: false,
        startAddressIndex: 0,
        count: 3
      })
    )
    expect(bitcoinBatch.map(account => account.derivation.path)).toEqual([
      "m/84'/0'/0'/0/0",
      "m/84'/0'/0'/0/1",
      "m/84'/0'/0'/0/2"
    ])

    const message = [...new TextEncoder().encode('Noir Wallet EVM ownership proof')]
    const preparedMessage = expectSuccess(
      await execute<PreparedSigningValue>(popup, 'signing.prepare', {
        kind: 'evm-personal-message',
        chainId: 'eip155:1',
        addressIndex: 0,
        message
      })
    )
    expect(preparedMessage).toMatchObject({
      operation: 'message',
      summary: {
        schema: 'evm.personal-message.v1',
        fields: { signer: evm.identity.value }
      },
      execution: { kind: 'internal' }
    })
    const signedMessage = expectSuccess(
      await execute<SignatureValue>(popup, 'signing.confirm', {
        signingCommandId: preparedMessage.commandId
      })
    )
    expect(signedMessage).toMatchObject({
      kind: 'signature',
      signature: { encoding: 'hex' },
      address: evm.identity.value
    })
    expect(signedMessage.signature.value).toMatch(/^0x[0-9a-f]{130}$/)

    const preparedPeaMessage = expectSuccess(
      await execute<PreparedSigningValue>(popup, 'signing.prepare', {
        kind: 'pea-evm-personal-message',
        chainId: 'eip155:1',
        addressIndex: 0,
        message: [...new TextEncoder().encode('Noir Wallet PEA ownership proof')]
      })
    )
    const signedPeaMessage = expectSuccess(
      await execute<SignatureValue>(popup, 'signing.confirm', {
        signingCommandId: preparedPeaMessage.commandId
      })
    )
    expect(signedPeaMessage).toMatchObject({
      kind: 'signature',
      signature: { encoding: 'hex' },
      address: pea.address
    })
    expect(signedPeaMessage.signature.value).toMatch(/^0x[0-9a-f]{130}$/)

    const preparedTransaction = expectSuccess(
      await execute<PreparedSigningValue>(popup, 'signing.prepare', {
        kind: 'evm-transaction',
        chainId: 'eip155:1',
        addressIndex: 0,
        transaction: {
          type: 'legacy',
          chainId: '1',
          nonce: '0',
          gasPrice: '1000000000',
          gasLimit: '21000',
          to: '0x0000000000000000000000000000000000000001',
          value: '1',
          input: '0x'
        }
      })
    )
    expect(preparedTransaction.summary).toMatchObject({
      schema: 'evm.transaction.v1',
      fields: {
        from: evm.identity.value,
        maximumFeeWei: '21000000000000'
      }
    })
    const signedTransaction = expectSuccess(
      await execute<SignedTransactionValue>(popup, 'signing.confirm', {
        signingCommandId: preparedTransaction.commandId
      })
    )
    expect(signedTransaction).toMatchObject({
      kind: 'signed-payload',
      payload: { encoding: 'hex' }
    })
    expect(signedTransaction.transactionId).toMatch(/^0x[0-9a-f]{64}$/)

    const preparedPeaTransaction = expectSuccess(
      await execute<PreparedSigningValue>(popup, 'signing.prepare', {
        kind: 'pea-evm-transaction',
        chainId: 'eip155:1',
        addressIndex: 0,
        transaction: {
          type: 'legacy',
          chainId: '1',
          nonce: '0',
          gasPrice: '1000000000',
          gasLimit: '21000',
          to: '0x0000000000000000000000000000000000000001',
          value: '1',
          input: '0x'
        }
      })
    )
    expect(preparedPeaTransaction.summary).toMatchObject({
      schema: 'evm.transaction.v1',
      fields: { from: pea.address, maximumFeeWei: '21000000000000' }
    })
    const signedPeaTransaction = expectSuccess(
      await execute<SignedTransactionValue>(popup, 'signing.confirm', {
        signingCommandId: preparedPeaTransaction.commandId
      })
    )
    expect(signedPeaTransaction).toMatchObject({
      kind: 'signed-payload',
      payload: { encoding: 'hex' }
    })
    expect(signedPeaTransaction.transactionId).toMatch(/^0x[0-9a-f]{64}$/)

    const evmChainId = parseChainId('eip155:1').id
    const evmChains = createEvmBitcoinChainRegistry('mainnet')
    const evmAssets = createAssetRegistry(evmChains, getBundledEvmAssetDefinitions('mainnet'))
    const transactionRpc = {
      assertExpectedChain: async () => {},
      getNativeBalance: async () => '1000000000000000000000',
      getPendingNonce: async () => '0',
      simulateCall: async () => `0x${'0'.repeat(63)}1`,
      estimateGas: async () => '65000',
      getMaximumPriorityFeePerGas: async () => '1000000000',
      getLatestBlockFee: async () => ({
        blockNumber: '20000000',
        baseFeePerGas: '2000000000'
      })
    }
    const builtTokenTransfer = await buildEvmTransfer({
      chainId: evmChainId,
      chainAccount: {
        id: 'chain-account:multichain-e2e:evm:0',
        scope: {
          keyDomainId: 'key-domain:multichain-e2e',
          accountId: 'account:multichain-e2e:0',
          chainId: evmChainId
        },
        derivation: evm.derivation,
        identity: evm.identity,
        createdAt: Date.now()
      },
      assets: evmAssets,
      intent: {
        assetId: 'eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        recipient: '0x0000000000000000000000000000000000000001',
        amountRaw: '1000000'
      },
      rpc: transactionRpc
    })
    const preparedTokenTransfer = expectSuccess(
      await execute<PreparedSigningValue>(
        popup,
        'signing.prepare',
        createEvmSigningPreparePayload(builtTokenTransfer)
      )
    )
    expect(preparedTokenTransfer.summary).toMatchObject({
      schema: 'evm.transaction.v1',
      review: { level: 'caution', issues: [{ code: 'unrecognized-call' }] },
      fields: {
        from: evm.identity.value,
        to: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        valueWei: '0',
        gasLimit: '78000',
        maximumFeeWei: '390000000000000',
        methodSelector: '0xa9059cbb'
      }
    })
    await assertEvmTransferFresh(builtTokenTransfer, transactionRpc)
    const signedTokenTransfer = expectSuccess(
      await execute<SignedTransactionValue>(popup, 'signing.confirm', {
        signingCommandId: preparedTokenTransfer.commandId
      })
    )
    expect(signedTokenTransfer).toMatchObject({
      kind: 'signed-payload',
      payload: { encoding: 'hex' }
    })
    expect(signedTokenTransfer.transactionId).toMatch(/^0x[0-9a-f]{64}$/)
    await expect(
      assertSignedEvmTransactionMatchesPrepared(builtTokenTransfer, {
        rawTransaction: signedTokenTransfer.payload.value,
        transactionHash: signedTokenTransfer.transactionId
      })
    ).resolves.toBeUndefined()

    const typedDataJson = JSON.stringify({
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' }
        ],
        Message: [{ name: 'contents', type: 'string' }]
      },
      primaryType: 'Message',
      domain: {
        name: 'Noir Wallet',
        version: '1',
        chainId: 1,
        verifyingContract: '0x0000000000000000000000000000000000000001'
      },
      message: { contents: 'EIP-712 integration test' }
    })
    const preparedTypedData = expectSuccess(
      await execute<PreparedSigningValue>(popup, 'signing.prepare', {
        kind: 'evm-typed-data',
        chainId: 'eip155:1',
        addressIndex: 0,
        typedDataJson
      })
    )
    expect(preparedTypedData.summary).toMatchObject({
      schema: 'evm.typed-data.v1',
      fields: { signer: evm.identity.value, primaryType: 'Message' }
    })
    const signedTypedData = expectSuccess(
      await execute<SignatureValue>(popup, 'signing.confirm', {
        signingCommandId: preparedTypedData.commandId
      })
    )
    expect(signedTypedData.signature.value).toMatch(/^0x[0-9a-f]{130}$/)

    const preparedPeaTypedData = expectSuccess(
      await execute<PreparedSigningValue>(popup, 'signing.prepare', {
        kind: 'pea-evm-typed-data',
        chainId: 'eip155:1',
        addressIndex: 0,
        typedDataJson
      })
    )
    expect(preparedPeaTypedData.summary).toMatchObject({
      schema: 'evm.typed-data.v1',
      fields: { signer: pea.address, primaryType: 'Message' }
    })
    const signedPeaTypedData = expectSuccess(
      await execute<SignatureValue>(popup, 'signing.confirm', {
        signingCommandId: preparedPeaTypedData.commandId
      })
    )
    expect(signedPeaTypedData).toMatchObject({
      kind: 'signature',
      signature: { encoding: 'hex' },
      address: pea.address
    })
    expect(signedPeaTypedData.signature.value).toMatch(/^0x[0-9a-f]{130}$/)

    const bitcoinMessage = [...new TextEncoder().encode('Noir Wallet Bitcoin ownership proof')]
    const preparedBitcoinMessage = expectSuccess(
      await execute<PreparedSigningValue>(popup, 'signing.prepare', {
        kind: 'bitcoin-bip322-message',
        chainId: BITCOIN_MAINNET,
        addressType: 'p2wpkh',
        accountIndex: 0,
        change: false,
        addressIndex: 0,
        message: bitcoinMessage
      })
    )
    expect(preparedBitcoinMessage.summary).toMatchObject({
      schema: 'bitcoin.bip322-message.v1',
      fields: { address: bitcoin.identity.value }
    })
    const signedBitcoinMessage = expectSuccess(
      await execute<SignatureValue>(popup, 'signing.confirm', {
        signingCommandId: preparedBitcoinMessage.commandId
      })
    )
    expect(signedBitcoinMessage.signature.value).toMatch(/^smp/)
    const verifiedBitcoinMessage = expectSuccess(
      await execute<VerificationValue>(
        popup,
        'signing.verify',
        {
          kind: 'bitcoin-bip322-message',
          chainId: BITCOIN_MAINNET,
          address: bitcoin.identity.value,
          message: bitcoinMessage,
          signature: signedBitcoinMessage.signature.value
        },
        { kind: 'unbound' }
      )
    )
    expect(verifiedBitcoinMessage).toEqual({ verified: true })
    const rejectedTamperedMessage = expectSuccess(
      await execute<VerificationValue>(
        popup,
        'signing.verify',
        {
          kind: 'bitcoin-bip322-message',
          chainId: BITCOIN_MAINNET,
          address: bitcoin.identity.value,
          message: [...new TextEncoder().encode('tampered')],
          signature: signedBitcoinMessage.signature.value
        },
        { kind: 'unbound' }
      )
    )
    expect(rejectedTamperedMessage).toEqual({ verified: false })

    const testnetMessage = [
      ...new TextEncoder().encode('Noir Wallet Bitcoin testnet ownership proof')
    ]
    const preparedTestnetMessage = expectSuccess(
      await execute<PreparedSigningValue>(popup, 'signing.prepare', {
        kind: 'bitcoin-bip322-message',
        chainId: BITCOIN_TESTNET,
        addressType: 'p2wpkh',
        accountIndex: 0,
        change: false,
        addressIndex: 0,
        message: testnetMessage
      })
    )
    expect(preparedTestnetMessage.summary).toMatchObject({
      schema: 'bitcoin.bip322-message.v1',
      fields: { address: bitcoinTestnet.identity.value }
    })
    const signedTestnetMessage = expectSuccess(
      await execute<SignatureValue>(popup, 'signing.confirm', {
        signingCommandId: preparedTestnetMessage.commandId
      })
    )
    const verifiedTestnetMessage = expectSuccess(
      await execute<VerificationValue>(
        popup,
        'signing.verify',
        {
          kind: 'bitcoin-bip322-message',
          chainId: BITCOIN_TESTNET,
          address: bitcoinTestnet.identity.value,
          message: testnetMessage,
          signature: signedTestnetMessage.signature.value
        },
        { kind: 'unbound' }
      )
    )
    expect(verifiedTestnetMessage).toEqual({ verified: true })

    const preparedTaprootMessage = expectSuccess(
      await execute<PreparedSigningValue>(popup, 'signing.prepare', {
        kind: 'bitcoin-bip322-message',
        chainId: BITCOIN_MAINNET,
        addressType: 'p2tr',
        accountIndex: 0,
        change: false,
        addressIndex: 0,
        message: bitcoinMessage
      })
    )
    expect(preparedTaprootMessage.summary).toMatchObject({
      schema: 'bitcoin.bip322-message.v1',
      fields: { address: taproot.identity.value }
    })
    const signedTaprootMessage = expectSuccess(
      await execute<SignatureValue>(popup, 'signing.confirm', {
        signingCommandId: preparedTaprootMessage.commandId
      })
    )
    const verifiedTaprootMessage = expectSuccess(
      await execute<VerificationValue>(
        popup,
        'signing.verify',
        {
          kind: 'bitcoin-bip322-message',
          chainId: BITCOIN_MAINNET,
          address: taproot.identity.value,
          message: bitcoinMessage,
          signature: signedTaprootMessage.signature.value
        },
        { kind: 'unbound' }
      )
    )
    expect(verifiedTaprootMessage).toEqual({ verified: true })

    for (const [account, addressType] of [
      [legacy, 'p2pkh'],
      [nested, 'p2sh_p2wpkh']
    ] as const) {
      const preparedFullMessage = expectSuccess(
        await execute<PreparedSigningValue>(popup, 'signing.prepare', {
          kind: 'bitcoin-bip322-message',
          chainId: BITCOIN_MAINNET,
          addressType,
          accountIndex: 0,
          change: false,
          addressIndex: 0,
          message: bitcoinMessage
        })
      )
      expect(preparedFullMessage.summary).toMatchObject({
        schema: 'bitcoin.bip322-message.v1',
        fields: { address: account.identity.value }
      })
      const signedFullMessage = expectSuccess(
        await execute<SignatureValue>(popup, 'signing.confirm', {
          signingCommandId: preparedFullMessage.commandId
        })
      )
      expect(signedFullMessage.signature.value).toMatch(/^ful/)
      expect(
        expectSuccess(
          await execute<VerificationValue>(
            popup,
            'signing.verify',
            {
              kind: 'bitcoin-bip322-message',
              chainId: BITCOIN_MAINNET,
              address: account.identity.value,
              message: bitcoinMessage,
              signature: signedFullMessage.signature.value
            },
            { kind: 'unbound' }
          )
        )
      ).toEqual({ verified: true })
    }

    const preparedPsbt = expectSuccess(
      await execute<PreparedSigningValue>(popup, 'signing.prepare', {
        kind: 'bitcoin-psbt',
        chainId: BITCOIN_MAINNET,
        addressType: 'p2wpkh',
        accountIndex: 0,
        psbt: BIP84_PSBT
      })
    )
    expect(preparedPsbt.summary).toMatchObject({
      schema: 'bitcoin.psbt.v1',
      fields: { feeSats: '1000', signingInputIndexes: [0] }
    })
    const signedPsbt = expectSuccess(
      await execute<SignedPayloadValue>(popup, 'signing.confirm', {
        signingCommandId: preparedPsbt.commandId
      })
    )
    expect(signedPsbt).toMatchObject({
      kind: 'signed-payload',
      payload: { encoding: 'base64' }
    })
    expect(signedPsbt.payload.value).not.toBe(BIP84_PSBT)
    const consumedPsbt = await execute(popup, 'signing.confirm', {
      signingCommandId: preparedPsbt.commandId
    })
    expect(consumedPsbt).toMatchObject({
      ok: false,
      error: { code: 'SIGNING_COMMAND_NOT_FOUND' }
    })

    const bitcoinChainId = parseChainId(BITCOIN_MAINNET).id
    for (const [addressType, source, change, recipient, transactionByte] of [
      ['p2wpkh', bitcoin, bitcoinChange, taproot, 'aa'],
      ['p2tr', taproot, taprootChange, bitcoin, 'bb']
    ] as const) {
      const selection = selectBitcoinCoins({
        chainId: bitcoinChainId,
        accountIndex: 0,
        addressType,
        recipient: recipient.identity.value,
        amount: { mode: 'exact', valueSats: '50000' },
        feeRateSatsPerVbyte: 2,
        utxos: [
          {
            chainId: bitcoinChainId,
            addressType,
            accountIndex: 0,
            change: false,
            addressIndex: 0,
            address: source.identity.value,
            derivationPath: source.derivation.path,
            publicKey: source.publicKey,
            transactionId: transactionByte.repeat(32),
            outputIndex: 0,
            valueSats: '100000',
            blockHeight: 899_999
          }
        ]
      })
      const prepared = buildBitcoinPsbt({
        selection,
        masterFingerprint: requireBitcoinMasterFingerprint(source),
        lockTime: 900_000,
        change: {
          address: {
            chainId: bitcoinChainId,
            addressType,
            accountIndex: 0,
            change: true,
            addressIndex: 0,
            address: change.identity.value,
            addressScheme: addressType === 'p2wpkh' ? 'bitcoin-p2wpkh' : 'bitcoin-p2tr',
            derivationScheme: addressType === 'p2wpkh' ? 'bip84' : 'bip86',
            derivationPath: change.derivation.path,
            publicKey: change.publicKey,
            masterFingerprint: requireBitcoinMasterFingerprint(change)
          },
          outputPosition: addressType === 'p2wpkh' ? 'first' : 'last'
        }
      })
      const preparedBuiltPsbt = expectSuccess(
        await execute<PreparedSigningValue>(popup, 'signing.prepare', {
          kind: 'bitcoin-psbt',
          chainId: BITCOIN_MAINNET,
          addressType,
          accountIndex: 0,
          psbt: prepared.psbtBase64
        })
      )
      expect(preparedBuiltPsbt.summary).toMatchObject({
        schema: 'bitcoin.psbt.v1',
        fields: { feeSats: prepared.feeSats, signingInputIndexes: [0] }
      })
      expect(() =>
        assertBitcoinSigningSummaryMatchesPrepared(
          prepared,
          preparedBuiltPsbt.summary,
          source.identity.value
        )
      ).not.toThrow()
      const signedBuiltPsbt = expectSuccess(
        await execute<SignedPayloadValue>(popup, 'signing.confirm', {
          signingCommandId: preparedBuiltPsbt.commandId
        })
      )
      const finalized = finalizeBitcoinPsbt({
        prepared,
        signedPsbtBase64: signedBuiltPsbt.payload.value
      })
      expect(finalized).toMatchObject({
        transactionId: prepared.unsignedTransactionId,
        feeSats: prepared.feeSats
      })
      expect(finalized.rawTransactionHex).toMatch(/^[0-9a-f]+$/)
      expect(finalized.vbytes).toBeLessThanOrEqual(prepared.estimatedVbytes)
    }

    for (const [addressType, rawAddressType, source, change, transactionByte] of [
      ['p2pkh', 'p2pkh', legacy, legacyChange, 'dd'],
      ['p2sh-p2wpkh', 'p2sh_p2wpkh', nested, nestedChange, 'ee']
    ] as const) {
      if (!source.scriptPubKey || !change.scriptPubKey) {
        throw new Error('Legacy Bitcoin derivation is missing scriptPubKey')
      }
      if (addressType === 'p2sh-p2wpkh' && (!source.redeemScript || !change.redeemScript)) {
        throw new Error('Nested SegWit derivation is missing redeemScript')
      }
      let transactionId = transactionByte.repeat(32)
      let previousTransactions:
        | readonly {
            readonly transactionId: string
            readonly rawTransactionHex: string
          }[]
        | undefined
      if (addressType === 'p2pkh') {
        const funding = new Transaction()
        funding.version = 2
        funding.addInput(Buffer.alloc(32), 0xffffffff)
        funding.setWitness(0, [Buffer.alloc(71, 1), Buffer.alloc(33, 2)])
        funding.addOutput(address.toOutputScript(source.identity.value, networks.bitcoin), 100_000)
        transactionId = funding.getId()
        previousTransactions = Object.freeze([
          Object.freeze({ transactionId, rawTransactionHex: funding.toHex() })
        ])
      }
      const selection = selectBitcoinCoins({
        chainId: bitcoinChainId,
        accountIndex: 0,
        addressType,
        recipient: bitcoin.identity.value,
        amount: { mode: 'exact', valueSats: '50000' },
        feeRateSatsPerVbyte: 2,
        utxos: [
          {
            chainId: bitcoinChainId,
            addressType,
            accountIndex: 0,
            change: false,
            addressIndex: 0,
            address: source.identity.value,
            derivationPath: source.derivation.path,
            publicKey: source.publicKey,
            transactionId,
            outputIndex: 0,
            valueSats: '100000',
            blockHeight: 899_999
          }
        ]
      })
      const prepared = buildBitcoinPsbt({
        selection,
        masterFingerprint: requireBitcoinMasterFingerprint(source),
        lockTime: 900_000,
        ...(previousTransactions === undefined ? {} : { previousTransactions }),
        change: {
          address: {
            chainId: bitcoinChainId,
            addressType,
            accountIndex: 0,
            change: true,
            addressIndex: 0,
            address: change.identity.value,
            addressScheme: addressType === 'p2pkh' ? 'bitcoin-p2pkh' : 'bitcoin-p2sh-p2wpkh',
            derivationScheme: addressType === 'p2pkh' ? 'bip44' : 'bip49',
            derivationPath: change.derivation.path,
            publicKey: change.publicKey,
            masterFingerprint: requireBitcoinMasterFingerprint(change),
            scriptPubKey: change.scriptPubKey,
            ...(change.redeemScript === undefined ? {} : { redeemScript: change.redeemScript })
          },
          outputPosition: 'last'
        }
      })
      const preparedSigning = expectSuccess(
        await execute<PreparedSigningValue>(popup, 'signing.prepare', {
          kind: 'bitcoin-psbt',
          chainId: BITCOIN_MAINNET,
          addressType: rawAddressType,
          accountIndex: 0,
          psbt: prepared.psbtBase64
        })
      )
      expect(preparedSigning.summary).toMatchObject({
        schema: 'bitcoin.psbt.v1',
        fields: { feeSats: prepared.feeSats, signingInputIndexes: [0] }
      })
      const signed = expectSuccess(
        await execute<SignedPayloadValue>(popup, 'signing.confirm', {
          signingCommandId: preparedSigning.commandId
        })
      )
      const finalized = finalizeBitcoinPsbt({
        prepared,
        signedPsbtBase64: signed.payload.value
      })
      expect(finalized).toMatchObject({ feeSats: prepared.feeSats })
      expect(finalized.transactionId).toMatch(/^[0-9a-f]{64}$/)
    }

    const bitcoinTestnetChainId = parseChainId(BITCOIN_TESTNET).id
    const testnetSelection = selectBitcoinCoins({
      chainId: bitcoinTestnetChainId,
      accountIndex: 0,
      addressType: 'p2wpkh',
      recipient: bitcoinTestnetRecipient.identity.value,
      amount: { mode: 'exact', valueSats: '50000' },
      feeRateSatsPerVbyte: 2,
      utxos: [
        {
          chainId: bitcoinTestnetChainId,
          addressType: 'p2wpkh',
          accountIndex: 0,
          change: false,
          addressIndex: 0,
          address: bitcoinTestnet.identity.value,
          derivationPath: bitcoinTestnet.derivation.path,
          publicKey: bitcoinTestnet.publicKey,
          transactionId: 'cc'.repeat(32),
          outputIndex: 0,
          valueSats: '100000',
          blockHeight: 1_999_999
        }
      ]
    })
    const preparedTestnetPsbt = buildBitcoinPsbt({
      selection: testnetSelection,
      masterFingerprint: requireBitcoinMasterFingerprint(bitcoinTestnet),
      lockTime: 2_000_000,
      change: {
        address: {
          chainId: bitcoinTestnetChainId,
          addressType: 'p2wpkh',
          accountIndex: 0,
          change: true,
          addressIndex: 0,
          address: bitcoinTestnetChange.identity.value,
          addressScheme: 'bitcoin-p2wpkh',
          derivationScheme: 'bip84',
          derivationPath: bitcoinTestnetChange.derivation.path,
          publicKey: bitcoinTestnetChange.publicKey,
          masterFingerprint: requireBitcoinMasterFingerprint(bitcoinTestnetChange)
        },
        outputPosition: 'first'
      }
    })
    const preparedTestnetSigning = expectSuccess(
      await execute<PreparedSigningValue>(popup, 'signing.prepare', {
        kind: 'bitcoin-psbt',
        chainId: BITCOIN_TESTNET,
        addressType: 'p2wpkh',
        accountIndex: 0,
        psbt: preparedTestnetPsbt.psbtBase64
      })
    )
    expect(preparedTestnetSigning.summary).toMatchObject({
      schema: 'bitcoin.psbt.v1',
      fields: { feeSats: preparedTestnetPsbt.feeSats, signingInputIndexes: [0] }
    })
    const signedTestnetPsbt = expectSuccess(
      await execute<SignedPayloadValue>(popup, 'signing.confirm', {
        signingCommandId: preparedTestnetSigning.commandId
      })
    )
    const finalizedTestnet = finalizeBitcoinPsbt({
      prepared: preparedTestnetPsbt,
      signedPsbtBase64: signedTestnetPsbt.payload.value
    })
    expect(finalizedTestnet).toMatchObject({
      transactionId: preparedTestnetPsbt.unsignedTransactionId,
      feeSats: preparedTestnetPsbt.feeSats
    })
    expect(finalizedTestnet.rawTransactionHex).toMatch(/^[0-9a-f]+$/)

    const restart = await popup.evaluate(() =>
      chrome.runtime.sendMessage({
        type: 'WORKER_RPC',
        method: 'multichain.conformance-restart',
        payload: {}
      })
    )
    expect(restart).toEqual({ result: true })
    const deriveAfterRestart = await execute(popup, 'account.derive-public', {
      family: 'evm',
      chainId: 'eip155:1',
      addressIndex: 0
    })
    expect(deriveAfterRestart).toMatchObject({
      ok: false,
      error: { code: 'CREDENTIAL_LOCKED' }
    })
    expectSuccess(await execute(popup, 'credential.unlock', { vault, password: PASSWORD }))

    await expect(
      popup.evaluate(() => chrome.runtime.sendMessage({ type: 'WALLET_LOCKED' }))
    ).resolves.toEqual({ success: true })
    const deriveAfterGlobalLock = await execute(popup, 'account.derive-public', {
      family: 'evm',
      chainId: 'eip155:1',
      addressIndex: 0
    })
    expect(deriveAfterGlobalLock).toMatchObject({
      ok: false,
      error: { code: 'CREDENTIAL_LOCKED' }
    })
    expectSuccess(await execute(popup, 'credential.unlock', { vault, password: PASSWORD }))

    await popup.evaluate(async password => {
      const toBase64 = (value: ArrayBuffer | Uint8Array) => {
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
        return btoa(String.fromCharCode(...bytes))
      }
      const keyMaterial = crypto.getRandomValues(new Uint8Array(32))
      const key = await crypto.subtle.importKey('raw', keyMaterial, 'AES-GCM', false, ['encrypt'])
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        new TextEncoder().encode(password)
      )
      await chrome.storage.session.set({
        session_key_material: [...keyMaterial],
        session_password: { encrypted: toBase64(encrypted), iv: toBase64(iv) }
      })
      await chrome.storage.local.set({
        wallet_settings: JSON.stringify({ state: { autoLockMs: 60_000 }, version: 0 })
      })
      await chrome.storage.local.set({ last_activity_time: Date.now() - 60_001 })
    }, PASSWORD)
    await expect
      .poll(() =>
        popup.evaluate(
          async () => (await chrome.storage.session.get('session_password')).session_password
        )
      )
      .toBeUndefined()
    const deriveAfterAutoLock = await execute(popup, 'account.derive-public', {
      family: 'evm',
      chainId: 'eip155:1',
      addressIndex: 0
    })
    expect(deriveAfterAutoLock).toMatchObject({
      ok: false,
      error: { code: 'CREDENTIAL_LOCKED' }
    })
    expectSuccess(await execute(popup, 'credential.unlock', { vault, password: PASSWORD }))

    const exportedMnemonicEvm = expectSuccess(
      await execute<ExportedPrivateKeyValue>(popup, 'credential.export-private-key', {
        vault,
        password: PASSWORD,
        chainId: 'eip155:1',
        addressIndex: 0
      })
    )
    expect(exportedMnemonicEvm).toMatchObject({
      chainId: 'eip155:1',
      format: 'hex',
      privateKey: expect.stringMatching(/^0x[0-9a-f]{64}$/)
    })
    expect(exportedMnemonicEvm.privateKey).toBe(exportedMnemonicEvm.hex)
    const exportedMnemonicBitcoin = expectSuccess(
      await execute<ExportedPrivateKeyValue>(popup, 'credential.export-private-key', {
        vault,
        password: PASSWORD,
        chainId: BITCOIN_MAINNET,
        addressType: 'p2wpkh',
        accountIndex: 0,
        change: false,
        addressIndex: 0
      })
    )
    expect(exportedMnemonicBitcoin).toMatchObject({
      chainId: BITCOIN_MAINNET,
      format: 'wif',
      privateKey: expect.stringMatching(/^[KL][1-9A-HJ-NP-Za-km-z]{51}$/),
      hex: expect.stringMatching(/^0x[0-9a-f]{64}$/)
    })

    expectSuccess(await execute(popup, 'credential.lock', {}))
    const lockedDerive = await execute(popup, 'account.derive-public', {
      family: 'evm',
      chainId: 'eip155:1',
      addressIndex: 0
    })
    expect(lockedDerive).toMatchObject({ ok: false, error: { code: 'CREDENTIAL_LOCKED' } })
  })
})
