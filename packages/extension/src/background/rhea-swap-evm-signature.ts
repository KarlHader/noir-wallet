import type { RheaSwapService } from '@/core/services/rhea-swap'
import type {
  RheaSwapEvmSignatureReview,
  RheaSwapSignedOrderResult
} from '@/core/services/rhea-swap'
import { parseAccountId } from '@/core/accounts/domain'
import { parseChainId } from '@/core/chains/registry'
import { parseKeyDomainId } from '@/core/keyring/domain'
import {
  createRheaSwapSignedOrderGraph,
  parseRheaSwapTransactionBinding,
  parseTransactionId,
  parseTransactionSegmentId,
  type RheaSwapTransactionBinding,
  type TransactionAccountScope
} from '@/core/transactions/domain'
import {
  loadActiveEvmPortfolioContext,
  type ActiveEvmPortfolioContext
} from '@/infrastructure/chains/evm'
import { parseEvmAccountBinding } from '@/infrastructure/chains/evm/evm-account'
import type { EvmMultichainSigningClient } from '@/infrastructure/keyring/multichain/evm-signing-client'
import { parseSigningCommandId, type SigningCommandId } from '@/core/keyring/ports'
import { verifyTypedData, type Hex } from 'viem'
import type { LedgerEvmSigningRequest, LedgerEvmSigningResponse } from '@/lib/ledger/evm'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { HardwareEvmSigningContextResolver } from '@/infrastructure/keyring/hardware-evm-signing-context'
import { IndexedDbCredentialRepository } from '@/infrastructure/persistence/repositories'
import { credentialSession } from './credential-session'
import { digestLedgerPayload, ledgerEvmTypedDataSummary } from './ledger-evm-dapp-review'
import { requestLedgerSignature, type LedgerSigningBinding } from './ledger-signing-coordinator'
import type { TransactionRepository } from '@/ports/repositories'
import {
  IndexedDbStorageV2Repository,
  IndexedDbTransactionRepository
} from '@/infrastructure/persistence/repositories'
import { RHEA_SWAP_TRANSACTION_MONITOR_ALARM } from './rhea-swap-transaction-monitor'

type PendingSignature = Readonly<{
  schemaVersion: 1
  quoteHandle: string
  executionId: string
  chainId: string
  sender: string
  executionMode: 'main' | 'private'
  scope: TransactionAccountScope
  commandId: SigningCommandId
  payloadFingerprint: string
  expiresAt: number
  signingScheme: string | null
  graphSuffix: string
  graphCreatedAt: number
  binding: RheaSwapTransactionBinding
  ledger?: Readonly<{
    generationId: string
    chainAccountId: string
    derivationPath: string
    publicKey: string
    typedDataJson: string
  }>
  signature?: string
}>

export interface RheaSwapSignaturePendingStore {
  readonly get: (quoteHandle: string) => Promise<PendingSignature | null>
  readonly list: () => Promise<readonly PendingSignature[]>
  readonly put: (value: PendingSignature) => Promise<void>
  readonly delete: (quoteHandle: string) => Promise<void>
}

