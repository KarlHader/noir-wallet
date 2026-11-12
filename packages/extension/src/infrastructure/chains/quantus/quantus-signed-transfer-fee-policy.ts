import { parseQuantusAddress } from '@/core/chains/quantus'
import { getQuantusChainId } from '@/core/chains/registry'
import type { QuantusTransferSummary } from '@/core/keyring/domain/signing-summary'
import { parseSigningSummary } from '@/core/keyring/domain/signing-summary-validation'

import type { QuantusReadRpc } from './quantus-rpc-types'

const MAXIMUM_U128 = (1n << 128n) - 1n
const MAXIMUM_EXTRINSIC_HEX_CHARS = 4 * 1024 * 1024

export interface CheckQuantusSignedTransferFeeInput {
  readonly chainId: QuantusTransferSummary['chainId']
  /** The approved signing.prepare summary, not fields reconstructed from the dApp request. */
  readonly summary: unknown
  /** The exact signed bytes returned by signing.confirm. Never submit a different payload. */
  readonly signedExtrinsicHex: unknown
  readonly signerAddress: string
  readonly rpc: Pick<QuantusReadRpc, 'assertExpectedChain' | 'queryFee' | 'getAccountInfo'>
  readonly signal?: AbortSignal
}

export interface QuantusSignedTransferFeeCheck {
  readonly signedExtrinsicHex: string
  readonly actualFeeRaw: string
  readonly freeRaw: string
}

function readU128(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || value.length > 39 || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} must be a canonical unsigned decimal string`)
  }
  const amount = BigInt(value)
  if (amount > MAXIMUM_U128) throw new Error(`${label} exceeds u128`)
  return amount
}

function readExtrinsic(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 4 ||
    value.length > MAXIMUM_EXTRINSIC_HEX_CHARS ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(value)
  ) {
    throw new Error('Invalid signed Quantus extrinsic')
  }
  return value
}

/**
 * Read-only, fail-closed gate before a separate submission step. The caller must
 * bind the signed bytes and approved summary to the same signing operation;
 * this gate cannot decode an extrinsic to prove that binding. The engine's
 * extrinsicHash semantics are not established here, so it is not treated as an
 * independently verified digest of the bytes.
 */
export async function checkQuantusSignedTransferFee(
  input: CheckQuantusSignedTransferFeeInput
): Promise<QuantusSignedTransferFeeCheck> {
  const signerAddress = parseQuantusAddress(input.signerAddress, 'Quantus signer')
  const signedExtrinsicHex = readExtrinsic(input.signedExtrinsicHex)
  if (
    input.chainId !== getQuantusChainId('mainnet') &&
    input.chainId !== getQuantusChainId('testnet')
  ) {
    throw new Error('Unsupported Quantus chain ID')
  }
  const summary = parseSigningSummary(input.summary, {
    family: 'quantus',
    chainId: input.chainId,
    operation: 'transaction'
  }) as QuantusTransferSummary
  if (summary.review.level === 'blocked' || summary.fields.signerAddress !== signerAddress) {
    throw new Error('Quantus signing summary is not approved for this signer')
  }
  const amount = readU128(summary.fields.amountRaw, 'Quantus transfer amount')
  const ceiling = readU128(summary.fields.feeLimitRaw, 'Quantus fee ceiling')
  if (amount === 0n || ceiling === 0n || summary.fields.tipRaw !== '0') {
    throw new Error('Invalid Quantus transfer debit')
  }

  await input.rpc.assertExpectedChain(input.signal)
  const [feeRaw, account] = await Promise.all([
    input.rpc.queryFee(signedExtrinsicHex, input.signal),
    input.rpc.getAccountInfo(signerAddress, input.signal)
  ])
  const actualFee = readU128(feeRaw, 'Quantus actual fee')
  if (typeof account.free !== 'bigint' || account.free < 0n || account.free > MAXIMUM_U128) {
    throw new Error('Invalid Quantus free balance')
  }
  const debit = amount + actualFee
  if (actualFee > ceiling || debit > account.free) {
    throw new Error('Quantus transfer exceeds the reviewed fee ceiling or free balance')
  }
  if (summary.fields.keepAlive && debit >= account.free) {
    throw new Error('Quantus keep-alive transfer must leave a positive free balance')
  }
  return Object.freeze({
    signedExtrinsicHex,
    actualFeeRaw: actualFee.toString(),
    freeRaw: account.free.toString()
  })
}
