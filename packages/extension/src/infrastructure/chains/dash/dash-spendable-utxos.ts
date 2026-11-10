import type { DashTransaction, DashUtxo } from './dash-insight-codecs'
import { DASH_COINBASE_MATURITY, DASH_MAX_MONEY_DUFFS } from './config'
import {
  parseDashDuffAmount,
  type DashClassifiedUtxo,
  type DashDiscoveryObservation,
  type DashHeldUtxo,
  type DashSpendableUtxo
} from './dash-discovery-model'

export interface DashBalanceTotals {
  readonly total: bigint
  readonly spendable: bigint
  readonly available: bigint
  readonly pending: bigint
}

export function dashOutpointKey(transactionId: string, outputIndex: number): string {
  return `${transactionId}:${outputIndex}`
}

/**
 * Classifies one Insight UTXO from its creating transaction.
 * DIP2 special transactions (type other than 0) stay held and keep their
 * script off the spendable set, so a later signer cannot treat them as
 * standard P2PKH inputs.
 */
export function classifyDashUtxo(
  utxo: Pick<
    DashUtxo,
    'transactionId' | 'outputIndex' | 'valueDuffs' | 'confirmations' | 'height' | 'scriptHex'
  >,
  transaction: Pick<DashTransaction, 'transactionId' | 'type' | 'isCoinbase'>
): DashClassifiedUtxo {
  if (transaction.transactionId !== utxo.transactionId) {
    throw new Error('Dash UTXO does not match its creating transaction')
  }
  const valueDuffs = parseDashDuffAmount(utxo.valueDuffs).toString()
  if (!Number.isSafeInteger(utxo.confirmations) || utxo.confirmations < 0) {
    throw new Error('Invalid Dash UTXO confirmations')
  }
  if (!Number.isSafeInteger(transaction.type) || transaction.type < 0) {
    throw new Error('Invalid Dash transaction type')
  }
  const reference = Object.freeze({
    transactionId: utxo.transactionId,
    outputIndex: utxo.outputIndex,
    valueDuffs,
    confirmations: utxo.confirmations,
    ...(utxo.height === undefined ? {} : { height: utxo.height })
  })
  if (transaction.type !== 0) {
    return Object.freeze({
      ...reference,
      kind: 'held',
      reason: 'dip2-special-transaction'
    })
  }
  if (utxo.confirmations === 0) {
    return Object.freeze({ ...reference, kind: 'held', reason: 'unconfirmed' })
  }
  if (transaction.isCoinbase && utxo.confirmations < DASH_COINBASE_MATURITY) {
    return Object.freeze({ ...reference, kind: 'held', reason: 'coinbase-immature' })
  }
  if (typeof utxo.scriptHex !== 'string' || !/^[0-9a-f]+$/.test(utxo.scriptHex)) {
    throw new Error('Invalid Dash UTXO script')
  }
  const spendable: DashSpendableUtxo = Object.freeze({
    ...reference,
    kind: 'spendable',
    scriptHex: utxo.scriptHex
  })
  return spendable
}

export function collectDashSpendableUtxos(
  observations: readonly DashDiscoveryObservation[]
): readonly DashSpendableUtxo[] {
  const seen = new Set<string>()
  const spendable: DashSpendableUtxo[] = []
  for (const observation of observations) {
    for (const utxo of observation.utxos) {
      if (utxo.kind !== 'spendable') continue
      const key = dashOutpointKey(utxo.transactionId, utxo.outputIndex)
      if (seen.has(key)) throw new Error('Duplicate Dash UTXO')
      seen.add(key)
      spendable.push(utxo)
    }
  }
  return Object.freeze(spendable)
}

export function summarizeDashObservations(
  observations: readonly DashDiscoveryObservation[],
  reservedOutpoints: ReadonlySet<string>
): DashBalanceTotals {
  const seen = new Set<string>()
  let total = 0n
  let spendable = 0n
  let available = 0n
  let pending = 0n
  for (const observation of observations) {
    for (const utxo of observation.utxos) {
      const key = dashOutpointKey(utxo.transactionId, utxo.outputIndex)
      if (seen.has(key)) throw new Error('Duplicate Dash UTXO')
      seen.add(key)
      const value = parseDashDuffAmount(utxo.valueDuffs)
      total += value
      if (total > DASH_MAX_MONEY_DUFFS) throw new Error('Dash balance exceeds MAX_MONEY')
      if (utxo.kind === 'spendable') {
        spendable += value
        if (!reservedOutpoints.has(key)) available += value
      } else if (utxo.reason === 'unconfirmed') {
        pending += value
      }
    }
  }
  return Object.freeze({ total, spendable, available, pending })
}

export function heldDashUtxos(
  observations: readonly DashDiscoveryObservation[]
): readonly DashHeldUtxo[] {
  return Object.freeze(
    observations.flatMap(observation =>
      observation.utxos.filter((utxo): utxo is DashHeldUtxo => utxo.kind === 'held')
    )
  )
}