function readString(value: unknown, label: string, maximum = 512): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  ) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function parsePending(value: unknown): PendingSignature {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stored RHEA Swap signature is invalid')
  }
  const record = value as Record<string, unknown>
  const required = [
    'schemaVersion',
    'quoteHandle',
    'executionId',
    'chainId',
    'sender',
    'scope',
    'commandId',
    'payloadFingerprint',
    'expiresAt',
    'signingScheme',
    'graphSuffix',
    'graphCreatedAt',
    'binding'
  ]
  const allowed = new Set([...required, 'executionMode', 'ledger', 'signature'])
  if (
    record.schemaVersion !== 1 ||
    required.some(key => !Object.prototype.hasOwnProperty.call(record, key)) ||
    Object.keys(record).some(key => !allowed.has(key)) ||
    !record.scope ||
    typeof record.scope !== 'object' ||
    Array.isArray(record.scope) ||
    !Number.isSafeInteger(record.expiresAt) ||
    (record.expiresAt as number) <= 0 ||
    !Number.isSafeInteger(record.graphCreatedAt) ||
    (record.graphCreatedAt as number) < 0
  ) {
    throw new Error('Stored RHEA Swap signature fields are invalid')
  }
  const scopeRecord = record.scope as Record<string, unknown>
  if (
    Object.keys(scopeRecord).length !== 2 ||
    !Object.prototype.hasOwnProperty.call(scopeRecord, 'keyDomainId') ||
    !Object.prototype.hasOwnProperty.call(scopeRecord, 'accountId')
  ) {
    throw new Error('Stored RHEA Swap signature scope is invalid')
  }
  const payloadFingerprint = readString(
    record.payloadFingerprint,
    'Stored RHEA Swap fingerprint',
    64
  )
  if (!/^[0-9a-f]{64}$/.test(payloadFingerprint)) {
    throw new Error('Stored RHEA Swap fingerprint is invalid')
  }
  const signature =
    record.signature === undefined
      ? undefined
      : readString(record.signature, 'Stored RHEA Swap signature', 1024)
  if (signature !== undefined && !/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw new Error('Stored RHEA Swap signature is invalid')
  }
  const signingScheme =
    record.signingScheme === null
      ? null
      : readString(record.signingScheme, 'Stored RHEA Swap signing scheme', 64)
  const chainId = parseChainId(readString(record.chainId, 'Stored RHEA Swap chain', 64)).id
  const sender = readString(record.sender, 'Stored RHEA Swap sender', 42)
  const executionMode = record.executionMode ?? 'main'
  if (!chainId.startsWith('eip155:') || !/^0x[0-9a-fA-F]{40}$/.test(sender)) {
    throw new Error('Stored RHEA Swap signature account is invalid')
  }
  if (executionMode !== 'main' && executionMode !== 'private') {
    throw new Error('Stored RHEA Swap execution mode is invalid')
  }
  let ledger: PendingSignature['ledger']
  if (record.ledger !== undefined) {
    const value = record.ledger
    if (
      executionMode !== 'main' ||
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !==
        'chainAccountId,derivationPath,generationId,publicKey,typedDataJson'
    ) {
      throw new Error('Stored RHEA Swap Ledger approval is invalid')
    }
    const fields = value as Record<string, unknown>
    ledger = Object.freeze({
      generationId: readString(fields.generationId, 'Stored RHEA Swap generation', 160),
      chainAccountId: readString(fields.chainAccountId, 'Stored RHEA Swap ChainAccount', 160),
      derivationPath: readString(fields.derivationPath, 'Stored RHEA Swap Ledger path', 128),
      publicKey: readString(fields.publicKey, 'Stored RHEA Swap Ledger public key', 132),
      typedDataJson: readString(fields.typedDataJson, 'Stored RHEA Swap typed data', 256 * 1024)
    })
  }
  return Object.freeze({
    schemaVersion: 1,
    quoteHandle: readString(record.quoteHandle, 'Stored RHEA Swap quote handle', 160),
    executionId: readString(record.executionId, 'Stored RHEA Swap execution ID', 160),
    chainId,
    sender,
    executionMode,
    scope: Object.freeze({
      keyDomainId: parseKeyDomainId(scopeRecord.keyDomainId),
      accountId: parseAccountId(scopeRecord.accountId)
    }),
    commandId: parseSigningCommandId(
      readString(record.commandId, 'Stored RHEA Swap signing command', 128)
    ),
    payloadFingerprint,
    expiresAt: record.expiresAt as number,
    signingScheme,
    graphSuffix: readString(record.graphSuffix, 'Stored RHEA Swap graph suffix', 80),
    graphCreatedAt: record.graphCreatedAt as number,
    binding: parseRheaSwapTransactionBinding(record.binding),
    ...(ledger === undefined ? {} : { ledger }),
    ...(signature === undefined ? {} : { signature })
  })
}

export class ChromeSessionRheaSwapSignatureStore implements RheaSwapSignaturePendingStore {
  async get(quoteHandle: string): Promise<PendingSignature | null> {
    const key = this.key(quoteHandle)
    const value = (await chrome.storage.session.get(key))[key]
    return value === undefined ? null : parsePending(value)
  }

