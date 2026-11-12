import {
  decodeQuantusAccountId,
  parseQuantusAddress,
  resolveQuantusDerivationScheme,
  type QuantusDerivationScheme
} from '@/core/chains/quantus'
import { bytesToHex } from '@/lib/bytes'
import type { QuantusReadRpc } from './quantus-rpc-types'

const MAXIMUM_U128 = (1n << 128n) - 1n
const SIGNATURE_SHAPES = Object.freeze({
  'ml-dsa-87': Object.freeze({ variant: 0, publicKeyBytes: 2592, signatureBytes: 4627 }),
  'ml-dsa-65': Object.freeze({ variant: 1, publicKeyBytes: 1952, signatureBytes: 3309 })
})

function compact(value: bigint): number[] {
  if (value < 0n || value > MAXIMUM_U128) throw new Error('Invalid Quantus SCALE integer')
  if (value < 64n) return [Number(value << 2n)]
  if (value < 16_384n) {
    const encoded = Number((value << 2n) | 1n)
    return [encoded & 255, encoded >>> 8]
  }
  if (value < 1n << 30n) {
    const encoded = Number((value << 2n) | 2n)
    return [encoded & 255, (encoded >>> 8) & 255, (encoded >>> 16) & 255, encoded >>> 24]
  }
  const bytes: number[] = []
  for (let remaining = value; remaining > 0n; remaining >>= 8n) {
    bytes.push(Number(remaining & 255n))
  }
  return [((bytes.length - 4) << 2) | 3, ...bytes]
}

/**
 * Fee query only: a signed-v4 envelope with the exact reviewed transfer call
 * and scheme-sized zero signature. It cannot authorize a transfer and is never
 * sent to author_submitExtrinsic. The runtime charges by encoded length/weight.
 */
export function buildQuantusFeeQueryExtrinsic(input: {
  readonly signer: string
  readonly recipient: string
  readonly amountRaw: string
  readonly keepAlive: boolean
  readonly scheme: QuantusDerivationScheme
  readonly nonce: number
  readonly eraPeriod: number
}): string {
  const signer = decodeQuantusAccountId(parseQuantusAddress(input.signer))
  const recipient = decodeQuantusAccountId(parseQuantusAddress(input.recipient))
  if (!/^[1-9][0-9]*$/.test(input.amountRaw)) throw new Error('Invalid Quantus fee query amount')
  const amount = BigInt(input.amountRaw)
  if (amount > MAXIMUM_U128) throw new Error('Invalid Quantus fee query amount')
  if (!Number.isSafeInteger(input.nonce) || input.nonce < 0 || input.nonce > 0xffffffff) {
    throw new Error('Invalid Quantus fee query nonce')
  }
  if (
    !Number.isSafeInteger(input.eraPeriod) ||
    input.eraPeriod < 4 ||
    input.eraPeriod > 65_536 ||
    (input.eraPeriod & (input.eraPeriod - 1)) !== 0
  ) {
    throw new Error('Invalid Quantus fee query era')
  }
  const shape = SIGNATURE_SHAPES[resolveQuantusDerivationScheme(input.scheme)]
  const body = Uint8Array.from([
    0x84,
    0,
    ...signer,
    shape.variant,
    ...new Uint8Array(shape.publicKeyBytes + shape.signatureBytes),
    // A mortal era always occupies two bytes. Its phase changes neither size nor fee.
    0x01,
    0,
    ...compact(BigInt(input.nonce)),
    ...compact(0n),
    0,
    2,
    input.keepAlive ? 3 : 0,
    0,
    ...recipient,
    ...compact(amount)
  ])
  return `0x${bytesToHex(Uint8Array.from([...compact(BigInt(body.length)), ...body]))}`
}

/** Quoted fee plus 25% headroom; fail closed if RPC does not supply an estimate. */
export async function estimateQuantusFeeLimit(input: {
  readonly rpc: Pick<QuantusReadRpc, 'queryFee'>
  readonly signer: string
  readonly recipient: string
  readonly amountRaw: string
  readonly keepAlive: boolean
  readonly scheme: QuantusDerivationScheme
  readonly nonce: number
  readonly eraPeriod: number
  readonly signal?: AbortSignal
}): Promise<string> {
  const fee = await input.rpc.queryFee(buildQuantusFeeQueryExtrinsic(input), input.signal)
  if (typeof fee !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(fee)) {
    throw new Error('Invalid Quantus fee estimate')
  }
  const quoted = BigInt(fee)
  if (quoted === 0n || quoted > MAXIMUM_U128) throw new Error('Invalid Quantus fee estimate')
  const limit = quoted + (quoted + 3n) / 4n
  if (limit > MAXIMUM_U128) throw new Error('Invalid Quantus fee estimate')
  return limit.toString()
}
