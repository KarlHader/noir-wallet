import {
  parseTransactionGraph,
  parseTransactionId,
  parseTransactionSegmentId,
  type TransactionAccountScope,
  type TransactionIntentSnapshot,
  type TransactionGraph
} from '@/core/transactions/domain'
import { getZcashChainId } from '@/core/chains/registry'
import type { Network } from '@/types'
import type { ConfidentialFundingPlan } from './confidential-funding-model'

const CONFIDENTIAL_TRANSACTION_PREFIX = 'tx:confidential:'

export function getConfidentialFundingPlanId(transactionId: string): string | null {
  if (!transactionId.startsWith(CONFIDENTIAL_TRANSACTION_PREFIX)) return null
  const planId = transactionId.slice(CONFIDENTIAL_TRANSACTION_PREFIX.length)
  return /^[a-zA-Z0-9:_-]{1,160}$/.test(planId) ? planId : null
}

export function isLegacyShieldWithdrawActivityGraph(graph: TransactionGraph): boolean {
  const intent = graph.root.intent
  return (
    intent?.direction === 'outgoing' &&
    intent.shield?.operation === 'withdraw' &&
    intent.shield.sourceDomain === 'shield' &&
    intent.shield.destinationDomain === 'public' &&
    intent.recipient?.chainId.startsWith('eip155:') === true
  )
}

export function projectLegacyShieldWithdrawActivityGraph(
  graph: TransactionGraph,
  plan: ConfidentialFundingPlan | undefined,
  network: Network,
  privateExecutionAddresses: readonly string[]
): TransactionGraph {
  const { id, scope, intent } = graph.root
  const recipient = intent?.recipient
  const shield = intent?.shield
  if (
    !isLegacyShieldWithdrawActivityGraph(graph) ||
    !intent ||
    !shield ||
    !recipient ||
    plan?.operation !== 'withdraw' ||
    plan.destinationDomain !== 'public' ||
    plan.transactionId !== id ||
    plan.network !== network ||
    plan.keyDomainId !== scope.keyDomainId ||
    plan.accountId !== scope.accountId ||
    plan.destination.chainId !== recipient.chainId ||
    plan.destination.address.toLowerCase() !== recipient.address.toLowerCase() ||
    plan.externalRecipient?.toLowerCase() !== recipient.address.toLowerCase() ||
    !privateExecutionAddresses.includes(recipient.address.toLowerCase())
  )
    return graph
  return {
    ...graph,
    root: {
      ...graph.root,
      intent: { ...intent, shield: { ...shield, destinationDomain: 'private' } }
    }
  }
}

export function projectShieldDepositSettlement(
  graph: TransactionGraph,
  plan: ConfidentialFundingPlan | undefined,
  network: Network
): TransactionGraph {
  const { root, segments } = graph
  const intent = root.intent
  const relay = segments.find(segment => segment.role === 'relay' && segment.status === 'final')
  if (
    root.status !== 'final' ||
    root.reconfirming ||
    !relay ||
    segments.some(segment => segment.role === 'destination') ||
    intent?.shield?.operation !== 'deposit' ||
    intent.direction !== 'self' ||
    plan?.operation !== 'deposit' ||
    plan.phase !== 'ready' ||
    plan.network !== network ||
    plan.transactionId !== root.id ||
    plan.keyDomainId !== root.scope.keyDomainId ||
    plan.accountId !== root.scope.accountId ||
    plan.destination.assetId !== intent.counterAmount?.assetId ||
    plan.destination.chainId !== intent.recipient?.chainId ||
    plan.destination.address !== intent.recipient.address ||
    !plan.settledOutputRaw ||
    !/^[1-9]\d*$/.test(plan.settledOutputRaw)
  )
    return graph

  const id = parseTransactionSegmentId(`segment:confidential:${plan.planId}:deposit-credit`)
  return parseTransactionGraph({
    root: { ...root, segmentIds: [...root.segmentIds, id] },
    segments: [
      ...segments,
      {
        id,
        transactionId: root.id,
        role: 'destination',
        target: {
          kind: 'protocol',
          provider: 'Confidential Intents',
          account: plan.destination.address
        },
        status: 'final',
        requiredForFinality: false,
        dependsOn: [relay.id],
        evidence: {
          settledAmount: { assetId: plan.destination.assetId, amountRaw: plan.settledOutputRaw }
        },
        createdAt: root.createdAt,
        updatedAt: root.updatedAt,
        revision: 0
      }
    ]
  })
}