  async put(value: PendingSignature): Promise<void> {
    const parsed = parsePending(value)
    await chrome.storage.session.set({ [this.key(parsed.quoteHandle)]: parsed })
  }

  async list(): Promise<readonly PendingSignature[]> {
    const stored = await chrome.storage.session.get(null)
    return Object.entries(stored)
      .filter(([key]) => key.startsWith('rhea_swap_signature:'))
      .map(([, value]) => parsePending(value))
  }

  async delete(quoteHandle: string): Promise<void> {
    await chrome.storage.session.remove(this.key(quoteHandle))
  }

  private key(quoteHandle: string): string {
    return `rhea_swap_signature:${encodeURIComponent(readString(quoteHandle, 'RHEA Swap quote handle', 160))}`
  }
}

export interface RheaSwapEvmSignatureCoordinatorOptions {
  readonly service: Pick<
    RheaSwapService,
    'readEvmSignaturePlan' | 'submitSignedOrder' | 'reportSubmission' | 'discard'
  >
  readonly signer: Pick<
    EvmMultichainSigningClient,
    'deriveGlobalPea' | 'prepare' | 'confirm' | 'cancel'
  >
  readonly pending: RheaSwapSignaturePendingStore
  readonly repository: Pick<TransactionRepository, 'create'>
  readonly loadContext: (chainId: string) => Promise<ActiveEvmPortfolioContext | null>
  readonly scheduleMonitoring: () => Promise<void>
  readonly ledger?: {
    readonly resolveAccount: (context: ActiveEvmPortfolioContext) => Promise<{
      readonly derivationPath: string
      readonly publicKey: string
      readonly address: string
    }>
    readonly requestSignature: (
      request: LedgerEvmSigningRequest,
      binding: LedgerSigningBinding
    ) => Promise<LedgerEvmSigningResponse>
  }
  readonly now?: () => number
  readonly createId?: () => string
}

export class RheaSwapEvmSignatureCoordinator {
  private readonly now: () => number
  private readonly createId: () => string
  private readonly preparing = new Set<string>()
  private readonly confirming = new Set<string>()

  constructor(private readonly options: RheaSwapEvmSignatureCoordinatorOptions) {
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? (() => crypto.randomUUID())
  }

  async prepare(
    quoteHandle: string,
    bindingValue: unknown,
    executionModeValue: unknown = 'main'
  ): Promise<RheaSwapEvmSignatureReview> {
    if (this.preparing.has(quoteHandle)) throw new Error('RHEA Swap signature is already preparing')
    this.preparing.add(quoteHandle)
    try {
      return await this.prepareOnce(quoteHandle, bindingValue, executionModeValue)
    } finally {
      this.preparing.delete(quoteHandle)
    }
  }

