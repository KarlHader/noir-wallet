import {
  isPearlAddressUsed,
  type PearlAddressObservation,
  type PearlDiscoveryCheckpoint
} from '@/core/chains/pearl'
import type { PearlDiscoveryRpc } from './pearl-blockbook-client'
import { PearlDiscoveryError } from './pearl-gap-limit-scanner'
import { parseObservation } from './pearl-discovery-persistence-observation'
import {
  isFixedSingleAddressPearlCheckpoint,
  parseCheckpoint,
  parseScope,
  sameJson,
  targetKey,
  type PearlDiscoveryState
} from './pearl-discovery-persistence-model'

const DEFAULT_REFRESH_CONCURRENCY = 1
const MAXIMUM_REFRESH_CONCURRENCY = 8

export const PEARL_DISCOVERY_REFRESH_MODES = Object.freeze(['full', 'active'] as const)
export type PearlDiscoveryRefreshMode = (typeof PEARL_DISCOVERY_REFRESH_MODES)[number]

export interface PearlDiscoveryRefresherOptions {
  readonly rpc: PearlDiscoveryRpc
  readonly concurrency?: number
}

export interface RefreshPearlDiscoveryInput {
  readonly state: PearlDiscoveryState
  readonly mode?: PearlDiscoveryRefreshMode
  readonly signal?: AbortSignal
}

export interface PearlDiscoveryRefreshResult {
  readonly checkpoint: PearlDiscoveryCheckpoint
  readonly observations: readonly PearlAddressObservation[]
}

function parseConcurrency(value: number | undefined): number {
  const concurrency = value ?? DEFAULT_REFRESH_CONCURRENCY
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency <= 0 ||
    concurrency > MAXIMUM_REFRESH_CONCURRENCY
  ) {
    throw new Error('Invalid Pearl discovery refresh concurrency')
  }
  return concurrency
}

function cancellation(checkpoint: PearlDiscoveryCheckpoint): PearlDiscoveryError {
  return new PearlDiscoveryError('cancelled', checkpoint, 'Pearl discovery refresh was cancelled')
}

function createCursorObservations(
  checkpoint: PearlDiscoveryCheckpoint,
  observations: readonly PearlAddressObservation[]
): ReadonlyMap<string, ReadonlyMap<number, PearlAddressObservation>> {
  const byTarget = new Map<string, Map<number, PearlAddressObservation>>()
  for (const observation of observations) {
    const key = targetKey(observation.derived)
    const byIndex = byTarget.get(key) ?? new Map<number, PearlAddressObservation>()
    if (byIndex.has(observation.derived.addressIndex)) {
      throw new Error('Duplicate Pearl discovery refresh address index')
    }
    byIndex.set(observation.derived.addressIndex, observation)
    byTarget.set(key, byIndex)
  }
  for (const cursor of checkpoint.cursors) {
    const key = targetKey(cursor.target)
    const byIndex = byTarget.get(key) ?? new Map<number, PearlAddressObservation>()
    if (byIndex.size !== cursor.nextAddressIndex) {
      throw new Error('Pearl discovery refresh does not cover its checkpoint')
    }
    for (let index = 0; index < cursor.nextAddressIndex; index += 1) {
      if (!byIndex.has(index)) {
        throw new Error('Pearl discovery refresh contains an address gap')
      }
    }
    byTarget.delete(key)
    byTarget.set(key, byIndex)
  }
  if (byTarget.size !== checkpoint.cursors.length) {
    throw new Error('Pearl discovery refresh contains an unknown target')
  }
  return byTarget
}

