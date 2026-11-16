import {
  GetAppAndVersionCommand,
  isSuccessCommandResult,
  type DeviceManagementKit,
  type DeviceSessionId,
  type GetAppAndVersionResponse
} from '@ledgerhq/device-management-kit'
import { SignerSolanaBuilder } from '@ledgerhq/device-signer-kit-solana'
import { ed25519 } from '@noble/curves/ed25519'
import { base64ToBytes, bytesToBase64 } from '@/lib/bytes'
import { validateLedgerSolanaDerivationPath } from '@/core/wallet/ledger-derivation-path'
import type {
  LedgerSolanaSigningRequest,
  LedgerSolanaSigningResponse
} from '@/core/keyring/protocol/ledger-signing'
import {
  encodeSolanaBase58,
  parseBase58Bytes
} from '@/infrastructure/chains/solana/solana-rpc-codecs'
import { parseSolanaTransactionEnvelope } from '@/infrastructure/chains/solana/solana-transaction-codec'
import {
  getLedgerDeviceName,
  runLedgerAction,
  type LedgerSessionOptions,
  withLedgerSession
} from './device'

export interface LedgerSolanaAccountExport {
  readonly path: string
  readonly publicKey: string
  readonly address: string
  readonly deviceModel: string
  readonly deviceName: string
  readonly appVersion: string
}

export type {
  LedgerSolanaSigningRequest,
  LedgerSolanaSigningResponse
} from '@/core/keyring/protocol/ledger-signing'

export type LedgerSolanaDeviceOptions = LedgerSessionOptions

function normalizePath(path: string): string {
  const normalized = path.startsWith('m/') ? path : `m/${path}`
  return validateLedgerSolanaDerivationPath(normalized)
}

function readShortVector(bytes: Uint8Array, cursor: { offset: number }): number {
  let value = 0
  let shift = 0
  for (let index = 0; index < 3; index += 1) {
    const byte = bytes[cursor.offset++]
    if (byte === undefined) throw new Error('Truncated Solana signature vector')
    value |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return value
    shift += 7
  }
  throw new Error('Invalid Solana signature vector')
}

interface SolanaSigningFrame {
  readonly transaction: Uint8Array
  readonly message: Uint8Array
  readonly signerKeys: readonly Uint8Array[]
  readonly signatureOffset: number
  readonly signatureCount: number
}

function parseSigningFrame(transactionBase64: string): SolanaSigningFrame {
  const envelope = parseSolanaTransactionEnvelope(transactionBase64)
  const transaction = base64ToBytes(transactionBase64)
  const cursor = { offset: 0 }
  const signatureCount = readShortVector(transaction, cursor)
  const signatureOffset = cursor.offset
  const messageOffset = signatureOffset + signatureCount * 64
  if (signatureCount === 0 || signatureCount > 255 || messageOffset >= transaction.byteLength) {
    throw new Error('Invalid Solana transaction signatures')
  }
  const message = transaction.subarray(messageOffset)
  if (bytesToBase64(message) !== envelope.messageBase64) {
    throw new Error('Solana transaction message changed during decoding')
  }
  const headerOffset = envelope.messageVersion === 'v0' ? 1 : 0
  const requiredSignatures = message[headerOffset]
  if (requiredSignatures !== signatureCount) {
    throw new Error('Solana transaction signature count does not match its message')
  }
  const accountsCursor = { offset: headerOffset + 3 }
  const accountCount = readShortVector(message, accountsCursor)
  if (
    accountCount < signatureCount ||
    accountsCursor.offset + accountCount * 32 > message.byteLength
  ) {
    throw new Error('Invalid Solana transaction account keys')
  }
  const signerKeys = Array.from({ length: signatureCount }, (_, index) =>
    message.subarray(accountsCursor.offset + index * 32, accountsCursor.offset + (index + 1) * 32)
  )
  return { transaction, message, signerKeys, signatureOffset, signatureCount }
}

async function assertSolanaApp(
  dmk: DeviceManagementKit,
  sessionId: DeviceSessionId,
  signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted()
  const app = await dmk.sendCommand<GetAppAndVersionResponse, void, void>({
    sessionId,
    command: new GetAppAndVersionCommand()
  })
  signal?.throwIfAborted()
  if (!isSuccessCommandResult(app) || app.data.name !== 'Solana') {
    throw new Error('Unable to verify the Ledger Solana app')
  }
  return app.data.version
}