  private async prepareOnce(
    quoteHandle: string,
    bindingValue: unknown,
    executionModeValue: unknown
  ): Promise<RheaSwapEvmSignatureReview> {
    if (executionModeValue !== 'main' && executionModeValue !== 'private') {
      throw new Error('RHEA Swap execution mode is invalid')
    }
    const plan = await this.options.service.readEvmSignaturePlan(quoteHandle)
    const binding = parseRheaSwapTransactionBinding(bindingValue)
    this.assertBinding(plan, binding)
    const chainId = parseChainId(`eip155:${plan.chainId}`).id
    const active = await this.options.loadContext(chainId)
    if (active?.keyDomainSource.kind === 'hardware') {
      if (active.keyDomainSource.vendor !== 'ledger' || executionModeValue !== 'main') {
        throw new Error('RHEA Swap signature is unavailable for this hardware Wallet')
      }
      if (DEFAULT_NETWORK !== 'mainnet' || !this.options.ledger) {
        throw new Error('Ledger RHEA Swap signing is available on Mainnet only')
      }
      const account = await this.loadLedgerContext(chainId, plan.sender)
      this.assertLedgerSigningScheme(plan.signingScheme)
      const typedData = this.parseLedgerTypedData(plan.typedDataJson, plan.chainId)
      const summary = ledgerEvmTypedDataSummary(chainId, account.binding.address, typedData)
      const payloadFingerprint = await digestLedgerPayload(
        new TextEncoder().encode(plan.typedDataJson)
      )
      const expiresAt = Math.min(this.now() + 10 * 60_000, binding.expiresAt)
      if (expiresAt <= this.now()) throw new Error('RHEA Swap signature review is expired')
      if (await this.options.pending.get(quoteHandle)) {
        throw new Error('RHEA Swap signature review is already pending')
      }
      const pending = parsePending({
        schemaVersion: 1,
        quoteHandle: plan.quoteHandle,
        executionId: plan.executionId,
        chainId,
        sender: plan.sender,
        executionMode: 'main',
        scope: {
          keyDomainId: account.context.chainAccount.scope.keyDomainId,
          accountId: account.context.chainAccount.scope.accountId
        },
        commandId: parseSigningCommandId(`ledger:${crypto.randomUUID()}`),
        payloadFingerprint,
        expiresAt,
        signingScheme: plan.signingScheme,
        graphSuffix: this.createId(),
        graphCreatedAt: this.now(),
        binding,
        ledger: {
          generationId: account.context.generationId,
          chainAccountId: account.context.chainAccount.id,
          derivationPath: account.binding.derivationPath,
          publicKey: account.binding.publicKey,
          typedDataJson: plan.typedDataJson
        }
      })
      await this.options.pending.put(pending)
      return Object.freeze({
        quoteHandle: plan.quoteHandle,
        executionId: plan.executionId,
        chainId,
        sender: plan.sender,
        summary,
        payloadFingerprint,
        expiresAt
      })
    }
    const { context, addressIndex } = await this.loadSoftwareContext(
      chainId,
      plan.sender,
      executionModeValue
    )
    const prepared = await this.options.signer.prepare(context.chainAccount.scope.keyDomainId, {
      kind: executionModeValue === 'private' ? 'pea-evm-typed-data' : 'evm-typed-data',
      chainId,
      addressIndex,
      typedDataJson: plan.typedDataJson
    })
    if (prepared.execution.kind !== 'internal') {
      await this.options.signer
        .cancel(context.chainAccount.scope.keyDomainId, prepared.commandId)
        .catch(() => {})
      throw new Error('RHEA Swap signature requires a software Wallet')
    }
    const pending = parsePending({
      schemaVersion: 1,
      quoteHandle: plan.quoteHandle,
      executionId: plan.executionId,
      chainId,
      sender: plan.sender,
      executionMode: executionModeValue,
      scope: {
        keyDomainId: context.chainAccount.scope.keyDomainId,
        accountId: context.chainAccount.scope.accountId
      },
      commandId: prepared.commandId,
      payloadFingerprint: prepared.payloadFingerprint.digestHex,
      expiresAt: Math.min(prepared.expiresAt, binding.expiresAt),
      signingScheme: plan.signingScheme,
      graphSuffix: this.createId(),
      graphCreatedAt: this.now(),
      binding
    })
    try {
      await this.options.pending.put(pending)
    } catch (error) {
      await this.options.signer
        .cancel(context.chainAccount.scope.keyDomainId, prepared.commandId)
        .catch(() => {})
      throw error
    }
    return Object.freeze({
      quoteHandle: plan.quoteHandle,
      executionId: plan.executionId,
      chainId,
      sender: plan.sender,
      summary: prepared.summary,
      payloadFingerprint: prepared.payloadFingerprint.digestHex,
      expiresAt: pending.expiresAt
    })
  }

  async confirm(quoteHandle: string, fingerprint: string): Promise<RheaSwapSignedOrderResult> {
    if (this.confirming.has(quoteHandle))
      throw new Error('RHEA Swap signature is already confirming')
    this.confirming.add(quoteHandle)
    try {
      return await this.confirmOnce(quoteHandle, fingerprint)
    } finally {
      this.confirming.delete(quoteHandle)
    }
  }

