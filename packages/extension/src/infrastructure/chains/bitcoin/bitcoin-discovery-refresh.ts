import type {
  BitcoinAddressObservation,
  BitcoinDiscoveryCheckpoint,
  BitcoinSupportedAddressType
} from '@/core/chains/bitcoin'
import type { BitcoinDiscoveryRpc } from './bitcoin-esplora-client'
import { BitcoinDiscoveryError } from './bitcoin-gap-limit-scanner'
import { parseObservation } from './bitcoin-discovery-persistence-observation'
import {
  isFixedSingleAddressBitcoinCheckpoint,
  parseCheckpoint,
  parseScope,
  sameJson,
  targetKey,
  type BitcoinDiscoveryState
} from './bitcoin-discovery-persistence-model'

const DEFAULT_REFRESH_CONCURRENCY = 1
const MAXIMUM_REFRESH_CONCURRENCY = 8

export const BITCOIN_DISCOVERY_REFRESH_MODES = Object.freeze(['full', 'active'] as const)
export type BitcoinDiscoveryRefreshMode = (typeof BITCOIN_DISCOVERY_REFRESH_MODES)[number]

export interface BitcoinDiscoveryRefresherOptions {
  readonly rpc: BitcoinDiscoveryRpc
  readonly concurrency?: number
}

export interface RefreshBitcoinDiscoveryInput {
  readonly state: BitcoinDiscoveryState
  readonly mode?: BitcoinDiscoveryRefreshMode
  readonly addressType?: BitcoinSupportedAddressType
  readonly signal?: AbortSignal
}

export interface BitcoinDiscoveryRefreshResult {
  readonly checkpoint: BitcoinDiscoveryCheckpoint
  readonly observations: readonly BitcoinAddressObservation[]
}

function parseConcurrency(value: number | undefined): number {
  const concurrency = value ?? DEFAULT_REFRESH_CONCURRENCY
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency <= 0 ||
    concurrency > MAXIMUM_REFRESH_CONCURRENCY
  ) {
    throw new Error('Invalid Bitcoin discovery refresh concurrency')
  }
  return concurrency
}

function cancellation(checkpoint: BitcoinDiscoveryCheckpoint): BitcoinDiscoveryError {
  return new BitcoinDiscoveryError(
    'cancelled',
    checkpoint,
    'Bitcoin discovery refresh was cancelled'
  )
}

function createCursorObservations(
  checkpoint: BitcoinDiscoveryCheckpoint,
  observations: readonly BitcoinAddressObservation[]
): ReadonlyMap<string, ReadonlyMap<number, BitcoinAddressObservation>> {
  const byTarget = new Map<string, Map<number, BitcoinAddressObservation>>()
  for (const observation of observations) {
    const key = targetKey(observation.derived)
    const byIndex = byTarget.get(key) ?? new Map<number, BitcoinAddressObservation>()
    if (byIndex.has(observation.derived.addressIndex)) {
      throw new Error('Duplicate Bitcoin discovery refresh address index')
    }
    byIndex.set(observation.derived.addressIndex, observation)
    byTarget.set(key, byIndex)
  }
  for (const cursor of checkpoint.cursors) {
    const key = targetKey(cursor.target)
    const byIndex = byTarget.get(key) ?? new Map<number, BitcoinAddressObservation>()
    if (byIndex.size !== cursor.nextAddressIndex) {
      throw new Error('Bitcoin discovery refresh does not cover its checkpoint')
    }
    for (let index = 0; index < cursor.nextAddressIndex; index += 1) {
      if (!byIndex.has(index)) {
        throw new Error('Bitcoin discovery refresh contains an address gap')
      }
    }
    byTarget.delete(key)
    byTarget.set(key, byIndex)
  }
  if (byTarget.size !== checkpoint.cursors.length) {
    throw new Error('Bitcoin discovery refresh contains an unknown target')
  }
  return byTarget
}

