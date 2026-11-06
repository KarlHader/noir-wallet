import { parseAccountId } from '@/core/accounts/domain'
import { parseChainId } from '@/core/chains/registry'
import { parseKeyDomainId } from '@/core/keyring/domain'
import type {
  NoirPublicAccount,
  NoirPublicTransaction
} from '@/core/services/noir-protocol/public/types'
import {
  computePublicSubmissionId,
  readPublicAccountId,
  readPublicEvmAddress,
  readPublicIdentity,
  parsePublicCandidate,
  parsePublicFunctionCallRequests,
  serializePublicCandidate,
  type NoirPublicTxCandidate
} from '@/core/services/noir-protocol/public/protocol'
import { sha256 as hashSha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  parseNoirPublicActivationIntent,
  parseNoirPublicTransactionBinding,
  parseTransactionEventId,
  parseTransactionGraph,
  parseTransactionId,
  parseTransactionSegmentId,
  type NoirPublicActivationIntent,
  type NoirPublicTransactionBinding,
  type TransactionAccountScope,
  type TransactionGraph,
  type TransactionLifecycleStatus
} from '@/core/transactions/domain'
import type { TransactionRepository } from '@/ports/repositories'
import { TRANSACTION_REPOSITORY_LIMITS } from '@/infrastructure/persistence/repositories/transaction-repository-support'

type NoirPublicNetwork = 'mainnet' | 'testnet'

export interface NoirPublicTransactionRecord {
  readonly transaction: NoirPublicTransaction
  readonly graph: TransactionGraph
  readonly binding: NoirPublicTransactionBinding
  readonly candidate: NoirPublicTxCandidate
}

export interface NoirPublicActivationRecord {
  readonly graph: TransactionGraph
  readonly binding: NoirPublicTransactionBinding
}

interface NoirPublicRecordIdentity {
  readonly scope: TransactionAccountScope
  readonly network: NoirPublicNetwork
  readonly origin: string
  readonly requestId: string
  readonly accountAddress: string
  readonly parentContractId: string
  readonly identityPublicKey: string
  readonly identityChain?: 'evm'
  readonly now: number
}

export interface CreateNoirPublicActivationInput extends Omit<
  NoirPublicRecordIdentity,
  'accountAddress'
> {
  readonly activationId: string
  readonly paymentIntent: NoirPublicActivationIntent
  readonly preparedTransferGraph?: TransactionGraph
}

export interface CreateSignedNoirPublicTransactionInput extends NoirPublicRecordIdentity {
  readonly candidate: NoirPublicTxCandidate
  readonly originalTxRequests?: NoirPublicTxCandidate['tx_requests']
}

export interface NoirPublicTransactionObservation {
  readonly submission_id: string
  readonly tx_hash?: string
  readonly status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'PARTIALLY_SUCCEEDED'
  readonly failure_reason?: string
  readonly anchor?: { readonly txid_hex: string; readonly confirmed_height?: number }
  readonly verifiedExecution?: 'success' | 'failure'
}

async function sha256(value: string): Promise<string> {
  return bytesToHex(hashSha256(new TextEncoder().encode(value)))
}

export async function fingerprintPublicRequests(
  txRequests: NoirPublicTxCandidate['tx_requests']
): Promise<string> {
  return sha256(JSON.stringify(parsePublicFunctionCallRequests(txRequests)))
}

async function publicOperationId(
  kind: 'activation' | 'transaction',
  values: readonly string[]
): Promise<string> {
  return `tx:noir-public:${kind}:${await sha256(JSON.stringify(values))}`
}

function parseScope(scope: TransactionAccountScope): TransactionAccountScope {
  return Object.freeze({
    keyDomainId: parseKeyDomainId(scope.keyDomainId),
    accountId: parseAccountId(scope.accountId)
  })
}

