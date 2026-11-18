import type { NoirPublicNetworkConfig } from './config'
import {
  parsePublicFunctionCallRequests,
  readPublicAccountId,
  readPublicDecimal,
  readPublicTgas
} from './protocol'
import type { NoirPublicFunctionCallRequest } from './types'

const GAS_UNIT = 1_000_000_000_000n
const FEE_CALL_GAS = 30n * GAS_UNIT
const EXEC_OVERHEAD_TGAS = 120n
const PER_CALL_OVERHEAD_TGAS = 10n
const U128_MAX = (1n << 128n) - 1n

export interface NoirPublicGasFeeQuote {
  readonly feeAccount: string
  readonly feePerTgasRaw: string
  readonly decimals: 8
  readonly batchId: string
  readonly completedAt: number
}

export interface NoirPublicPaidRequests {
  readonly txRequests: readonly NoirPublicFunctionCallRequest[]
  readonly tgas: number
  readonly feeAmountRaw: string
}

export function buildPublicPaidRequests(
  originalTxRequests: unknown,
  quote: NoirPublicGasFeeQuote,
  config: NoirPublicNetworkConfig
): NoirPublicPaidRequests {
  if (config.zecTokenId !== 'zec.omft.near' || quote.decimals !== 8) {
    throw new Error('Unsupported Public fee token')
  }
  const original = parsePublicFunctionCallRequests(originalTxRequests)
  const totalCalls = original.reduce(
    (count, request) => count + request.FunctionCall.function_calls.length,
    1
  )
  const innerGas = original.reduce(
    (sum, request) =>
      sum +
      request.FunctionCall.function_calls.reduce((calls, call) => calls + BigInt(call.gas), 0n),
    FEE_CALL_GAS
  )
  const tgas = readPublicTgas(
    Number(
      (innerGas + GAS_UNIT - 1n) / GAS_UNIT +
        EXEC_OVERHEAD_TGAS +
        PER_CALL_OVERHEAD_TGAS * BigInt(totalCalls)
    )
  )
  const feeAccount = readPublicAccountId(quote.feeAccount, 'Public gas fee account')
  const feePerTgas = BigInt(readPublicDecimal(quote.feePerTgasRaw, 'Public fee per Tgas'))
  const feeAmount = feePerTgas * BigInt(tgas)
  if (feePerTgas === 0n || feeAmount > U128_MAX) throw new Error('Invalid Public gas fee')
  const feeRequest: NoirPublicFunctionCallRequest = {
    FunctionCall: {
      receiver_id: config.zecTokenId,
      function_calls: [
        {
          method_name: 'ft_transfer',
          args: JSON.stringify({ receiver_id: feeAccount, amount: feeAmount.toString() }),
          gas: FEE_CALL_GAS.toString(),
          deposit: '1'
        }
      ]
    }
  }
  return Object.freeze({
    txRequests: parsePublicFunctionCallRequests([feeRequest, ...original]),
    tgas,
    feeAmountRaw: feeAmount.toString()
  })
}

export function assertPublicFeeQuoteStillCovers(
  paid: NoirPublicPaidRequests,
  reviewedQuote: NoirPublicGasFeeQuote,
  currentQuote: NoirPublicGasFeeQuote
): void {
  if (
    readPublicAccountId(reviewedQuote.feeAccount, 'Public gas fee account') !==
      readPublicAccountId(currentQuote.feeAccount, 'Public gas fee account') ||
    BigInt(readPublicDecimal(currentQuote.feePerTgasRaw, 'Public fee per Tgas')) *
      BigInt(readPublicTgas(paid.tgas)) >
      BigInt(readPublicDecimal(paid.feeAmountRaw, 'Public reviewed fee'))
  ) {
    throw new Error('Public gas fee changed. Review a new transaction.')
  }
}