export function createConfidentialFundingGraph(input: {
  readonly planId: string
  readonly operation?: 'deposit' | 'withdraw' | 'cluster' | 'swap'
  readonly purpose?: 'native-zec-swap'
  readonly sourceDomain?: 'public' | 'private' | 'shield'
  readonly destinationDomain?: 'public' | 'private' | 'shield'
  readonly scope: TransactionAccountScope
  readonly source: Readonly<{
    chainId: string
    assetId: string
    amountRaw: string
    address: string
    senderAddress?: string
    evmSenderAddress?: string
    feeAssetId?: string
    maximumFeeRaw?: string
    transactionHash?: string
    evm?: Omit<NonNullable<TransactionIntentSnapshot['evm']>, 'schemaVersion'>
  }>
  readonly destination: Readonly<{
    chainId: string
    assetId: string
    expectedAmountRaw: string
    address: string
  }>
  readonly externalRecipient?: boolean
  readonly withdrawDepositAddresses: readonly (string | null)[]
  readonly requiresDeposit: boolean
  readonly signedWithdrawFingerprint?: string
  readonly now: number
}): TransactionGraph {
  if (
    input.operation &&
    ((input.operation === 'deposit' &&
      (!['public', 'private'].includes(input.sourceDomain ?? '') ||
        input.destinationDomain !== 'shield')) ||
      (input.operation === 'withdraw' &&
        (input.sourceDomain !== 'shield' ||
          !['public', 'private'].includes(input.destinationDomain ?? ''))) ||
      (input.operation === 'swap' &&
        (input.sourceDomain !== 'shield' || input.destinationDomain !== 'shield')) ||
      (input.operation === 'cluster' &&
        (!['public', 'private', 'shield'].includes(input.sourceDomain ?? '') ||
          !['public', 'private'].includes(input.destinationDomain ?? '') ||
          input.sourceDomain === input.destinationDomain)))
  )
    throw new Error('Confidential funding graph route is invalid')
  if (
    input.purpose === 'native-zec-swap' &&
    (input.operation !== 'withdraw' ||
      input.sourceDomain !== 'shield' ||
      input.destinationDomain !== 'public' ||
      (input.destination.chainId !== getZcashChainId('mainnet') &&
        input.destination.chainId !== getZcashChainId('testnet')) ||
      input.destination.assetId !== `${input.destination.chainId}/slip44:133` ||
      input.source.assetId === input.destination.assetId)
  )
    throw new Error('Confidential funding graph swap route is invalid')
  if (!input.requiresDeposit && !/^[0-9a-f]{64}$/.test(input.signedWithdrawFingerprint ?? '')) {
    throw new Error('Confidential funding graph requires a frozen signed withdraw batch')
  }
  const transactionId = parseTransactionId(`${CONFIDENTIAL_TRANSACTION_PREFIX}${input.planId}`)
  const originId = parseTransactionSegmentId(`segment:confidential:${input.planId}:origin`)
  const relayId = parseTransactionSegmentId(`segment:confidential:${input.planId}:relay`)
  const destinationIds = input.withdrawDepositAddresses.map((_, index) =>
    parseTransactionSegmentId(`segment:confidential:${input.planId}:withdraw:${index}`)
  )
  const refundId = parseTransactionSegmentId(`segment:confidential:${input.planId}:refund`)
  const segmentIds = [originId, relayId, ...destinationIds, refundId]
  return parseTransactionGraph({
    root: {
      id: transactionId,
      scope: input.scope,
      kind:
        input.purpose === 'native-zec-swap'
          ? 'swap'
          : input.operation === 'deposit'
            ? 'shield'
            : input.operation === 'withdraw' || input.operation === 'cluster'
              ? 'withdraw'
              : 'swap',
      status: input.requiresDeposit ? 'signed' : 'confirming',
      segmentIds,
      createdAt: input.now,
      updatedAt: input.now,
      revision: 0,
      intent: {
        schemaVersion: 1,
        direction: input.operation && !input.externalRecipient ? 'self' : 'outgoing',
        ...(input.operation
          ? {
              shield: {
                schemaVersion: 1 as const,
                operation: input.purpose === 'native-zec-swap' ? 'swap' : input.operation,
                sourceDomain: input.sourceDomain!,
                destinationDomain: input.destinationDomain!
              }
            }
          : {}),
        primaryAmount: { assetId: input.source.assetId, amountRaw: input.source.amountRaw },
        counterAmount: {
          assetId: input.destination.assetId,
          amountRaw: input.destination.expectedAmountRaw
        },
        ...(input.source.feeAssetId && input.source.maximumFeeRaw
          ? {
              feeLimit: {
                assetId: input.source.feeAssetId,
                amountRaw: input.source.maximumFeeRaw
              }
            }
          : {}),
        sender: {
          chainId: input.source.chainId,
          address:
            input.source.senderAddress ?? input.source.evmSenderAddress ?? input.source.address
        },
        ...(input.source.evm ? { evm: { schemaVersion: 1 as const, ...input.source.evm } } : {}),
        recipient: { chainId: input.destination.chainId, address: input.destination.address }
      }
    },
    segments: [
      {
        id: originId,
        transactionId,
        role: 'origin',
        target: input.requiresDeposit
          ? { kind: 'onchain', chainId: input.source.chainId }
          : { kind: 'protocol', provider: 'Confidential Intents', account: input.source.address },
        status: input.requiresDeposit ? 'signed' : 'final',
        requiredForFinality: true,
        dependsOn: [],
        ...(input.source.transactionHash
          ? {
              evidence: {
                transactionHash: input.source.transactionHash,
                ...(input.source.evm
                  ? { externalReference: `evm-nonce:${input.source.evm.nonce}` }
                  : {})
              }
            }
          : !input.requiresDeposit
            ? {
                evidence: {
                  externalReference: `signed-payload:sha256:${input.signedWithdrawFingerprint}`
                }
              }
            : {}),
        createdAt: input.now,
        updatedAt: input.now,
        revision: 0
      },
      {
        id: relayId,
        transactionId,
        role: 'relay',
        target: {
          kind: 'protocol',
          provider: 'Confidential Intents',
          account: input.source.address
        },
        status: 'created',
        requiredForFinality: true,
        dependsOn: [originId],
        evidence: { externalReference: input.planId },
        createdAt: input.now,
        updatedAt: input.now,
        revision: 0
      },
      ...destinationIds.map((id, index) => ({
        id,
        transactionId,
        role: 'destination' as const,
        target:
          input.operation === 'swap'
            ? {
                kind: 'protocol' as const,
                provider: 'Confidential Intents',
                account: input.destination.address
              }
            : { kind: 'onchain' as const, chainId: input.destination.chainId },
        status: 'created' as const,
        requiredForFinality: false,
        dependsOn: [relayId],
        ...(input.withdrawDepositAddresses[index]
          ? { evidence: { externalReference: input.withdrawDepositAddresses[index] } }
          : {}),
        createdAt: input.now,
        updatedAt: input.now,
        revision: 0
      })),
      {
        id: refundId,
        transactionId,
        role: 'refund',
        target:
          input.operation === 'deposit'
            ? { kind: 'onchain', chainId: input.source.chainId }
            : {
                kind: 'protocol',
                provider: 'Confidential Intents',
                account: input.source.address
              },
        status: 'created',
        requiredForFinality: false,
        dependsOn: [relayId],
        createdAt: input.now,
        updatedAt: input.now,
        revision: 0
      }
    ]
  })
}