function requirePublicBinding(graph: TransactionGraph): NoirPublicTransactionBinding {
  if (graph.root.intent?.protocol?.provider !== 'noir-public') {
    throw new Error('Transaction is not a Noir Public operation')
  }
  return parseNoirPublicTransactionBinding(graph.root.intent.protocol)
}

function projectPublicTransaction(graph: TransactionGraph): NoirPublicTransactionRecord {
  const binding = requirePublicBinding(graph)
  if (binding.kind !== 'contract-call' || !binding.signedRequest || !binding.submissionId) {
    throw new Error('Transaction is not a signed Noir Public operation')
  }
  const origin = graph.segments.find(segment => segment.role === 'origin')
  const anchor = graph.segments.find(segment => segment.role === 'destination')
  const status = graph.root.status
  if (
    status !== 'signed' &&
    status !== 'broadcast' &&
    status !== 'confirming' &&
    status !== 'final' &&
    status !== 'failed'
  ) {
    throw new Error('Invalid Noir Public transaction status')
  }
  return Object.freeze({
    transaction: Object.freeze({
      operationId: graph.root.id,
      requestId: binding.requestId,
      status,
      submissionId: binding.submissionId,
      ...(origin?.evidence?.transactionHash
        ? { transactionHash: origin.evidence.transactionHash }
        : {}),
      ...(anchor?.status !== 'created'
        ? {
            anchor: Object.freeze({
              status: anchor?.status ?? 'created',
              ...(anchor?.evidence?.transactionHash
                ? { transactionHash: anchor.evidence.transactionHash }
                : {})
            })
          }
        : {}),
      ...(graph.root.failure ? { error: graph.root.failure.code } : {})
    }),
    graph,
    binding,
    candidate: JSON.parse(binding.signedRequest) as NoirPublicTxCandidate
  })
}

function assertRecordContext(
  graph: TransactionGraph,
  network: NoirPublicNetwork,
  origin: string
): boolean {
  const binding = graph.root.intent?.protocol
  return (
    binding?.provider === 'noir-public' && binding.network === network && binding.origin === origin
  )
}

function createPublicGraph(
  input: NoirPublicRecordIdentity,
  operationId: string,
  binding: NoirPublicTransactionBinding,
  status: 'prepared' | 'signed',
  reference: string
): TransactionGraph {
  const chainId = parseChainId(`noir:${input.network}`).id
  const id = parseTransactionId(operationId)
  const originId = parseTransactionSegmentId(`${id}:origin`)
  const anchorId = parseTransactionSegmentId(`${id}:anchor`)
  return parseTransactionGraph({
    root: {
      id,
      scope: parseScope(input.scope),
      kind: 'contract-call',
      status,
      segmentIds: status === 'signed' ? [originId, anchorId] : [originId],
      createdAt: input.now,
      updatedAt: input.now,
      revision: 0,
      intent: {
        schemaVersion: 1,
        direction: 'contract',
        sender: { chainId, address: binding.accountAddress },
        recipient: {
          chainId,
          address:
            binding.kind === 'contract-call' ? binding.accountAddress : binding.parentContractId
        },
        protocol: binding
      }
    },
    segments: [
      {
        id: originId,
        transactionId: id,
        role: 'origin',
        target: { kind: 'protocol', provider: 'noir-public', account: binding.accountAddress },
        status,
        requiredForFinality: true,
        dependsOn: [],
        evidence: { externalReference: reference },
        createdAt: input.now,
        updatedAt: input.now,
        revision: 0
      },
      ...(status === 'signed'
        ? [
            {
              id: anchorId,
              transactionId: id,
              role: 'destination',
              target: { kind: 'onchain', chainId },
              status: 'created',
              requiredForFinality: false,
              dependsOn: [originId],
              createdAt: input.now,
              updatedAt: input.now,
              revision: 0
            }
          ]
        : [])
    ]
  })
}

export class NoirPublicTransactionRepository {
  constructor(private readonly repository: TransactionRepository) {}

