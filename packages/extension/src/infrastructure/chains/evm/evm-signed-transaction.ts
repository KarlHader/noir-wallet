import { secp256k1 } from '@noble/curves/secp256k1'
import {
  keccak256,
  parseTransaction,
  serializeTransaction,
  type Hex,
  type TransactionSerializableLegacy,
  type TransactionSerializedLegacy,
  type TransactionSerializableEIP1559,
  type TransactionSerializedEIP1559
} from 'viem'
import type { PreparedEvmTransfer } from './evm-transaction-builder'

export interface SignedEvmTransactionEnvelope {
  readonly rawTransaction: string
  readonly transactionHash: string
}

function toSerializableEip1559(prepared: PreparedEvmTransfer): TransactionSerializableEIP1559 {
  const transaction = prepared.transaction
  if (transaction.type !== 'eip1559') failIntegrity('transaction-type')
  const chainId = Number(transaction.chainId)
  const nonce = Number(transaction.nonce)
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || !Number.isSafeInteger(nonce) || nonce < 0) {
    failIntegrity('chain-id')
  }
  return Object.freeze({
    type: 'eip1559' as const,
    chainId,
    nonce,
    maxFeePerGas: BigInt(transaction.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(transaction.maxPriorityFeePerGas),
    gas: BigInt(transaction.gasLimit),
    to: transaction.to as Hex,
    value: BigInt(transaction.value),
    data: transaction.input as Hex,
    accessList: Object.freeze([])
  })
}

function toSerializableLegacy(prepared: PreparedEvmTransfer): TransactionSerializableLegacy {
  const transaction = prepared.transaction
  if (transaction.type !== 'legacy') failIntegrity('transaction-type')
  const chainId = Number(transaction.chainId)
  const nonce = Number(transaction.nonce)
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || !Number.isSafeInteger(nonce) || nonce < 0) {
    failIntegrity('chain-id')
  }
  return Object.freeze({
    type: 'legacy' as const,
    chainId,
    nonce,
    gasPrice: BigInt(transaction.gasPrice),
    gas: BigInt(transaction.gasLimit),
    to: transaction.to as Hex,
    value: BigInt(transaction.value),
    data: transaction.input as Hex
  })
}

export function serializePreparedEvmUnsignedTransaction(prepared: PreparedEvmTransfer): string {
  return prepared.transaction.type === 'legacy'
    ? serializeTransaction(toSerializableLegacy(prepared))
    : serializeTransaction(toSerializableEip1559(prepared))
}

export async function createKeystoneSignedEvmTransaction(
  prepared: PreparedEvmTransfer,
  signatureHex: string
): Promise<SignedEvmTransactionEnvelope> {
  if (!/^0x[0-9a-f]{130}$/.test(signatureHex)) failIntegrity('signature-envelope')
  const yParity = Number.parseInt(signatureHex.slice(-2), 16)
  if (yParity !== 0 && yParity !== 1) failIntegrity('signature-recovery')
  const signature = {
    r: signatureHex.slice(0, 66) as Hex,
    s: `0x${signatureHex.slice(66, 130)}` as Hex,
    yParity
  }
  const rawTransaction =
    prepared.transaction.type === 'legacy'
      ? serializeTransaction(toSerializableLegacy(prepared), {
          ...signature,
          v: 27n + BigInt(yParity)
        })
      : serializeTransaction(toSerializableEip1559(prepared), signature)
  const envelope = Object.freeze({
    rawTransaction,
    transactionHash: keccak256(rawTransaction)
  })
  await assertSignedEvmTransactionMatchesPrepared(prepared, envelope)
  return envelope
}

function failIntegrity(reason: string): never {
  throw new Error(`Signed EVM transaction failed integrity validation (${reason})`)
}

function equalAddress(left: string | null | undefined, right: string): boolean {
  return left?.toLowerCase() === right.toLowerCase()
}

export async function assertSignedEvmTransactionMatchesPrepared(
  prepared: PreparedEvmTransfer,
  signed: SignedEvmTransactionEnvelope
): Promise<void> {
  if (
    !/^0x(?:[0-9a-f]{2})+$/.test(signed.rawTransaction) ||
    signed.rawTransaction.length > 2 + 128 * 1024 * 2 ||
    !/^0x[0-9a-f]{64}$/.test(signed.transactionHash)
  ) {
    failIntegrity('envelope')
  }

  const rawTransaction = signed.rawTransaction as
    | TransactionSerializedEIP1559
    | TransactionSerializedLegacy
  let decoded: ReturnType<typeof parseTransaction>
  try {
    decoded = parseTransaction(rawTransaction)
  } catch {
    failIntegrity('transaction-decode')
  }

  const transaction = prepared.transaction
  if (decoded.type !== transaction.type) failIntegrity('transaction-type')
  const yParity =
    decoded.type === 'legacy'
      ? decoded.v === undefined
        ? undefined
        : Number((BigInt(decoded.v) - 35n - BigInt(transaction.chainId) * 2n) % 2n)
      : decoded.yParity
  if (decoded.r === undefined || decoded.s === undefined || (yParity !== 0 && yParity !== 1)) {
    failIntegrity('signature-fields')
  }

  const signature = (() => {
    try {
      return secp256k1.Signature.fromCompact(`${decoded.r.slice(2)}${decoded.s.slice(2)}`)
    } catch {
      failIntegrity('signature-decode')
    }
  })()
  if (signature.hasHighS()) failIntegrity('signature-high-s')

  let signer: string
  try {
    const signingHash = keccak256(serializePreparedEvmUnsignedTransaction(prepared) as Hex)
    const publicKey = signature
      .addRecoveryBit(yParity)
      .recoverPublicKey(signingHash.slice(2))
      .toHex(false)
    signer = `0x${keccak256(`0x${publicKey.slice(2)}` as Hex).slice(-40)}`
  } catch {
    failIntegrity('signature-recovery')
  }

  if (keccak256(rawTransaction) !== signed.transactionHash) failIntegrity('transaction-hash')
  if (!equalAddress(signer, prepared.from)) failIntegrity('signer')
  if (decoded.chainId?.toString() !== transaction.chainId) failIntegrity('chain-id')
  if (decoded.nonce?.toString() !== transaction.nonce) failIntegrity('nonce')
  if (transaction.type === 'legacy') {
    if (decoded.gasPrice?.toString() !== transaction.gasPrice) failIntegrity('gas-price')
  } else {
    if (decoded.maxFeePerGas?.toString() !== transaction.maxFeePerGas) failIntegrity('max-fee')
    // viem omits an RLP-encoded zero priority fee from the parsed transaction.
    if ((decoded.maxPriorityFeePerGas ?? 0n).toString() !== transaction.maxPriorityFeePerGas) {
      failIntegrity('priority-fee')
    }
  }
  if (decoded.gas?.toString() !== transaction.gasLimit) failIntegrity('gas-limit')
  if (!equalAddress(decoded.to, transaction.to)) failIntegrity('recipient')
  if ((decoded.value ?? 0n).toString() !== transaction.value) failIntegrity('value')
  if ((decoded.data ?? '0x').toLowerCase() !== transaction.input) failIntegrity('calldata')
  if ((decoded.accessList?.length ?? 0) !== 0) failIntegrity('access-list')
}