export async function exportLedgerSolanaAccount(
  path: string,
  options: LedgerSolanaDeviceOptions
): Promise<LedgerSolanaAccountExport> {
  const normalizedPath = normalizePath(path)
  return withLedgerSession(options, async ({ dmk, sessionId, device }) => {
    const signer = new SignerSolanaBuilder({ dmk, sessionId }).build()
    const address = await runLedgerAction(
      signer.getAddress(normalizedPath, { checkOnDevice: true }),
      options.onInteraction,
      'Export Solana account',
      options.signal
    )
    const appVersion = await assertSolanaApp(dmk, sessionId, options.signal)
    const publicKey = parseBase58Bytes(address, 32, 'Ledger Solana public key')
    return Object.freeze({
      path: normalizedPath,
      publicKey,
      address: publicKey,
      deviceModel: device.deviceModel.model,
      deviceName: getLedgerDeviceName(device.deviceModel.model, device.name),
      appVersion
    })
  })
}

export async function exportLedgerSolanaAccounts(
  paths: readonly string[],
  options: LedgerSolanaDeviceOptions
): Promise<readonly LedgerSolanaAccountExport[]> {
  const normalizedPaths = paths.map(normalizePath)
  if (normalizedPaths.length === 0) return []
  return withLedgerSession(options, async ({ dmk, sessionId, device }) => {
    const signer = new SignerSolanaBuilder({ dmk, sessionId }).build()
    const results: LedgerSolanaAccountExport[] = []
    let appVersion: string | undefined
    for (const path of normalizedPaths) {
      options.signal?.throwIfAborted()
      const address = await runLedgerAction(
        signer.getAddress(path, { checkOnDevice: false }),
        options.onInteraction,
        'Export Solana account',
        options.signal
      )
      if (appVersion === undefined) {
        appVersion = await assertSolanaApp(dmk, sessionId, options.signal)
      }
      const publicKey = parseBase58Bytes(address, 32, 'Ledger Solana public key')
      results.push(
        Object.freeze({
          path,
          publicKey,
          address: publicKey,
          deviceModel: device.deviceModel.model,
          deviceName: getLedgerDeviceName(device.deviceModel.model, device.name),
          appVersion
        })
      )
    }
    return results
  })
}

export async function signLedgerSolanaRequest(
  request: LedgerSolanaSigningRequest,
  options: LedgerSolanaDeviceOptions
): Promise<LedgerSolanaSigningResponse> {
  if (!/^solana:[1-9A-HJ-NP-Za-km-z]{32}$/.test(request.chainId)) {
    throw new Error('Unsupported Ledger Solana chain')
  }
  const path = normalizePath(request.path)
  const expectedPublicKey = parseBase58Bytes(
    request.expectedPublicKey,
    32,
    'Expected Solana public key'
  )
  const frame = parseSigningFrame(request.transactionBase64)
  const signerIndex = frame.signerKeys.findIndex(
    key => encodeSolanaBase58(key) === expectedPublicKey
  )
  if (signerIndex < 0)
    throw new Error('Solana transaction does not require the registered Ledger key')
  for (let index = 0; index < frame.signatureCount; index += 1) {
    const original = frame.transaction.subarray(
      frame.signatureOffset + index * 64,
      frame.signatureOffset + (index + 1) * 64
    )
    if (
      index !== signerIndex &&
      original.some(byte => byte !== 0) &&
      !ed25519.verify(original, frame.message, frame.signerKeys[index], { zip215: false })
    ) {
      throw new Error('Solana co-signer signature does not match the transaction')
    }
  }
  return withLedgerSession(options, async ({ dmk, sessionId }) => {
    const signer = new SignerSolanaBuilder({ dmk, sessionId }).build()
    const address = await runLedgerAction(
      signer.getAddress(path),
      options.onInteraction,
      'Verify Solana account',
      options.signal
    )
    await assertSolanaApp(dmk, sessionId, options.signal)
    if (address !== expectedPublicKey) {
      throw new Error('Ledger Solana public key does not match the registered account')
    }
    const signature = await runLedgerAction(
      signer.signTransaction(path, frame.transaction, { delayed: false }),
      options.onInteraction,
      'Sign Solana transaction',
      options.signal
    )
    if (
      signature.byteLength !== 64 ||
      !ed25519.verify(signature, frame.message, frame.signerKeys[signerIndex], { zip215: false })
    ) {
      throw new Error('Ledger Solana signature does not match the original transaction')
    }
    const signed = new Uint8Array(frame.transaction)
    signed.set(signature, frame.signatureOffset + signerIndex * 64)
    return Object.freeze({
      kind: 'solana-transaction' as const,
      signedTransactionBase64: bytesToBase64(signed),
      publicKey: expectedPublicKey,
      signature: encodeSolanaBase58(signature)
    })
  })
}
