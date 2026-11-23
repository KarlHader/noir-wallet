import type { ChainId } from '@/core/chains/domain'
import { supportsEvmPrivateExecution } from '@/core/chains/evm'
import {
  parseNearAccountId,
  supportsNearPrivateExecution,
  type NearPrivateExecutionWalletSource
} from '@/core/chains/near'
import { parseChainId } from '@/core/chains/registry'
import type { KeyDomainSource } from '@/core/keyring/domain'
import type { ConfidentialSignedPayload } from '@/core/services/confidential-funding'
import { base64ToBytes } from '@/lib/bytes'
import { encodeNearFunctionArgs } from '@/infrastructure/chains/near/near-rpc-codecs'
import { parseEvmAccountBinding, type ActiveEvmPortfolioContext } from '@/infrastructure/chains/evm'
import type { NearMultichainSigningClient } from '@/infrastructure/keyring/multichain/near-signing-client'
import type {
  NearCommitBroadcastRpc,
  NearReadRpc
} from '@/infrastructure/chains/near/near-rpc-types'
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
const INTENTS_CONTRACT = 'intents.near'
const ADD_PUBLIC_KEY_GAS = '30000000000000'

export interface ConfidentialNearSigningContext extends ActiveEvmPortfolioContext {
  readonly accountIndex: number
  readonly publicKey: string
}

export interface ConfidentialNearChain {
  readonly client: Pick<
    NearMultichainSigningClient,
    'deriveNearPea' | 'prepare' | 'confirm' | 'cancel'
  >
  readonly rpc: Pick<
    NearReadRpc & NearCommitBroadcastRpc,
    'viewFunction' | 'getAccessKey' | 'broadcastSignedTransactionAndWait'
  >
  readonly chainId: ChainId
  loadContext(chainId: ChainId): Promise<ConfidentialNearSigningContext | null>
}

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

export type ConfidentialAuthIdentityKind = 'evm' | 'near'

export interface ConfidentialSigningIdentity {
  readonly kind: ConfidentialAuthIdentityKind
  readonly context: ActiveEvmPortfolioContext
  readonly address: string
  readonly addressIndex: number
  readonly peaAddress: string
}

export interface ConfidentialAuthSigner {
  readonly kind: 'evm'
  resolveIdentity(chainId: ChainId): Promise<ConfidentialSigningIdentity>
  signMessage(input: {
    readonly identity: ConfidentialSigningIdentity
    readonly chainId: ChainId
    readonly payload: string
  }): Promise<ConfidentialSignedPayload>
}

async function assertCurrentEvmIdentity(
  resolveIdentity: (chainId: ChainId) => Promise<ConfidentialSigningIdentity>,
  identity: ConfidentialSigningIdentity,
  chainId: ChainId
): Promise<void> {
  const current = await resolveIdentity(chainId)
  if (
    current.context.chainAccount.scope.keyDomainId !==
      identity.context.chainAccount.scope.keyDomainId ||
    current.context.chainAccount.scope.accountId !==
      identity.context.chainAccount.scope.accountId ||
    current.address !== identity.address ||
    current.peaAddress.toLowerCase() !== identity.peaAddress.toLowerCase() ||
    current.addressIndex !== identity.addressIndex
  )
    throw new Error('Active Wallet Account changed before confidential signing')
}

export class EvmConfidentialAuthSigner implements ConfidentialAuthSigner {
  readonly kind = 'evm' as const

  constructor(
    private readonly signer: EvmMultichainSigningClient,
    private readonly loadContext: (chainId: ChainId) => Promise<ActiveEvmPortfolioContext | null>,
    private readonly runActiveOperation: <T>(
      operation: () => Promise<T>
    ) => Promise<T> = operation => operation()
  ) {}

  private async assertCurrentIdentity(
    identity: ConfidentialSigningIdentity,
    chainId: ChainId
  ): Promise<void> {
    await assertCurrentEvmIdentity(chainId => this.resolveIdentity(chainId), identity, chainId)
  }

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
      kind: 'evm' as const,
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
          signature: normalizeSignature(result.signature.value)
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
}

export class ConfidentialFundingSigner implements ConfidentialAuthSigner {
  readonly kind = 'evm' as const
  private readonly evmAuth: EvmConfidentialAuthSigner

  constructor(
    private readonly signer: EvmMultichainSigningClient,
    loadContext: (chainId: ChainId) => Promise<ActiveEvmPortfolioContext | null>,
    private readonly runActiveOperation: <T>(
      operation: () => Promise<T>
    ) => Promise<T> = operation => operation(),
    private readonly nearChain: ConfidentialNearChain | null = null
  ) {
    this.evmAuth = new EvmConfidentialAuthSigner(signer, loadContext, runActiveOperation)
  }

  private async assertCurrentIdentity(
    identity: ConfidentialSigningIdentity,
    chainId: ChainId
  ): Promise<void> {
    await assertCurrentEvmIdentity(chainId => this.resolveIdentity(chainId), identity, chainId)
  }