export function createRefreshedPearlDiscoveryCheckpoint(
  checkpoint: PearlDiscoveryCheckpoint,
  observations: readonly PearlAddressObservation[],
  fixedAddressSet = false
): PearlDiscoveryCheckpoint {
  const byTarget = createCursorObservations(checkpoint, observations)
  const cursors = checkpoint.cursors.map(cursor => {
    const byIndex = byTarget.get(targetKey(cursor.target))
    if (!byIndex) throw new Error('Pearl discovery refresh target is missing')
    let consecutiveUnused = 0
    for (let index = cursor.nextAddressIndex - 1; index >= 0; index -= 1) {
      const observation = byIndex.get(index)
      if (!observation) throw new Error('Pearl discovery refresh address is missing')
      if (isPearlAddressUsed(observation.activity) || consecutiveUnused === checkpoint.gapLimit) {
        break
      }
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

export function assertPearlDiscoveryRefreshTransition(
  previous: PearlDiscoveryState,
  checkpoint: PearlDiscoveryCheckpoint,
  observations: readonly PearlAddressObservation[]
): void {
  if (observations.length !== previous.observations.length) {
    throw new Error('Pearl discovery refresh cannot add or remove addresses')
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
      throw new Error('Pearl discovery refresh cannot change derived address identity')
    }
    previousByPath.delete(pathKey)
  }
  if (previousByPath.size > 0) {
    throw new Error('Pearl discovery refresh omitted a derived address')
  }
  const expected = createRefreshedPearlDiscoveryCheckpoint(
    previous.checkpoint,
    observations,
    isFixedSingleAddressPearlCheckpoint(previous.checkpoint)
  )
  if (!sameJson(checkpoint, expected)) {
    throw new Error('Pearl discovery refresh checkpoint does not match refreshed activity')
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

function observationPathKey(observation: PearlAddressObservation): string {
  return `${targetKey(observation.derived)}:${observation.derived.addressIndex}`
}

function selectRefreshObservations(
  checkpoint: PearlDiscoveryCheckpoint,
  observations: readonly PearlAddressObservation[],
  mode: PearlDiscoveryRefreshMode
): readonly PearlAddressObservation[] {
  if (mode === 'full') return observations
  const frontierByTarget = new Map<string, number>()
  for (const cursor of checkpoint.cursors) {
    const matching = observations.filter(
      observation => targetKey(observation.derived) === targetKey(cursor.target)
    )
    const highestUsedIndex = matching.reduce(
      (highest, observation) =>
        isPearlAddressUsed(observation.activity)
          ? Math.max(highest, observation.derived.addressIndex)
          : highest,
      -1
    )
    const frontier = highestUsedIndex + 1
    if (frontier < cursor.nextAddressIndex) frontierByTarget.set(targetKey(cursor.target), frontier)
  }
  return observations.filter(
    observation =>
      observation.derived.addressIndex === 0 ||
      isPearlAddressUsed(observation.activity) ||
      observation.utxos.length > 0 ||
      observation.derived.addressIndex === frontierByTarget.get(targetKey(observation.derived))
  )
}

export class PearlDiscoveryRefresher {
  private readonly rpc: PearlDiscoveryRpc
  private readonly concurrency: number

  constructor(options: PearlDiscoveryRefresherOptions) {
    this.rpc = options.rpc
    this.concurrency = parseConcurrency(options.concurrency)
  }

  async refresh(input: RefreshPearlDiscoveryInput): Promise<PearlDiscoveryRefreshResult> {
    const scope = parseScope({
      chainAccount: input.state.chainAccount,
      accountIndex: input.state.accountIndex
    })
    const checkpoint = parseCheckpoint(input.state.checkpoint, scope)
    const observations = input.state.observations.map(observation =>
      parseObservation(observation, scope)
    )
    const mode = input.mode ?? 'full'
    if (!PEARL_DISCOVERY_REFRESH_MODES.includes(mode)) {
      throw new Error('Invalid Pearl discovery refresh mode')
    }
    const fixedAddressSet = isFixedSingleAddressPearlCheckpoint(checkpoint)
    createRefreshedPearlDiscoveryCheckpoint(checkpoint, observations, fixedAddressSet)
    if (input.signal?.aborted) throw cancellation(checkpoint)
    try {
      await this.rpc.assertExpectedChain(input.signal)
      const selected = selectRefreshObservations(checkpoint, observations, mode)
      const refreshedSelection = await mapWithConcurrency(
        selected,
        this.concurrency,
        async observation => {
          if (input.signal?.aborted) throw cancellation(checkpoint)
          // A Pearl address stays used forever once it has history. Preserve that fact and
          // refresh UTXOs directly so routine balance reconciliation needs one public call.
          if (isPearlAddressUsed(observation.activity)) {
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
          const utxos = isPearlAddressUsed(activity)
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
        checkpoint: createRefreshedPearlDiscoveryCheckpoint(checkpoint, refreshed, fixedAddressSet),
        observations: refreshed
      })
    } catch (error) {
      if (error instanceof PearlDiscoveryError) throw error
      if (input.signal?.aborted) throw cancellation(checkpoint)
      throw new PearlDiscoveryError(
        'rpc-failure',
        checkpoint,
        'Pearl discovery refresh request failed'
      )
    }
  }
}
