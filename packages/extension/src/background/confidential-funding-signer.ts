import type { ChainId } from '@/core/chains/domain'
import { supportsEvmConfidentialShield } from '@/core/chains/evm'
import type { ConfidentialSignedPayload } from '@/core/services/confidential-funding'
import { secp256k1 } from '@noble/curves/secp256k1'
import { hashMessage, hexToBytes, toHex, type Hex } from 'viem'
import { publicKeyToAddress } from 'viem/accounts'
import { parseEvmAccountBinding, type ActiveEvmPortfolioContext } from '@/infrastructure/chains/evm'
import {
  assertEvmSigningSummaryMatchesPrepared,
  assertSignedEvmTransactionMatchesPrepared,
  createEvmSigningSummary,
  createEvmSigningPreparePayload,
  createKeystoneSignedEvmTransaction,
  parsePreparedEvmTransfer,
  serializePreparedEvmUnsignedTransaction,
  type PreparedEvmTransfer
} from '@/infrastructure/chains/evm'
import { parseSigningCommandId } from '@/core/keyring/ports'
import { EvmMultichainSigningClient } from '@/infrastructure/keyring/multichain/evm-signing-client'
import type { HardwareEvmSigningContextResolver } from '@/infrastructure/keyring/hardware-evm-signing-context'
import type { LedgerEvmSigningRequest, LedgerEvmSigningResponse } from '@/lib/ledger/evm'
import { digestLedgerPayload, ledgerEvmPersonalSummary } from './ledger-evm-dapp-review'
import type { LedgerSigningBinding } from './ledger-signing-coordinator'

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return ''
  const digits = [0]
  for (const byte of bytes) {
    let carry = byte
    for (let index = 0; index < digits.length; index += 1) {
      carry += digits[index] << 8
      digits[index] = carry % 58
      carry = Math.floor(carry / 58)
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = Math.floor(carry / 58)
    }
  }
  let output = ''
  for (let index = 0; index < bytes.length - 1 && bytes[index] === 0; index += 1) output += '1'
  for (let index = digits.length - 1; index >= 0; index -= 1)
    output += BASE58_ALPHABET[digits[index]]
  return output
}

function parseSignature(value: string): Uint8Array {
  const hex = value.replace(/^0x/, '')
  if (!/^[0-9a-fA-F]{130}$/.test(hex)) throw new Error('Confidential ERC-191 signature is invalid')
  const bytes = Uint8Array.from(hex.match(/.{2}/g) ?? [], byte => Number.parseInt(byte, 16))
  if (bytes[64] === 27 || bytes[64] === 28) bytes[64] -= 27
  if (bytes[64] !== 0 && bytes[64] !== 1) {
    throw new Error('Confidential ERC-191 signature recovery byte is invalid')
  }
  return bytes
}

function encodeSignature(bytes: Uint8Array): string {
  return `secp256k1:${encodeBase58(bytes)}`
}

export interface ConfidentialSigningIdentity {
  readonly context: ActiveEvmPortfolioContext
  readonly address: string
  readonly addressIndex: number
  readonly peaAddress?: string
}

export function requireConfidentialPea(identity: ConfidentialSigningIdentity): string {
  if (!identity.peaAddress) throw new Error('Incognito is unavailable for this account')
  return identity.peaAddress
}

type ShieldDeviceRequest = Extract<
  LedgerEvmSigningRequest,
  { kind: 'personal-sign' | 'transaction' }
>

export interface ConfidentialHardwareMessageReview {
  readonly purpose: NonNullable<LedgerSigningBinding['purpose']>
  readonly validate: () => Promise<void>
}

type DeviceSigner = Readonly<{
  resolve: HardwareEvmSigningContextResolver['resolve']
  request: (
    vendor: 'ledger' | 'keystone',
    request: ShieldDeviceRequest,
    binding: LedgerSigningBinding,
    masterFingerprintHex?: string
  ) => Promise<LedgerEvmSigningResponse>
}>

type HardwareDepositReview = Readonly<{
  identity: ConfidentialSigningIdentity
  serialized: string
  payloadFingerprint: string
  expiresAt: number
}>

export class ConfidentialFundingSigner {
  private readonly hardwareDeposits = new Map<string, HardwareDepositReview>()

  constructor(
    private readonly signer: EvmMultichainSigningClient,
    private readonly loadContext: (chainId: ChainId) => Promise<ActiveEvmPortfolioContext | null>,
    private readonly runActiveOperation: <T>(
      operation: () => Promise<T>
    ) => Promise<T> = operation => operation(),
    private readonly device?: DeviceSigner
  ) {}