  private async confirmOnce(
    quoteHandle: string,
    fingerprint: string
  ): Promise<RheaSwapSignedOrderResult> {
    let pending = await this.requirePending(quoteHandle, fingerprint)
    const { context } = pending.ledger
      ? await this.assertLedgerPendingCurrent(pending, Boolean(pending.signature))
      : await this.loadSoftwareContext(pending.chainId, pending.sender, pending.executionMode)
    if (
      context.chainAccount.scope.keyDomainId !== pending.scope.keyDomainId ||
      context.chainAccount.scope.accountId !== pending.scope.accountId
    ) {
      throw new Error('The active Account changed before RHEA Swap signing')
    }
    let signature = pending.signature
    if (!signature) {
      const plan = await this.options.service.readEvmSignaturePlan(quoteHandle)
      this.assertBinding(plan, pending.binding)
      if (pending.ledger) {
        const ledger = pending.ledger
        const assertCurrent = async () => {
          const current = await this.requirePending(quoteHandle, fingerprint)
          if (current.commandId !== pending.commandId) {
            throw new Error('RHEA Swap signature review changed')
          }
          await this.assertLedgerPendingCurrent(current)
        }
        await assertCurrent()
        const typedData = this.parseLedgerTypedData(ledger.typedDataJson, plan.chainId)
        const signed = await this.options.ledger!.requestSignature(
          {
            kind: 'typed-data',
            derivationPath: ledger.derivationPath,
            expectedAddress: pending.sender,
            typedData
          },
          {
            scope: { ...pending.scope, chainId: pending.chainId },
            payloadFingerprint: { algorithm: 'sha256', digestHex: pending.payloadFingerprint },
            expiresAt: pending.expiresAt,
            summary: ledgerEvmTypedDataSummary(
              parseChainId(pending.chainId).id,
              pending.sender,
              typedData
            ),
            validate: assertCurrent
          }
        )
        if (
          !/^0x[0-9a-fA-F]{130}$/.test(signed.signatureHex) ||
          !(await verifyTypedData({
            ...typedData,
            address: pending.sender as Hex,
            signature: signed.signatureHex as Hex
          } as Parameters<typeof verifyTypedData>[0]))
        ) {
          throw new Error('Ledger RHEA Swap signature does not match the approved order')
        }
        await assertCurrent()
        signature = signed.signatureHex
      } else {
        const signed = await this.options.signer.confirm(
          pending.scope.keyDomainId,
          pending.commandId
        )
        if (
          signed.kind !== 'signature' ||
          signed.signature.encoding !== 'hex' ||
          signed.address?.toLowerCase() !== pending.sender.toLowerCase()
        ) {
          throw new Error('RHEA Swap signature does not match the active Account')
        }
        signature = signed.signature.value
      }
      pending = parsePending({ ...pending, signature })
      await this.options.pending.put(pending)
    }
    let submission: Awaited<ReturnType<RheaSwapService['submitSignedOrder']>>
    try {
      submission = await this.options.service.submitSignedOrder(
        quoteHandle,
        signature,
        pending.signingScheme ?? undefined
      )
    } catch (error) {
      await this.options.scheduleMonitoring().catch(() => {})
      throw error
    }
    if (!submission.orderId) throw new Error('RHEA Swap order submission has no order ID')
    const createdAt = pending.graphCreatedAt
    const suffix = pending.graphSuffix
    const graph = createRheaSwapSignedOrderGraph({
      transactionId: parseTransactionId(`tx:rhea-order:${suffix}`),
      scope: pending.scope,
      binding: pending.binding,
      orderId: submission.orderId,
      segmentIds: {
        origin: parseTransactionSegmentId(`segment:rhea-order:origin:${suffix}`),
        relay: parseTransactionSegmentId(`segment:rhea-order:relay:${suffix}`),
        destination: parseTransactionSegmentId(`segment:rhea-order:destination:${suffix}`),
        refund: parseTransactionSegmentId(`segment:rhea-order:refund:${suffix}`)
      },
      now: createdAt
    })
    const persisted = await this.options.repository.create(graph)
    if (persisted.status === 'id-conflict') {
      throw new Error('RHEA Swap order transaction ID conflicts with an existing record')
    }
    await this.options.scheduleMonitoring()
    await this.options.service.reportSubmission(quoteHandle).catch(() => {})
    await this.options.pending.delete(quoteHandle)
    return Object.freeze({ submission, graph: persisted.graph })
  }

