import type { ChainId } from '@/core/chains/domain'
import { supportsEvmPrivateExecution } from '@/core/chains/evm'
import type { ConfidentialSignedPayload } from '@/core/services/confidential-funding'
import { parseEvmAccountBinding, type ActiveEvmPortfolioContext } from '@/infrastructure/chains/evm'
import {
  assertEvmSigningSummaryMatchesPrepared,
  assertSignedEvmTransactionMatchesPrepared,
  createEvmSigningPreparePayload,
  parsePreparedEvmTransfer,
  type PreparedEvmTransfer
} from '@/infrastructure/chains/evm'
import { parseSigningCommandId } from '@/core/keyring/ports'
import { EvmMultichainSigningClient } from '@/infrastructure/keyring/multichain/evm-signing-client'

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

function normalizeSignature(value: string): string {
  const hex = value.replace(/^0x/, '')
  if (!/^[0-9a-fA-F]{130}$/.test(hex)) throw new Error('Confidential ERC-191 signature is invalid')
  const bytes = Uint8Array.from(hex.match(/.{2}/g) ?? [], byte => Number.parseInt(byte, 16))
  if (bytes[64] === 27 || bytes[64] === 28) bytes[64] -= 27
  if (bytes[64] !== 0 && bytes[64] !== 1) {
    throw new Error('Confidential ERC-191 signature recovery byte is invalid')
  }
  return `secp256k1:${encodeBase58(bytes)}`
}

export interface ConfidentialSigningIdentity {
  readonly context: ActiveEvmPortfolioContext
  readonly address: string
  readonly addressIndex: number
  readonly peaAddress: string
}

export class ConfidentialFundingSigner {
  constructor(
    private readonly signer: EvmMultichainSigningClient,
    private readonly loadContext: (chainId: ChainId) => Promise<ActiveEvmPortfolioContext | null>
  ) {}

  async resolveIdentity(chainId: ChainId): Promise<ConfidentialSigningIdentity> {
    const context = await this.loadContext(chainId)
    if (!context || !supportsEvmPrivateExecution(context.keyDomainSource)) {
      throw new Error('Confidential funding requires an active software EVM Account')
    }
    const binding = parseEvmAccountBinding(context.chainAccount, chainId)
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
  }): Promise<ConfidentialSignedPayload> {
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
        signature: normalizeSignature(result.signature.value)
      })
    } finally {
      if (!consumed) {
        await this.signer
          .cancel(input.identity.context.chainAccount.scope.keyDomainId, prepared.commandId)
          .catch(() => {})
      }
    }
  }

  async prepareTransaction(input: {
    readonly identity: ConfidentialSigningIdentity
    readonly prepared: PreparedEvmTransfer
  }): Promise<
    Readonly<{
      commandId: string
      payloadFingerprint: string
      expiresAt: number
    }>
  > {
    if (
      input.prepared.from.toLowerCase() !== input.identity.address ||
      input.prepared.addressIndex !== input.identity.addressIndex
    ) {
      throw new Error('Confidential funding deposit does not match the active Main account')
    }
    const prepared = await this.signer.prepare(
      input.identity.context.chainAccount.scope.keyDomainId,
      createEvmSigningPreparePayload(input.prepared, 'main')
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
  }

  async confirmTransaction(input: {
    readonly identity: ConfidentialSigningIdentity
    readonly commandId: string
    readonly preparedTransfer: unknown
  }): Promise<
    Readonly<{
      prepared: PreparedEvmTransfer
      rawTransaction: string
      transactionHash: string
    }>
  > {
    const prepared = parsePreparedEvmTransfer(input.preparedTransfer)
    if (
      prepared.from.toLowerCase() !== input.identity.address ||
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
  }

  async cancelTransaction(input: {
    readonly identity: ConfidentialSigningIdentity
    readonly commandId: string
  }): Promise<void> {
    await this.signer.cancel(
      input.identity.context.chainAccount.scope.keyDomainId,
      parseSigningCommandId(input.commandId)
    )
  }
}