  private async assertCurrentIdentity(
    identity: ConfidentialSigningIdentity,
    chainId: ChainId
  ): Promise<void> {
    const current = await this.resolveIdentity(chainId)
    if (
      current.context.chainAccount.scope.keyDomainId !==
        identity.context.chainAccount.scope.keyDomainId ||
      current.context.chainAccount.scope.accountId !==
        identity.context.chainAccount.scope.accountId ||
      current.address !== identity.address ||
      current.peaAddress?.toLowerCase() !== identity.peaAddress?.toLowerCase() ||
      current.addressIndex !== identity.addressIndex ||
      (chainId === identity.context.chainAccount.scope.chainId &&
        (current.context.chainAccount.id !== identity.context.chainAccount.id ||
          current.context.chainAccount.derivation.path !==
            identity.context.chainAccount.derivation.path)) ||
      (identity.context.keyDomainSource.kind === 'hardware' &&
        (current.context.generationId !== identity.context.generationId ||
          current.context.keyDomainSource.kind !== 'hardware' ||
          current.context.keyDomainSource.vendor !== identity.context.keyDomainSource.vendor))
    )
      throw new Error('Active Wallet Account changed before confidential signing')
  }

  async resolveIdentity(chainId: ChainId): Promise<ConfidentialSigningIdentity> {
    const context = await this.loadContext(chainId)
    if (!context || !supportsEvmConfidentialShield(context.keyDomainSource)) {
      throw new Error('Confidential funding requires a supported active EVM Account')
    }
    const binding = parseEvmAccountBinding(context.chainAccount, chainId)
    if (context.keyDomainSource.kind === 'hardware') {
      if (!this.device) throw new Error('Confidential hardware signing is unavailable')
      return Object.freeze({
        context,
        address: binding.address.toLowerCase(),
        addressIndex: binding.addressIndex
      })
    }
    const pea = await this.signer.deriveGlobalPea(
      context.chainAccount.scope.keyDomainId,
      binding.addressIndex
    )
    if (pea.address.toLowerCase() === binding.address.toLowerCase()) {
      throw new Error('Confidential address must be distinct from the Main address')
    }
    return Object.freeze({
      context,
      address: binding.address.toLowerCase(),
      addressIndex: binding.addressIndex,
      peaAddress: pea.address
    })
  }

  async signMessage(input: {
    readonly identity: ConfidentialSigningIdentity
    readonly chainId: ChainId
    readonly payload: string
    readonly expiresAt?: number
    readonly hardwareReview?: ConfidentialHardwareMessageReview
  }): Promise<ConfidentialSignedPayload> {
    if (input.identity.context.keyDomainSource.kind === 'hardware') {
      const signature = await this.signHardwarePersonalMessage(input)
      return Object.freeze({
        standard: 'erc191',
        payload: input.payload,
        signature: encodeSignature(signature)
      })
    }
    return this.runActiveOperation(async () => {
      await this.assertCurrentIdentity(input.identity, input.chainId)
      const prepared = await this.signer.prepare(
        input.identity.context.chainAccount.scope.keyDomainId,
        {
          kind: 'evm-personal-message',
          chainId: input.chainId,
          addressIndex: input.identity.addressIndex,
          message: new TextEncoder().encode(input.payload)
        }
      )
      let consumed = false
      try {
        if (
          prepared.execution.kind !== 'internal' ||
          prepared.operation !== 'message' ||
          prepared.expiresAt <= Date.now() ||
          prepared.summary.review.level === 'blocked'
        ) {
          throw new Error('Confidential signing request cannot be approved')
        }
        const result = await this.signer.confirm(
          input.identity.context.chainAccount.scope.keyDomainId,
          prepared.commandId
        )
        consumed = true
        if (
          result.kind !== 'signature' ||
          result.signature.encoding !== 'hex' ||
          result.address?.toLowerCase() !== input.identity.address
        ) {
          throw new Error('Confidential signature does not match the Main account')
        }
        return Object.freeze({
          standard: 'erc191' as const,
          payload: input.payload,
          signature: encodeSignature(parseSignature(result.signature.value))
        })
      } finally {
        if (!consumed) {
          await this.signer
            .cancel(input.identity.context.chainAccount.scope.keyDomainId, prepared.commandId)
            .catch(() => {})
        }
      }
    })
  }