export function createRefreshedBitcoinDiscoveryCheckpoint(
  checkpoint: BitcoinDiscoveryCheckpoint,
  observations: readonly BitcoinAddressObservation[],
  fixedAddressSet = false
): BitcoinDiscoveryCheckpoint {
  const byTarget = createCursorObservations(checkpoint, observations)
  const cursors = checkpoint.cursors.map(cursor => {
    const byIndex = byTarget.get(targetKey(cursor.target))
    if (!byIndex) throw new Error('Bitcoin discovery refresh target is missing')
    let consecutiveUnused = 0
    for (let index = cursor.nextAddressIndex - 1; index >= 0; index -= 1) {
      const observation = byIndex.get(index)
      if (!observation) throw new Error('Bitcoin discovery refresh address is missing')
      if (observation.activity.used || consecutiveUnused === checkpoint.gapLimit) break
      consecutiveUnused += 1
    }
    return Object.freeze({
      target: cursor.target,
      nextAddressIndex: cursor.nextAddressIndex,
      consecutiveUnused,
      complete: fixedAddressSet
        ? cursor.nextAddressIndex === checkpoint.maximumAddressesPerTarget
        : consecutiveUnused === checkpoint.gapLimit
    })
  })
  return Object.freeze({
    ...checkpoint,
    cursors: Object.freeze(cursors)
  })
}

