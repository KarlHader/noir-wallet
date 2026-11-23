import type { TransactionGraph, TransactionIntentSnapshot } from './transaction'

export function isKnownNonMinedEvmFailure(graph: TransactionGraph): boolean {
  const origin = graph.segments.find(segment => segment.role === 'origin')
  return (
    graph.root.status === 'failed' &&
    origin?.status === 'failed' &&
    (origin.failure?.code === 'expired' ||
      origin.failure?.code === 'invalid' ||
      origin.failure?.code === 'dropped') &&
    origin.evidence?.blockHash === undefined &&
    origin.evidence?.blockHeight === undefined &&
    (origin.evidence?.confirmations ?? 0) === 0 &&
    origin.evidence?.replacementTransactionHash === undefined
  )
}

function intentWithoutFees(intent: TransactionIntentSnapshot): string {
  const { feeLimit: _feeLimit, evm: _evm, ...content } = intent
  return JSON.stringify(content)
}

export function isEvmSpeedUpReplacement(
  original: TransactionGraph,
  replacement: TransactionGraph
): boolean {
  const source = original.root.intent
  const next = replacement.root.intent
  const oldTx = source?.evm?.unsignedTransaction
  const newTx = next?.evm?.unsignedTransaction
  const oldOrigin = original.segments.find(segment => segment.role === 'origin')
  const newOrigin = replacement.segments.find(segment => segment.role === 'origin')
  if (
    !source ||
    !next ||
    !oldTx ||
    !newTx ||
    original.root.kind === 'cancel' ||
    replacement.root.kind !== original.root.kind ||
    replacement.root.relation?.kind !== 'replacement-of' ||
    replacement.root.relation.transactionId !== original.root.id ||
    original.root.scope.keyDomainId !== replacement.root.scope.keyDomainId ||
    original.root.scope.accountId !== replacement.root.scope.accountId ||
    source.sender?.chainId !== next.sender?.chainId ||
    source.sender?.address.toLowerCase() !== next.sender?.address.toLowerCase() ||
    intentWithoutFees(source) !== intentWithoutFees(next) ||
    oldOrigin?.target.kind !== 'onchain' ||
    newOrigin?.target.kind !== 'onchain' ||
    oldOrigin.target.chainId !== newOrigin.target.chainId ||
    replacement.segments.length !== 1 ||
    oldTx.type !== newTx.type ||
    oldTx.chainId !== newTx.chainId ||
    oldTx.nonce !== newTx.nonce ||
    oldTx.gasLimit !== newTx.gasLimit ||
    oldTx.to.toLowerCase() !== newTx.to.toLowerCase() ||
    oldTx.value !== newTx.value ||
    oldTx.input !== newTx.input
  ) {
    return false
  }
  if (oldTx.type === 'legacy' && newTx.type === 'legacy') {
    return BigInt(newTx.gasPrice) > BigInt(oldTx.gasPrice)
  }
  if (oldTx.type === 'eip1559' && newTx.type === 'eip1559') {
    return (
      oldTx.accessList.length === 0 &&
      newTx.accessList.length === 0 &&
      BigInt(newTx.maxFeePerGas) > BigInt(oldTx.maxFeePerGas) &&
      BigInt(newTx.maxPriorityFeePerGas) > BigInt(oldTx.maxPriorityFeePerGas)
    )
  }
  return false
}