  private async listEvmActivations(
    scope: TransactionAccountScope,
    network: NoirPublicNetwork,
    parentContractId: string,
    identityPublicKey: string
  ): Promise<readonly NoirPublicActivationRecord[]> {
    const graphs = await this.repository.list({
      scope,
      provider: 'noir-public',
      statuses: ['prepared', 'signed', 'broadcast', 'confirming', 'final', 'failed'],
      limit: TRANSACTION_REPOSITORY_LIMITS.recordsPerAccount
    })
    return graphs.flatMap(graph => {
      const binding = requirePublicBinding(graph)
      return binding.kind === 'public-activation' &&
        binding.identityChain === 'evm' &&
        binding.network === network &&
        binding.parentContractId === parentContractId &&
        binding.identityPublicKey === identityPublicKey
        ? [Object.freeze({ graph, binding })]
        : []
    })
  }

  async createPreparedActivation(
    input: CreateNoirPublicActivationInput
  ): Promise<NoirPublicActivationRecord> {
    const activationInput = { ...input, accountAddress: input.parentContractId }
    const paymentIntent = parseNoirPublicActivationIntent(input.paymentIntent)
    if (
      input.requestId !== input.activationId ||
      paymentIntent.recipient !== input.parentContractId ||
      (input.identityChain === 'evm'
        ? !paymentIntent.evmPayment ||
          paymentIntent.evmPayment.accountAddress !==
            readPublicIdentity(input.identityPublicKey, 'evm') ||
          paymentIntent.evmPayment.transactionId !== input.activationId ||
          paymentIntent.refundAddress !== readPublicIdentity(input.identityPublicKey, 'evm')
        : paymentIntent.evmPayment !== undefined)
    ) {
      throw new Error('Noir Public activation does not match its payment intent')
    }
    const scope = parseScope(input.scope)
    if (paymentIntent.evmPayment) {
      if (!input.preparedTransferGraph) {
        throw new Error('Noir Public EVM payment review graph is missing')
      }
      const transfer = parseTransactionGraph(input.preparedTransferGraph)
      if (
        transfer.root.id !== paymentIntent.evmPayment.transactionId ||
        transfer.root.scope.keyDomainId !== scope.keyDomainId ||
        transfer.root.scope.accountId !== scope.accountId ||
        transfer.root.kind !== 'transfer' ||
        transfer.root.status !== 'prepared' ||
        transfer.root.intent?.sender?.chainId !== paymentIntent.evmPayment.chainId ||
        readPublicEvmAddress(transfer.root.intent?.sender?.address) !==
          paymentIntent.evmPayment.accountAddress ||
        transfer.root.intent?.recipient?.chainId !== paymentIntent.evmPayment.chainId ||
        readPublicEvmAddress(transfer.root.intent?.recipient?.address) !==
          readPublicEvmAddress(paymentIntent.depositAddress) ||
        transfer.root.intent.primaryAmount?.assetId !== paymentIntent.evmPayment.assetId ||
        transfer.root.intent.primaryAmount?.amountRaw !== paymentIntent.amountInRaw
      )
        throw new Error('Noir Public EVM payment does not match the prepared transfer')
      const previous = await this.listEvmActivations(
        scope,
        input.network,
        input.parentContractId,
        paymentIntent.evmPayment.accountAddress
      )
      for (const record of previous) {
        if (
          record.graph.root.status !== 'failed' ||
          !['user-rejected', 'cancelled'].includes(record.graph.root.failure?.code ?? '') ||
          record.graph.segments.some(segment => segment.evidence?.transactionHash)
        )
          throw new Error('Noir Public activation already exists for this account')
        const previousPayment = record.binding.paymentIntent?.evmPayment
        if (!previousPayment) throw new Error('Noir Public EVM activation payment is missing')
        const durable = await this.repository.get(
          scope,
          parseTransactionId(previousPayment.transactionId)
        )
        if (
          durable &&
          (durable.root.status !== 'failed' ||
            durable.segments.some(segment => segment.evidence?.transactionHash))
        )
          throw new Error('Noir Public EVM payment may still execute')
      }
    }
    const operationId = await publicOperationId('activation', [
      scope.keyDomainId,
      scope.accountId,
      input.network,
      input.parentContractId,
      readPublicIdentity(input.identityPublicKey, input.identityChain ?? 'zcash'),
      ...(input.identityChain === 'evm' ? [input.activationId] : [])
    ])
    const binding = parseNoirPublicTransactionBinding({
      schemaVersion: 1,
      provider: 'noir-public',
      kind: 'public-activation',
      network: input.network,
      requestId: input.requestId,
      origin: input.origin,
      accountAddress: input.parentContractId,
      parentContractId: readPublicAccountId(input.parentContractId, 'Public parent contract'),
      identityPublicKey: readPublicIdentity(
        input.identityPublicKey,
        input.identityChain ?? 'zcash'
      ),
      ...(input.identityChain === 'evm' ? { identityChain: 'evm' as const } : {}),
      requestFingerprint: await sha256(JSON.stringify(paymentIntent)),
      activationId: input.activationId,
      paymentIntent
    })
    const graph = createPublicGraph(
      activationInput,
      operationId,
      binding,
      'prepared',
      input.activationId
    )
    const result = await this.repository.create(graph)
    if (result.status === 'id-conflict') {
      throw new Error('Noir Public activation already exists for this account')
    }
    return Object.freeze({ graph: result.graph, binding: requirePublicBinding(result.graph) })
  }