  async recoverSigned(): Promise<number> {
    const pending = (await this.options.pending.list()).filter(value => value.signature)
    const results = await Promise.allSettled(
      pending.map(value => this.confirm(value.quoteHandle, value.payloadFingerprint))
    )
    return results.filter(result => result.status === 'fulfilled').length
  }

  async cancel(quoteHandle: string): Promise<void> {
    const pending = await this.options.pending.get(quoteHandle)
    if (!pending || pending.signature) return
    if (!pending.ledger)
      await this.options.signer.cancel(pending.scope.keyDomainId, pending.commandId).catch(() => {})
    await this.options.pending.delete(quoteHandle)
    await this.options.service.discard(quoteHandle).catch(() => {})
  }

  private async requirePending(
    quoteHandle: string,
    fingerprint: string
  ): Promise<PendingSignature> {
    const pending = await this.options.pending.get(quoteHandle)
    if (
      !pending ||
      pending.payloadFingerprint !== fingerprint ||
      !/^[0-9a-f]{64}$/.test(fingerprint) ||
      (pending.expiresAt <= this.now() && !pending.signature)
    ) {
      throw new Error('RHEA Swap signature review is unavailable or expired')
    }
    return pending
  }

  private assertBinding(
    plan: Awaited<ReturnType<RheaSwapService['readEvmSignaturePlan']>>,
    binding: RheaSwapTransactionBinding
  ): void {
    if (
      binding.quoteHandle !== plan.quoteHandle ||
      binding.executionId !== plan.executionId ||
      binding.origin.protocolChainId !== String(plan.chainId) ||
      binding.sender.toLowerCase() !== plan.sender.toLowerCase() ||
      binding.sourceTarget.toLowerCase() !== plan.sender.toLowerCase()
    ) {
      throw new Error('RHEA Swap signature binding does not match its build')
    }
  }

  private parseLedgerTypedData(value: string, chainId: number): Readonly<Record<string, unknown>> {
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch {
      throw new Error('RHEA Swap EIP-712 payload is invalid')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('RHEA Swap EIP-712 payload is invalid')
    }
    const typedData = parsed as Record<string, unknown>
    const domain = typedData.domain
    const domainChainId =
      domain && typeof domain === 'object' && !Array.isArray(domain)
        ? (domain as Record<string, unknown>).chainId
        : undefined
    if (
      !domain ||
      typeof domain !== 'object' ||
      Array.isArray(domain) ||
      (domainChainId !== undefined && String(domainChainId) !== String(chainId))
    ) {
      throw new Error('RHEA Swap EIP-712 chain does not match the quote')
    }
    return typedData
  }

  private assertLedgerSigningScheme(value: string | null): void {
    if (value !== null && !/^(?:eip712|eip-712|eth_signTypedData_v4)$/i.test(value)) {
      throw new Error('RHEA Swap Ledger signing scheme is unsupported')
    }
  }

  private async loadLedgerContext(chainId: string, sender: string) {
    const context = await this.options.loadContext(chainId)
    if (
      !context ||
      context.keyDomainSource.kind !== 'hardware' ||
      context.keyDomainSource.vendor !== 'ledger' ||
      context.chainAccount.scope.chainId !== chainId
    ) {
      throw new Error('RHEA Swap requires an active Ledger EVM Account')
    }
    const account = parseEvmAccountBinding(context.chainAccount, parseChainId(chainId).id)
    if (account.address.toLowerCase() !== sender.toLowerCase()) {
      throw new Error('RHEA Swap signature does not match the active Account')
    }
    const binding = await this.options.ledger!.resolveAccount(context)
    if (
      binding.address.toLowerCase() !== sender.toLowerCase() ||
      binding.derivationPath !== context.chainAccount.derivation.path
    ) {
      throw new Error('RHEA Swap Ledger account binding changed')
    }
    const current = await this.options.loadContext(chainId)
    if (
      current?.generationId !== context.generationId ||
      current.chainAccount.id !== context.chainAccount.id ||
      current.chainAccount.scope.accountId !== context.chainAccount.scope.accountId
    ) {
      throw new Error('RHEA Swap Ledger Account changed before signing')
    }
    return { context, binding }
  }

