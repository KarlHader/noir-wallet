import {
  assertStarknetFelt,
  starknetSelectorFromName
} from '@/infrastructure/chains/starknet/starknet-primitives'
import { LEDGER_STARKNET_MAX_CALLS } from './starknet-model'

export function readLedgerStarknetTransactionNonce(
  transaction: Readonly<Record<string, unknown>>
): string {
  const nonce = transaction.nonce
  if (typeof nonce !== 'string') throw new Error('nonce must be a Starknet felt')
  return assertStarknetFelt(nonce.toLowerCase(), 'nonce')
}

export function normalizeLedgerStarknetCalls(
  calls: readonly Readonly<Record<string, unknown>>[]
): readonly {
  readonly to: string
  readonly selector: string
  readonly entrypoint: null
  readonly calldata: readonly string[]
}[] {
  if (calls.length === 0 || calls.length > LEDGER_STARKNET_MAX_CALLS) {
    throw new Error('Invalid Ledger Starknet call count')
  }
  return calls.map(call => {
    const to = call.to
    if (typeof to !== 'string') throw new Error('Ledger Starknet call target is missing')
    return {
      to: assertStarknetFelt(to.toLowerCase(), 'call.to'),
      selector: ledgerCallSelector(call),
      entrypoint: null,
      calldata: ledgerCalldata(call.calldata)
    }
  })
}

function ledgerCallSelector(call: Readonly<Record<string, unknown>>): string {
  if (typeof call.selector === 'string' && call.selector.length > 0) {
    return assertStarknetFelt(call.selector.toLowerCase(), 'call.selector')
  }
  if (typeof call.entrypoint === 'string' && call.entrypoint.length > 0) {
    return starknetSelectorFromName(call.entrypoint)
  }
  throw new Error('Ledger Starknet call selector is missing')
}

function ledgerCalldata(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new Error('Ledger Starknet calldata is invalid')
  return value.map(item => {
    if (typeof item !== 'string') throw new Error('calldata must be a Starknet felt')
    return assertStarknetFelt(item.toLowerCase(), 'calldata')
  })
}