  async prepareTransaction(input: {
    readonly identity: ConfidentialSigningIdentity
    readonly prepared: PreparedEvmTransfer
    readonly sourceDomain?: 'public' | 'private'
  }): Promise<
    Readonly<{
      commandId: string
      payloadFingerprint: string
      expiresAt: number
    }>
  > {
    return this.runActiveOperation(async () => {
      await this.assertCurrentIdentity(input.identity, input.prepared.chainId)
      const expectedAddress =
        input.sourceDomain === 'private'
          ? requireConfidentialPea(input.identity)
          : input.identity.address
      if (
        input.prepared.from.toLowerCase() !== expectedAddress.toLowerCase() ||
        input.prepared.addressIndex !== input.identity.addressIndex
      ) {
        throw new Error('Confidential funding deposit does not match the active Main account')
      }
      if (input.identity.context.keyDomainSource.kind === 'hardware') {
        const now = Date.now()
        for (const [commandId, review] of this.hardwareDeposits) {
          if (review.expiresAt <= now) this.hardwareDeposits.delete(commandId)
        }
        const commandId = `shield-device:${crypto.randomUUID()}`
        const serialized = serializePreparedEvmUnsignedTransaction(input.prepared)
        const payloadFingerprint = await digestLedgerPayload(hexToBytes(serialized as Hex))
        const expiresAt = now + 5 * 60_000
        this.hardwareDeposits.set(
          commandId,
          Object.freeze({
            identity: input.identity,
            serialized,
            payloadFingerprint,
            expiresAt
          })
        )
        return Object.freeze({ commandId, payloadFingerprint, expiresAt })
      }
      const prepared = await this.signer.prepare(
        input.identity.context.chainAccount.scope.keyDomainId,
        createEvmSigningPreparePayload(
          input.prepared,
          input.sourceDomain === 'private' ? 'private' : 'main'
        )
      )
      try {
        await assertEvmSigningSummaryMatchesPrepared(input.prepared, prepared.summary)
        if (
          prepared.execution.kind !== 'internal' ||
          prepared.operation !== 'transaction' ||
          prepared.summary.review.level === 'blocked' ||
          prepared.expiresAt <= Date.now()
        ) {
          throw new Error('Confidential funding deposit cannot be approved')
        }
        return Object.freeze({
          commandId: prepared.commandId,
          payloadFingerprint: prepared.payloadFingerprint.digestHex,
          expiresAt: prepared.expiresAt
        })
      } catch (error) {
        await this.signer
          .cancel(input.identity.context.chainAccount.scope.keyDomainId, prepared.commandId)
          .catch(() => {})
        throw error
      }
    })
  }

  async confirmTransaction(input: {
    readonly identity: ConfidentialSigningIdentity
    readonly commandId: string
    readonly preparedTransfer: unknown
    readonly sourceDomain?: 'public' | 'private'
    readonly expiresAt?: number
  }): Promise<
    Readonly<{
      prepared: PreparedEvmTransfer
      rawTransaction: string
      transactionHash: string
    }>
  > {
    if (input.identity.context.keyDomainSource.kind === 'hardware') {
      const prepared = parsePreparedEvmTransfer(input.preparedTransfer)
      const review = this.hardwareDeposits.get(input.commandId)
      if (
        !review ||
        review.expiresAt <= Date.now() ||
        input.sourceDomain === 'private' ||
        review.identity.context.chainAccount.scope.keyDomainId !==
          input.identity.context.chainAccount.scope.keyDomainId ||
        review.identity.context.chainAccount.scope.accountId !==
          input.identity.context.chainAccount.scope.accountId ||
        review.identity.context.generationId !== input.identity.context.generationId ||
        input.identity.address !== prepared.from.toLowerCase() ||
        input.identity.addressIndex !== prepared.addressIndex ||
        serializePreparedEvmUnsignedTransaction(prepared) !== review.serialized
      ) {
        throw new Error('Confidential hardware deposit review is unavailable or changed')
      }
      this.hardwareDeposits.delete(input.commandId)
      const signatureHex = await this.requestDeviceSignature(
        review.identity,
        prepared.chainId,
        { kind: 'transaction', unsignedTransactionHex: review.serialized },
        await createEvmSigningSummary(prepared),
        review.payloadFingerprint,
        Math.min(review.expiresAt, input.expiresAt ?? Infinity)
      )
      const signed = await createKeystoneSignedEvmTransaction(prepared, signatureHex)
      await this.assertCurrentIdentity(review.identity, prepared.chainId)
      return Object.freeze({ prepared, ...signed })
    }
    return this.runActiveOperation(async () => {
      const prepared = parsePreparedEvmTransfer(input.preparedTransfer)
      await this.assertCurrentIdentity(input.identity, prepared.chainId)
      const expectedAddress =
        input.sourceDomain === 'private'
          ? requireConfidentialPea(input.identity)
          : input.identity.address
      if (
        prepared.from.toLowerCase() !== expectedAddress.toLowerCase() ||
        prepared.addressIndex !== input.identity.addressIndex
      ) {
        throw new Error('Confidential funding deposit does not match the active Main account')
      }
      const result = await this.signer.confirm(
        input.identity.context.chainAccount.scope.keyDomainId,
        parseSigningCommandId(input.commandId)
      )
      if (
        result.kind !== 'signed-payload' ||
        result.payload.encoding !== 'hex' ||
        !result.transactionId
      ) {
        throw new Error('Confidential funding deposit signature is invalid')
      }
      await assertSignedEvmTransactionMatchesPrepared(prepared, {
        rawTransaction: result.payload.value,
        transactionHash: result.transactionId
      })
      return Object.freeze({
        prepared,
        rawTransaction: result.payload.value,
        transactionHash: result.transactionId
      })
    })
  }