  private async assertLedgerPendingCurrent(pending: PendingSignature, allowExpired = false) {
    if (!pending.ledger || DEFAULT_NETWORK !== 'mainnet' || !this.options.ledger) {
      throw new Error('Ledger RHEA Swap signing is unavailable')
    }
    const { context, binding } = await this.loadLedgerContext(pending.chainId, pending.sender)
    if (
      context.generationId !== pending.ledger.generationId ||
      context.chainAccount.id !== pending.ledger.chainAccountId ||
      context.chainAccount.scope.keyDomainId !== pending.scope.keyDomainId ||
      context.chainAccount.scope.accountId !== pending.scope.accountId ||
      binding.derivationPath !== pending.ledger.derivationPath ||
      binding.publicKey !== pending.ledger.publicKey
    ) {
      throw new Error('RHEA Swap Ledger Account changed before signing')
    }
    const plan = await this.options.service.readEvmSignaturePlan(pending.quoteHandle, allowExpired)
    this.assertBinding(plan, pending.binding)
    this.assertLedgerSigningScheme(plan.signingScheme)
    if (
      plan.quoteHandle !== pending.quoteHandle ||
      plan.executionId !== pending.executionId ||
      parseChainId(`eip155:${plan.chainId}`).id !== pending.chainId ||
      plan.sender.toLowerCase() !== pending.sender.toLowerCase() ||
      plan.signingScheme !== pending.signingScheme ||
      plan.typedDataJson !== pending.ledger.typedDataJson ||
      (await digestLedgerPayload(new TextEncoder().encode(plan.typedDataJson))) !==
        pending.payloadFingerprint
    ) {
      throw new Error('RHEA Swap Ledger order changed before signing')
    }
    this.parseLedgerTypedData(plan.typedDataJson, plan.chainId)
    return { context, binding }
  }

  private async loadSoftwareContext(
    chainId: string,
    expectedAddress: string,
    executionMode: 'main' | 'private'
  ): Promise<{ context: ActiveEvmPortfolioContext; addressIndex: number }> {
    const context = await this.options.loadContext(chainId)
    if (!context || context.keyDomainSource.kind === 'hardware') {
      throw new Error('RHEA Swap signature requires an active software EVM Account')
    }
    const account = parseEvmAccountBinding(context.chainAccount, parseChainId(chainId).id)
    const executionAddress =
      executionMode === 'private'
        ? (
            await this.options.signer.deriveGlobalPea(
              context.chainAccount.scope.keyDomainId,
              account.addressIndex
            )
          ).address
        : account.address
    if (executionAddress.toLowerCase() !== expectedAddress.toLowerCase()) {
      throw new Error('RHEA Swap signature does not match the active Account')
    }
    return { context, addressIndex: account.addressIndex }
  }
}

export function createBackgroundRheaSwapEvmSignatureCoordinator(
  service: RheaSwapService,
  signer: EvmMultichainSigningClient
): RheaSwapEvmSignatureCoordinator {
  const storage = new IndexedDbStorageV2Repository()
  const resolver = new HardwareEvmSigningContextResolver({
    storageRepository: storage,
    credentialRepository: new IndexedDbCredentialRepository(),
    credentials: credentialSession,
    network: DEFAULT_NETWORK
  })
  return new RheaSwapEvmSignatureCoordinator({
    service,
    signer,
    pending: new ChromeSessionRheaSwapSignatureStore(),
    repository: new IndexedDbTransactionRepository(),
    loadContext: chainId => loadActiveEvmPortfolioContext(storage, chainId),
    ledger: {
      resolveAccount: async context => {
        const binding = await resolver.resolve(context.chainAccount)
        if (!('publicKey' in binding)) throw new Error('Active EVM Account is not a Ledger export')
        return binding
      },
      requestSignature: requestLedgerSignature
    },
    scheduleMonitoring: () =>
      chrome.alarms.create(RHEA_SWAP_TRANSACTION_MONITOR_ALARM, { delayInMinutes: 0.1 })
  })
}