  async resolveIdentity(chainId: ChainId): Promise<ConfidentialSigningIdentity> {
    if (parseChainId(chainId).namespace === 'near') return this.resolveNearIdentity(chainId)
    return this.evmAuth.resolveIdentity(chainId)
  }

  async signMessage(input: {
    readonly identity: ConfidentialSigningIdentity
    readonly chainId: ChainId
    readonly payload: string
  }): Promise<ConfidentialSignedPayload> {
    if (parseChainId(input.chainId).namespace === 'near') return this.signNearMessage(input)
    return this.evmAuth.signMessage(input)
  }

  private async resolveNearIdentity(chainId: ChainId): Promise<ConfidentialSigningIdentity> {
    const near = this.nearChain
    if (!near || near.chainId !== chainId) {
      throw new Error('Confidential NEAR signing chain is unavailable')
    }
    const context = await near.loadContext(chainId)
    if (!context || context.chainAccount.identity.kind !== 'account-identifier') {
      throw new Error('Confidential funding requires an active NEAR Account')
    }
    const address = parseNearAccountId(context.chainAccount.identity.value)
    const accountIndex = context.accountIndex
    if (!Number.isSafeInteger(accountIndex) || accountIndex < 0) {
      throw new Error('Confidential funding requires an active NEAR Account')
    }
    if (
      !supportsNearPrivateExecution(
        nearPrivateExecutionSource(context.keyDomainSource, accountIndex)
      )
    ) {
      throw new Error('NEAR private execution is unavailable')
    }
    const pea = await near.client.deriveNearPea(
      context.chainAccount.scope.keyDomainId,
      accountIndex
    )
    if (pea.address === address) {
      throw new Error('Confidential address must differ from the NEAR account')
    }
    return Object.freeze({
      kind: 'near' as const,
      context,
      address,
      addressIndex: accountIndex,
      peaAddress: pea.address
    })
  }

  private async signNearMessage(input: {
    readonly identity: ConfidentialSigningIdentity
    readonly chainId: ChainId
    readonly payload: string
  }): Promise<ConfidentialSignedPayload> {
    const near = this.nearChain
    if (!near) throw new Error('Confidential NEAR signing chain is unavailable')
    return this.runActiveOperation(async () => {
      const current = await this.resolveIdentity(input.chainId)
      if (
        current.kind !== 'near' ||
        current.context.chainAccount.scope.keyDomainId !==
          input.identity.context.chainAccount.scope.keyDomainId ||
        current.context.chainAccount.scope.accountId !==
          input.identity.context.chainAccount.scope.accountId ||
        !sameConfidentialAddress(current.address, input.identity.address) ||
        !sameConfidentialAddress(current.peaAddress, input.identity.peaAddress) ||
        current.addressIndex !== input.identity.addressIndex
      ) {
        throw new Error('Active Wallet Account changed before confidential signing')
      }
      const envelope = parseNep413SigningPayload(input.payload)
      const nonce = [...base64ToBytes(envelope.nonce)]
      if (nonce.length !== 32) throw new Error('NEAR confidential message nonce is invalid')
      const prepared = await near.client.prepare(
        input.identity.context.chainAccount.scope.keyDomainId,
        {
          kind: 'near-nep413-message',
          chainId: input.chainId,
          accountIndex: input.identity.addressIndex,
          request: Object.freeze({
            chainId: input.chainId,
            accountIndex: input.identity.addressIndex,
            accountId: input.identity.address,
            message: envelope.message,
            recipient: envelope.recipient,
            nonce,
            callbackUrl: null,
            state: null
          })
        }
      )
      let consumed = false
      try {
        if (prepared.operation !== 'message' || prepared.expiresAt <= Date.now()) {
          throw new Error('Confidential signing request cannot be approved')
        }
        const result = await near.client.confirm(
          input.identity.context.chainAccount.scope.keyDomainId,
          prepared.commandId
        )
        consumed = true
        if (
          result.kind !== 'signature' ||
          result.signature.encoding !== 'base64' ||
          result.address !== input.identity.address ||
          !result.publicKey
        ) {
          throw new Error('NEAR confidential signature payload is not a NEP-413 signature')
        }
        const signatureBytes = base64ToBytes(result.signature.value)
        if (signatureBytes.length !== 64) {
          throw new Error('NEAR confidential signature payload is not a NEP-413 signature')
        }
        const publicKey = result.publicKey.startsWith('ed25519:')
          ? result.publicKey
          : `ed25519:${result.publicKey}`
        await this.ensureNearIntentsPublicKey(input.identity, publicKey)
        return Object.freeze({
          standard: 'nep413' as const,
          payload: Object.freeze({
            recipient: envelope.recipient,
            nonce: envelope.nonce,
            message: envelope.message
          }),
          public_key: publicKey,
          signature: `ed25519:${encodeBase58(signatureBytes)}`
        })
      } finally {
        if (!consumed) {
          await near.client
            .cancel(input.identity.context.chainAccount.scope.keyDomainId, prepared.commandId)
            .catch(() => {})
        }
      }
    })
  }

