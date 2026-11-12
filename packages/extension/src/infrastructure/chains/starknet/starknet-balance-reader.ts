import { normalizeStarknetFelt } from '@/core/chains/starknet/identifiers'

import {
  feltToBigint,
  mergeStarknetU256,
  STARKNET_BALANCE_OF_SELECTOR,
  STARKNET_BALANCE_OF_SNAKE_SELECTOR
} from './starknet-primitives'
import { StarknetRpcError, type StarknetReadRpc } from './starknet-rpc-types'

export interface StarknetTokenBalance {
  readonly reference: string
  readonly amount: bigint
}

export async function readStarknetTokenBalance(
  rpc: Pick<StarknetReadRpc, 'call'>,
  contractAddress: string,
  accountAddress: string,
  signal?: AbortSignal
): Promise<bigint> {
  const contract = normalizeStarknetFelt(contractAddress)
  const account = normalizeStarknetFelt(accountAddress)
  const selectors = [STARKNET_BALANCE_OF_SELECTOR, STARKNET_BALANCE_OF_SNAKE_SELECTOR]
  const amounts: bigint[] = []
  for (const selector of selectors) {
    try {
      const result = await rpc.call(contract, selector, [account], signal)
      amounts.push(parseU256(result))
    } catch (error) {
      if (!isMissingEntrypoint(error)) throw error
    }
  }
  if (amounts.length === 0) {
    throw new StarknetRpcError('invalid-response', 'Starknet balance call failed')
  }
  if (amounts.length === 2 && amounts[0] !== amounts[1]) {
    throw new StarknetRpcError('invalid-response', 'Starknet balance selectors disagree')
  }
  return amounts[0]
}

function parseU256(result: readonly string[]): bigint {
  if (result.length !== 2) {
    throw new StarknetRpcError('invalid-response', 'Starknet balance result is invalid')
  }
  return mergeStarknetU256(feltToBigint(result[0]), feltToBigint(result[1]))
}

function isMissingEntrypoint(error: unknown): boolean {
  return error instanceof StarknetRpcError && error.code === 'entrypoint-not-found'
}