  async signHardwarePersonalMessage(input: {
    readonly identity: ConfidentialSigningIdentity
    readonly chainId: ChainId
    readonly payload: string
    readonly expiresAt?: number
    readonly hardwareReview?: ConfidentialHardwareMessageReview
  }): Promise<Uint8Array> {
    const bytes = new TextEncoder().encode(input.payload)
    const messageHex = toHex(bytes)
    const signatureHex = await this.requestDeviceSignature(
      input.identity,
      input.chainId,
      { kind: 'personal-sign', messageHex },
      await ledgerEvmPersonalSummary(input.chainId, input.identity.address, bytes),
      await digestLedgerPayload(bytes),
      Math.min(input.expiresAt ?? Infinity, Date.now() + 5 * 60_000),
      input.hardwareReview
    )
    const signature = parseSignature(signatureHex)
    const messageHash = hashMessage({ raw: messageHex })
    const publicKey = secp256k1.Signature.fromCompact(signature.subarray(0, 64))
      .addRecoveryBit(signature[64])
      .recoverPublicKey(messageHash.slice(2))
      .toHex(false)
    if (publicKeyToAddress(`0x${publicKey}`).toLowerCase() !== input.identity.address) {
      throw new Error('Confidential signature does not match the active EVM account')
    }
    await this.assertCurrentIdentity(input.identity, input.chainId)
    return signature
  }

  private async requestDeviceSignature(
    identity: ConfidentialSigningIdentity,
    chainId: ChainId,
    request:
      | Pick<Extract<ShieldDeviceRequest, { kind: 'personal-sign' }>, 'kind' | 'messageHex'>
      | Pick<
          Extract<ShieldDeviceRequest, { kind: 'transaction' }>,
          'kind' | 'unsignedTransactionHex'
        >,
    summary: LedgerSigningBinding['summary'],
    digestHex: string,
    expiresAt: number,
    review?: ConfidentialHardwareMessageReview
  ): Promise<string> {
    const device = this.device
    const source = identity.context.keyDomainSource
    if (!device || source.kind !== 'hardware') throw new Error('Confidential device is unavailable')
    const loadBinding = async () => {
      await review?.validate()
      return this.runActiveOperation(async () => {
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
          throw new Error('Confidential hardware signing request expired')
        }
        await this.assertCurrentIdentity(identity, chainId)
        const binding = await device.resolve(identity.context.chainAccount)
        if (binding.address.toLowerCase() !== identity.address) {
          throw new Error('Confidential device does not match the active EVM account')
        }
        return binding
      })
    }
    const binding = await loadBinding()
    const fingerprint = 'masterFingerprintHex' in binding ? binding.masterFingerprintHex : undefined
    const validate = async () => {
      const current = await loadBinding()
      if (
        current.derivationPath !== binding.derivationPath ||
        current.address !== binding.address ||
        ('masterFingerprintHex' in current ? current.masterFingerprintHex : undefined) !==
          fingerprint
      ) {
        throw new Error('Confidential device binding changed')
      }
    }
    const signed = await device.request(
      source.vendor === 'ledger' ? 'ledger' : 'keystone',
      { ...request, derivationPath: binding.derivationPath, expectedAddress: binding.address },
      {
        scope: identity.context.chainAccount.scope,
        payloadFingerprint: { algorithm: 'sha256', digestHex },
        expiresAt,
        summary,
        ...(review && { purpose: review.purpose }),
        validate
      },
      fingerprint
    )
    await validate()
    return signed.signatureHex
  }

  async cancelTransaction(input: {
    readonly identity: ConfidentialSigningIdentity
    readonly commandId: string
  }): Promise<void> {
    if (input.identity.context.keyDomainSource.kind === 'hardware') {
      const review = this.hardwareDeposits.get(input.commandId)
      if (
        review?.identity.context.chainAccount.scope.keyDomainId ===
          input.identity.context.chainAccount.scope.keyDomainId &&
        review?.identity.context.chainAccount.scope.accountId ===
          input.identity.context.chainAccount.scope.accountId
      ) {
        this.hardwareDeposits.delete(input.commandId)
      }
      return
    }
    await this.runActiveOperation(async () => {
      await this.assertCurrentIdentity(
        input.identity,
        input.identity.context.chainAccount.scope.chainId
      )
      await this.signer.cancel(
        input.identity.context.chainAccount.scope.keyDomainId,
        parseSigningCommandId(input.commandId)
      )
    })
  }
}