  async createSigned(
    input: CreateSignedNoirPublicTransactionInput
  ): Promise<NoirPublicTransactionRecord> {
    const candidate = parsePublicCandidate(input.candidate)
    const identityChain = 'EVM' in candidate.signer_wallet ? 'evm' : 'zcash'
    if (candidate.tgas === undefined) throw new Error('Cannot create a legacy Public submission')
    const originalTxRequests = input.originalTxRequests
      ? parsePublicFunctionCallRequests(input.originalTxRequests)
      : candidate.tx_requests.slice(1)
    if (
      originalTxRequests.length === 0 ||
      JSON.stringify(candidate.tx_requests.slice(1)) !== JSON.stringify(originalTxRequests)
    ) {
      throw new Error('Public signed requests do not match the original request')
    }
    const scope = parseScope(input.scope)
    const operationId = await publicOperationId('transaction', [
      scope.keyDomainId,
      scope.accountId,
      input.network,
      input.origin,
      input.requestId,
      ...(identityChain === 'evm' ? ['evm'] : [])
    ])
    const submissionId = await computePublicSubmissionId(candidate)
    const binding = parseNoirPublicTransactionBinding({
      schemaVersion: 1,
      provider: 'noir-public',
      kind: 'contract-call',
      network: input.network,
      requestId: input.requestId,
      origin: input.origin,
      accountAddress: input.accountAddress,
      parentContractId: readPublicAccountId(input.parentContractId, 'Public parent contract'),
      identityPublicKey: readPublicIdentity(input.identityPublicKey, identityChain),
      ...(identityChain === 'evm' ? { identityChain: 'evm' as const } : {}),
      requestFingerprint: await fingerprintPublicRequests(originalTxRequests),
      submissionId,
      signedRequest: serializePublicCandidate(candidate)
    })
    const graph = createPublicGraph(input, operationId, binding, 'signed', submissionId)
    const result = await this.repository.create(graph)
    if (result.status === 'id-conflict') {
      throw new Error('Noir Public request ID already has a different signed payload')
    }
    return projectPublicTransaction(result.graph)
  }