export function assertBitcoinDiscoveryRefreshTransition(
  previous: BitcoinDiscoveryState,
  checkpoint: BitcoinDiscoveryCheckpoint,
  observations: readonly BitcoinAddressObservation[]
): void {
  if (observations.length !== previous.observations.length) {
    throw new Error('Bitcoin discovery refresh cannot add or remove addresses')
  }
  const previousByPath = new Map(
    previous.observations.map(observation => [
      `${targetKey(observation.derived)}:${observation.derived.addressIndex}`,
      observation
    ])
  )
  for (const observation of observations) {
    const pathKey = `${targetKey(observation.derived)}:${observation.derived.addressIndex}`
    const existing = previousByPath.get(pathKey)
    if (!existing || !sameJson(existing.derived, observation.derived)) {
      throw new Error('Bitcoin discovery refresh cannot change derived address identity')
    }
    previousByPath.delete(pathKey)
  }
  if (previousByPath.size > 0) {
    throw new Error('Bitcoin discovery refresh omitted a derived address')
  }
  const expected = createRefreshedBitcoinDiscoveryCheckpoint(
    previous.checkpoint,
    observations,
    isFixedSingleAddressBitcoinCheckpoint(previous.checkpoint)
  )
  if (!sameJson(checkpoint, expected)) {
    throw new Error('Bitcoin discovery refresh checkpoint does not match refreshed activity')
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>
): Promise<readonly R[]> {
  const results: Array<R | undefined> = new Array(values.length)
  let nextIndex = 0
  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await operation(values[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()))
  return Object.freeze(results.filter((result): result is R => result !== undefined))
}

function observationPathKey(observation: BitcoinAddressObservation): string {
  return `${targetKey(observation.derived)}:${observation.derived.addressIndex}`
}

function selectRefreshObservations(
  checkpoint: BitcoinDiscoveryCheckpoint,
  observations: readonly BitcoinAddressObservation[],
  mode: BitcoinDiscoveryRefreshMode,
  addressType?: BitcoinSupportedAddressType
): readonly BitcoinAddressObservation[] {
  if (mode === 'full') return observations
  const eligible =
    addressType === undefined
      ? observations
      : observations.filter(observation => observation.derived.addressType === addressType)
  if (addressType !== undefined) {
    return eligible.filter(
      observation => observation.derived.change === false && observation.derived.addressIndex === 0
    )
  }
  const frontierByTarget = new Map<string, number>()
  for (const cursor of checkpoint.cursors.filter(
    cursor => addressType === undefined || cursor.target.addressType === addressType
  )) {
    const matching = eligible.filter(
      observation => targetKey(observation.derived) === targetKey(cursor.target)
    )
    const highestUsedIndex = matching.reduce(
      (highest, observation) =>
        observation.activity.used ? Math.max(highest, observation.derived.addressIndex) : highest,
      -1
    )
    const frontier = highestUsedIndex + 1
    if (frontier < cursor.nextAddressIndex) frontierByTarget.set(targetKey(cursor.target), frontier)
  }
  return eligible.filter(
    observation =>
      observation.derived.addressIndex === 0 ||
      observation.activity.used ||
      observation.utxos.length > 0 ||
      observation.derived.addressIndex === frontierByTarget.get(targetKey(observation.derived))
  )
}

export class BitcoinDiscoveryRefresher {
  private readonly rpc: BitcoinDiscoveryRpc
  private readonly concurrency: number

  constructor(options: BitcoinDiscoveryRefresherOptions) {
    this.rpc = options.rpc
    this.concurrency = parseConcurrency(options.concurrency)
  }

  async refresh(input: RefreshBitcoinDiscoveryInput): Promise<BitcoinDiscoveryRefreshResult> {
    const scope = parseScope({
      chainAccount: input.state.chainAccount,
      accountIndex: input.state.accountIndex
    })
    const checkpoint = parseCheckpoint(input.state.checkpoint, scope)
    const observations = input.state.observations.map(observation =>
      parseObservation(observation, scope)
    )
    const mode = input.mode ?? 'full'
    if (!BITCOIN_DISCOVERY_REFRESH_MODES.includes(mode)) {
      throw new Error('Invalid Bitcoin discovery refresh mode')
    }
    const fixedAddressSet = isFixedSingleAddressBitcoinCheckpoint(checkpoint)
    createRefreshedBitcoinDiscoveryCheckpoint(checkpoint, observations, fixedAddressSet)
    if (input.signal?.aborted) throw cancellation(checkpoint)
    try {
      await this.rpc.assertExpectedChain(input.signal)
      const selected = selectRefreshObservations(checkpoint, observations, mode, input.addressType)
      const refreshedSelection = await mapWithConcurrency(
        selected,
        this.concurrency,
        async observation => {
          if (input.signal?.aborted) throw cancellation(checkpoint)
          // A Bitcoin address stays used forever. Preserve that monotonic discovery fact and
          // refresh its UTXOs directly so routine balance reconciliation needs one public call.
          if (observation.activity.used) {
            const utxos = await this.rpc.getAddressUtxos(observation.derived.address, input.signal)
            return parseObservation(
              Object.freeze({
                derived: observation.derived,
                activity: observation.activity,
                utxos: Object.freeze([...utxos])
              }),
              scope
            )
          }
          const activity = await this.rpc.getAddressActivity(
            observation.derived.address,
            input.signal
          )
          const utxos = activity.used
            ? await this.rpc.getAddressUtxos(observation.derived.address, input.signal)
            : Object.freeze([])
          return parseObservation(
            Object.freeze({
              derived: observation.derived,
              activity,
              utxos: Object.freeze([...utxos])
            }),
            scope
          )
        }
      )
      const refreshedByPath = new Map(
        refreshedSelection.map(observation => [observationPathKey(observation), observation])
      )
      const refreshed = Object.freeze(
        observations.map(
          observation => refreshedByPath.get(observationPathKey(observation)) ?? observation
        )
      )
      return Object.freeze({
        checkpoint: createRefreshedBitcoinDiscoveryCheckpoint(
          checkpoint,
          refreshed,
          fixedAddressSet
        ),
        observations: refreshed
      })
    } catch (error) {
      if (error instanceof BitcoinDiscoveryError) throw error
      if (input.signal?.aborted) throw cancellation(checkpoint)
      throw new BitcoinDiscoveryError(
        'rpc-failure',
        checkpoint,
        'Bitcoin discovery refresh request failed'
      )
    }
  }
}