  private async ensureNearIntentsPublicKey(
    identity: ConfidentialSigningIdentity,
    publicKey: string
  ): Promise<void> {
    // An implicit account's public key is the account id. Named accounts register once.
    if (/^[0-9a-f]{64}$/i.test(identity.address)) return
    const near = this.nearChain
    const context = identity.context
    if (!near || !('publicKey' in context) || typeof context.publicKey !== 'string') {
      throw new Error('Confidential NEAR signing chain is unavailable')
    }
    if (await this.nearHasPublicKey(identity.address, publicKey)) return
    const accessKey = await near.rpc.getAccessKey(identity.address, context.publicKey)
    if (!accessKey) {
      throw new Error('The derived NEAR access key is not registered on the sender account')
    }
    const nonce = BigInt(accessKey.nonce) + 1n
    const prepared = await near.client.prepare(identity.context.chainAccount.scope.keyDomainId, {
      kind: 'near-transaction',
      chainId: near.chainId,
      accountIndex: identity.addressIndex,
      transaction: {
        chainId: near.chainId,
        accountIndex: identity.addressIndex,
        signerId: identity.address,
        receiverId: INTENTS_CONTRACT,
        nonce: nonce.toString(),
        blockHash: accessKey.blockHash,
        actions: [
          {
            type: 'functionCall',
            methodName: 'add_public_key',
            args: encodeNearFunctionArgs({ public_key: publicKey }),
            gas: ADD_PUBLIC_KEY_GAS,
            depositYocto: '1'
          }
        ]
      }
    })
    let consumed = false
    try {
      const signed = await near.client.confirm(
        identity.context.chainAccount.scope.keyDomainId,
        prepared.commandId
      )
      consumed = true
      if (signed.kind !== 'signed-payload' || signed.payload.encoding !== 'base64') {
        throw new Error('NEAR add_public_key signature is invalid')
      }
      await near.rpc.broadcastSignedTransactionAndWait(signed.payload.value)
    } finally {
      if (!consumed) {
        await near.client
          .cancel(identity.context.chainAccount.scope.keyDomainId, prepared.commandId)
          .catch(() => {})
      }
    }
    if (!(await this.nearHasPublicKey(identity.address, publicKey))) {
      throw new Error('NEAR Intents public key was not registered')
    }
  }

  private async nearHasPublicKey(accountId: string, publicKey: string): Promise<boolean> {
    const near = this.nearChain
    if (!near) throw new Error('Confidential NEAR signing chain is unavailable')
    const value = await near.rpc.viewFunction(INTENTS_CONTRACT, 'has_public_key', {
      account_id: accountId,
      public_key: publicKey
    })
    if (typeof value !== 'boolean') {
      throw new Error('NEAR Intents public key query is invalid')
    }
    return value
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
        input.sourceDomain === 'private' ? input.identity.peaAddress : input.identity.address
      if (
        input.prepared.from.toLowerCase() !== expectedAddress.toLowerCase() ||
        input.prepared.addressIndex !== input.identity.addressIndex
      ) {
        throw new Error('Confidential funding deposit does not match the active Main account')
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
  }): Promise<
    Readonly<{
      prepared: PreparedEvmTransfer
      rawTransaction: string
      transactionHash: string
    }>
  > {
    return this.runActiveOperation(async () => {
      const prepared = parsePreparedEvmTransfer(input.preparedTransfer)
      await this.assertCurrentIdentity(input.identity, prepared.chainId)
      const expectedAddress =
        input.sourceDomain === 'private' ? input.identity.peaAddress : input.identity.address
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

  async cancelTransaction(input: {
    readonly identity: ConfidentialSigningIdentity
    readonly commandId: string
  }): Promise<void> {
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

function nearPrivateExecutionSource(
  source: KeyDomainSource,
  accountIndex: number
): NearPrivateExecutionWalletSource {
  if (source.kind === 'private-key') {
    return Object.freeze({
      kind: 'private-key',
      chainFamily: source.chainFamily,
      accountIndex
    })
  }
  if (source.kind === 'hardware') return Object.freeze({ kind: 'hardware' })
  return Object.freeze({ kind: 'software' })
}

function sameConfidentialAddress(left: string, right: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(left) && /^0x[0-9a-fA-F]{40}$/.test(right)
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

function parseNep413SigningPayload(payload: string): {
  message: string
  recipient: 'intents.near' | 'intents.far'
  nonce: string
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    parsed = null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('NEAR confidential message payload must include message, recipient, and nonce')
  }
  const record = parsed as Record<string, unknown>
  const recipient =
    record.recipient === 'intents.near' || record.recipient === 'intents.far'
      ? record.recipient
      : null
  if (typeof record.message !== 'string' || !recipient || typeof record.nonce !== 'string') {
    throw new Error('NEAR confidential message payload must include message, recipient, and nonce')
  }
  return { message: record.message, recipient, nonce: record.nonce }
}