  async getByRequestId(
    scope: TransactionAccountScope,
    network: NoirPublicNetwork,
    origin: string,
    requestId: string,
    identityChain: 'zcash' | 'evm' = 'zcash'
  ): Promise<NoirPublicTransactionRecord | null> {
    const parsedScope = parseScope(scope)
    const id = await publicOperationId('transaction', [
      parsedScope.keyDomainId,
      parsedScope.accountId,
      network,
      origin,
      requestId,
      ...(identityChain === 'evm' ? ['evm'] : [])
    ])
    const graph = await this.repository.get(parsedScope, parseTransactionId(id))
    return graph &&
      assertRecordContext(graph, network, origin) &&
      (requirePublicBinding(graph).identityChain === 'evm' ? 'evm' : 'zcash') === identityChain
      ? projectPublicTransaction(graph)
      : null
  }

  async getByOperationId(
    scope: TransactionAccountScope,
    network: NoirPublicNetwork,
    origin: string,
    operationId: string,
    identityChain?: 'zcash' | 'evm'
  ): Promise<NoirPublicTransactionRecord | null> {
    const graph = await this.repository.get(parseScope(scope), parseTransactionId(operationId))
    return graph &&
      assertRecordContext(graph, network, origin) &&
      (identityChain === undefined ||
        (requirePublicBinding(graph).identityChain === 'evm' ? 'evm' : 'zcash') === identityChain)
      ? projectPublicTransaction(graph)
      : null
  }

  async getPendingActivation(
    scope: TransactionAccountScope,
    network: NoirPublicNetwork,
    parentContractId: string,
    identityPublicKey: string,
    identityChain: 'zcash' | 'evm' = 'zcash'
  ): Promise<NoirPublicActivationRecord | null> {
    const parsedScope = parseScope(scope)
    if (identityChain === 'evm') {
      const activations = await this.listEvmActivations(
        parsedScope,
        network,
        parentContractId,
        readPublicIdentity(identityPublicKey, 'evm')
      )
      return (
        activations.find(
          record => record.graph.root.status !== 'final' && record.graph.root.status !== 'failed'
        ) ?? null
      )
    }
    const id = await publicOperationId('activation', [
      parsedScope.keyDomainId,
      parsedScope.accountId,
      network,
      parentContractId,
      readPublicIdentity(identityPublicKey, identityChain)
    ])
    const graph = await this.repository.get(parsedScope, parseTransactionId(id))
    if (!graph || graph.root.status === 'final' || graph.root.status === 'failed') return null
    const binding = requirePublicBinding(graph)
    return binding.kind === 'public-activation' ? Object.freeze({ graph, binding }) : null
  }

  async listPending(
    scopes: readonly TransactionAccountScope[],
    network: NoirPublicNetwork
  ): Promise<readonly (NoirPublicTransactionRecord | NoirPublicActivationRecord)[]> {
    const groups = await Promise.all(
      scopes.map(scope =>
        this.repository.list({
          scope: parseScope(scope),
          provider: 'noir-public',
          statuses: ['prepared', 'signed', 'broadcast', 'confirming', 'final'],
          limit: TRANSACTION_REPOSITORY_LIMITS.recordsPerAccount
        })
      )
    )
    return Object.freeze(
      groups.flatMap(graphs =>
        graphs.flatMap(graph => {
          const binding = graph.root.intent?.protocol
          if (binding?.provider !== 'noir-public' || binding.network !== network) return []
          if (graph.root.status === 'final') {
            const anchor = graph.segments.find(segment => segment.role === 'destination')
            if (!anchor || anchor.status === 'final' || anchor.status === 'failed') return []
          }
          return [
            binding.kind === 'public-activation'
              ? Object.freeze({ graph, binding: requirePublicBinding(graph) })
              : projectPublicTransaction(graph)
          ]
        })
      )
    )
  }

  async applyObservation(
    scope: TransactionAccountScope,
    operationId: string,
    observation: NoirPublicTransactionObservation,
    now: number
  ): Promise<NoirPublicTransactionRecord> {
    const parsedScope = parseScope(scope)
    const id = parseTransactionId(operationId)
    const original = await this.repository.get(parsedScope, id)
    if (!original) throw new Error('Noir Public transaction was not found')
    const binding = requirePublicBinding(original)
    if (binding.kind !== 'contract-call' || binding.submissionId !== observation.submission_id) {
      throw new Error('Noir Public status does not match the signed request')
    }
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid observation time')
    if (observation.verifiedExecution && !observation.tx_hash) {
      throw new Error('Noir Public execution finality requires a transaction hash')
    }
    const status: TransactionLifecycleStatus =
      observation.verifiedExecution === 'success'
        ? 'final'
        : observation.verifiedExecution === 'failure'
          ? 'failed'
          : observation.status === 'FAILED'
            ? original.root.status
            : observation.status === 'COMPLETED' || observation.status === 'PARTIALLY_SUCCEEDED'
              ? 'broadcast'
              : 'confirming'
    const origin = await this.applyProgress(
      parsedScope,
      id,
      'origin',
      status,
      now,
      { ...(observation.tx_hash ? { transactionHash: observation.tx_hash } : {}) },
      status === 'failed' ? 'reverted' : undefined
    )
    if (observation.anchor) {
      await this.applyProgress(parsedScope, id, 'destination', 'broadcast', now, {
        transactionHash: observation.anchor.txid_hex
      })
    }
    return projectPublicTransaction((await this.repository.get(parsedScope, id)) ?? origin)
  }

  async markSubmitted(
    scope: TransactionAccountScope,
    operationId: string,
    submissionId: string,
    now: number
  ): Promise<NoirPublicTransactionRecord> {
    const parsedScope = parseScope(scope)
    const id = parseTransactionId(operationId)
    const graph = await this.repository.get(parsedScope, id)
    if (!graph || requirePublicBinding(graph).submissionId !== submissionId) {
      throw new Error('Noir Public submission does not match the signed request')
    }
    const updated = await this.applyProgress(parsedScope, id, 'origin', 'broadcast', now, {})
    return projectPublicTransaction(updated)
  }

  async markExpiredUnexecuted(
    scope: TransactionAccountScope,
    operationId: string,
    proof: { readonly nonce: string; readonly finalBlockTimestampMs: number },
    now: number
  ): Promise<NoirPublicTransactionRecord> {
    if (
      !Number.isSafeInteger(proof.finalBlockTimestampMs) ||
      proof.finalBlockTimestampMs < 0 ||
      !Number.isSafeInteger(now) ||
      now < 0
    ) {
      throw new Error('Invalid Noir Public expiry proof time')
    }
    const parsedScope = parseScope(scope)
    const id = parseTransactionId(operationId)
    const updated = await this.applyProgress(
      parsedScope,
      id,
      'origin',
      'failed',
      now,
      {},
      'expired',
      graph => {
        const binding = requirePublicBinding(graph)
        if (binding.kind !== 'contract-call' || !binding.signedRequest) {
          throw new Error('Noir Public expiry requires a signed transaction')
        }
        if (graph.root.status === 'final' || graph.root.status === 'failed') return
        if (
          graph.root.status !== 'signed' &&
          graph.root.status !== 'broadcast' &&
          graph.root.status !== 'confirming'
        ) {
          throw new Error('Noir Public transaction is not awaiting execution')
        }
        if (
          graph.segments.some(
            segment => segment.role === 'origin' && segment.evidence?.transactionHash
          )
        ) {
          throw new Error('Noir Public execution hash must be verified before expiry')
        }
        const candidate = parsePublicCandidate(JSON.parse(binding.signedRequest))
        const deadline = Number(candidate.deadline)
        if (
          proof.nonce !== candidate.nonce ||
          !Number.isSafeInteger(deadline) ||
          proof.finalBlockTimestampMs <= deadline
        ) {
          throw new Error('Noir Public expiry proof does not match the signed request')
        }
      }
    )
    return projectPublicTransaction(updated)
  }

  async applyActivationPayment(
    scope: TransactionAccountScope,
    operationId: string,
    transactionHash: string,
    status: 'broadcast' | 'confirming' | 'final',
    now: number
  ): Promise<NoirPublicActivationRecord> {
    const parsedScope = parseScope(scope)
    const id = parseTransactionId(operationId)
    const graph = await this.repository.get(parsedScope, id)
    if (!graph || requirePublicBinding(graph).kind !== 'public-activation') {
      throw new Error('Noir Public activation was not found')
    }
    const updated = await this.applyProgress(parsedScope, id, 'origin', status, now, {
      transactionHash
    })
    return Object.freeze({ graph: updated, binding: requirePublicBinding(updated) })
  }

  async markEvmActivationPaymentRejected(
    scope: TransactionAccountScope,
    operationId: string,
    now: number,
    failedTransferGraph?: TransactionGraph
  ): Promise<NoirPublicActivationRecord> {
    const parsedScope = parseScope(scope)
    const id = parseTransactionId(operationId)
    const activation = await this.repository.get(parsedScope, id)
    const payment = activation && requirePublicBinding(activation).paymentIntent?.evmPayment
    if (!payment) throw new Error('Noir Public EVM activation payment is missing')
    const durableTransfer = await this.repository.get(
      parsedScope,
      parseTransactionId(payment.transactionId)
    )
    const transfer =
      durableTransfer ?? (failedTransferGraph ? parseTransactionGraph(failedTransferGraph) : null)
    if (
      transfer?.root.id !== payment.transactionId ||
      transfer.root.scope.keyDomainId !== parsedScope.keyDomainId ||
      transfer.root.scope.accountId !== parsedScope.accountId ||
      transfer.root.status !== 'failed' ||
      transfer.segments.some(segment => segment.evidence?.transactionHash)
    )
      throw new Error('Noir Public EVM transfer has not failed without a broadcast')
    const updated = await this.applyProgress(
      parsedScope,
      id,
      'origin',
      'failed',
      now,
      {},
      'user-rejected',
      graph => {
        const binding = requirePublicBinding(graph)
        const origin = graph.segments.find(segment => segment.role === 'origin')
        if (
          binding.kind !== 'public-activation' ||
          binding.identityChain !== 'evm' ||
          !binding.paymentIntent?.evmPayment ||
          origin?.status !== 'prepared' ||
          origin.evidence?.transactionHash
        )
          throw new Error('Noir Public activation payment cannot be rejected')
      }
    )
    return Object.freeze({ graph: updated, binding: requirePublicBinding(updated) })
  }

  async markEvmActivationPaymentAbandoned(
    scope: TransactionAccountScope,
    operationId: string,
    now: number,
    confirmNoPending: () => Promise<boolean>
  ): Promise<NoirPublicActivationRecord> {
    const parsedScope = parseScope(scope)
    const id = parseTransactionId(operationId)
    const activation = await this.repository.get(parsedScope, id)
    const binding = activation && requirePublicBinding(activation)
    const payment =
      binding?.kind === 'public-activation' && binding.identityChain === 'evm'
        ? binding.paymentIntent?.evmPayment
        : undefined
    if (!payment) throw new Error('Noir Public EVM activation payment is missing')
    if (!(await confirmNoPending())) {
      throw new Error('Noir Public EVM payment is still pending')
    }
    const durable = await this.repository.get(
      parsedScope,
      parseTransactionId(payment.transactionId)
    )
    if (
      durable &&
      (durable.root.status !== 'failed' ||
        durable.segments.some(segment => segment.evidence?.transactionHash))
    )
      throw new Error('Noir Public EVM payment may still execute')
    const updated = await this.applyProgress(
      parsedScope,
      id,
      'origin',
      'failed',
      now,
      {},
      'cancelled',
      graph => {
        const current = requirePublicBinding(graph)
        const origin = graph.segments.find(segment => segment.role === 'origin')
        if (
          current.kind !== 'public-activation' ||
          current.identityChain !== 'evm' ||
          current.paymentIntent?.evmPayment?.transactionId !== payment.transactionId ||
          origin?.status !== 'prepared' ||
          origin.evidence?.transactionHash
        )
          throw new Error('Noir Public activation payment cannot be abandoned')
      }
    )
    return Object.freeze({ graph: updated, binding: requirePublicBinding(updated) })
  }

  async applyActivationBound(
    scope: TransactionAccountScope,
    operationId: string,
    account: Pick<
      NoirPublicAccount,
      'chain' | 'status' | 'network' | 'parentContractId' | 'publicKey' | 'mcaId'
    >,
    now: number
  ): Promise<NoirPublicActivationRecord> {
    const parsedScope = parseScope(scope)
    const id = parseTransactionId(operationId)
    const graph = await this.repository.get(parsedScope, id)
    const binding = graph ? requirePublicBinding(graph) : null
    if (
      !graph ||
      binding?.kind !== 'public-activation' ||
      account.chain !== (binding.identityChain === 'evm' ? 'evm' : 'zcash-l2') ||
      account.status !== 'active' ||
      account.network !== binding.network ||
      account.parentContractId !== binding.parentContractId ||
      readPublicIdentity(account.publicKey, binding.identityChain ?? 'zcash') !==
        binding.identityPublicKey ||
      !account.mcaId ||
      readPublicAccountId(account.mcaId, 'Bound Noir Public account') === binding.accountAddress
    ) {
      throw new Error('Noir Public activation does not match the bound account')
    }
    const updated = await this.applyProgress(parsedScope, id, 'origin', 'final', now, {})
    return Object.freeze({ graph: updated, binding: requirePublicBinding(updated) })
  }

  private async applyProgress(
    scope: TransactionAccountScope,
    transactionId: ReturnType<typeof parseTransactionId>,
    role: 'origin' | 'destination',
    status: TransactionLifecycleStatus,
    now: number,
    evidence: { readonly transactionHash?: string },
    failure?: 'reverted' | 'expired' | 'user-rejected' | 'cancelled',
    precondition?: (graph: TransactionGraph) => void
  ): Promise<TransactionGraph> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const graph = await this.repository.get(scope, transactionId)
      if (!graph) throw new Error('Noir Public transaction was removed')
      precondition?.(graph)
      const segment = graph.segments.find(item => item.role === role)
      if (!segment) throw new Error('Noir Public transaction segment is missing')
      if (segment.status === 'final' || segment.status === 'failed') return graph
      if (
        segment.status === status &&
        !failure &&
        (!evidence.transactionHash ||
          evidence.transactionHash === segment.evidence?.transactionHash)
      ) {
        return graph
      }
      const eventId = parseTransactionEventId(
        `event:noir-public:${(await sha256(JSON.stringify([transactionId, role, status, evidence, failure]))).slice(0, 64)}`
      )
      const result = await this.repository.applySegmentEvent({
        scope,
        transactionId,
        segmentId: segment.id,
        event: {
          id: eventId,
          status,
          cause: failure ? 'failure' : 'progress',
          observedAt: Math.max(now, segment.updatedAt),
          ...(Object.keys(evidence).length === 0 ? {} : { evidence }),
          ...(failure
            ? { failure: { code: failure, occurredAt: Math.max(now, segment.updatedAt) } }
            : {})
        },
        expectedRootRevision: graph.root.revision,
        expectedSegmentRevision: segment.revision
      })
      if (
        result.status === 'applied' ||
        result.status === 'duplicate-event' ||
        result.status === 'ignored-stale'
      ) {
        return result.graph ?? graph
      }
      if (result.status !== 'revision-conflict')
        throw new Error('Noir Public observation conflicts')
    }
    throw new Error('Noir Public observation did not settle')
  }
}
