import {
  PEARL_DEFAULT_GAP_LIMIT,
  PEARL_DEFAULT_MAXIMUM_ADDRESSES_PER_TARGET,
  PEARL_DISCOVERY_CHECKPOINT_SCHEMA_VERSION,
  PEARL_DISCOVERY_TARGETS,
  PEARL_MAXIMUM_ADDRESSES_PER_TARGET,
  PEARL_MAXIMUM_GAP_LIMIT,
  isPearlAddressUsed,
  type PearlAddressActivity,
  type PearlAddressObservation,
  type PearlDiscoveryCheckpoint,
  type PearlDiscoveryCursor,
  type PearlDiscoveryTarget,
  type PearlUtxo,
  type DerivedPearlAddress
} from '@/core/chains/pearl'
import type { ChainId } from '@/core/chains/domain'
import { getPearlChainId, parseChainId } from '@/core/chains/registry'
import type { KeyDomainId } from '@/core/keyring/domain'
import type { PearlAddressDerivationPort } from '@/infrastructure/keyring/multichain/pearl-derivation-client'
import type { PearlDiscoveryRpc } from './pearl-blockbook-client'

export type PearlDiscoveryErrorCode =
  | 'cancelled'
  | 'derivation-failure'
  | 'rpc-failure'
  | 'checkpoint-failure'
  | 'progress-persistence-failure'
  | 'scan-limit-exceeded'

export class PearlDiscoveryError extends Error {
  readonly code: PearlDiscoveryErrorCode
  readonly checkpoint: PearlDiscoveryCheckpoint

  constructor(
    code: PearlDiscoveryErrorCode,
    checkpoint: PearlDiscoveryCheckpoint,
    message: string
  ) {
    super(message)
    this.name = 'PearlDiscoveryError'
    this.code = code
    this.checkpoint = checkpoint
  }
}

export interface PearlGapLimitScannerOptions {
  readonly derivation: PearlAddressDerivationPort
  readonly rpc: PearlDiscoveryRpc
}

export interface ScanPearlAccountInput {
  readonly keyDomainId: KeyDomainId
  readonly chainId: ChainId
  readonly accountIndex: number
  readonly targets?: readonly PearlDiscoveryTarget[]
  readonly gapLimit?: number
  readonly maximumAddressesPerTarget?: number
  readonly fixedAddressCountPerTarget?: number
  readonly checkpoint?: PearlDiscoveryCheckpoint
  readonly onProgress?: (
    observation: PearlAddressObservation,
    checkpoint: PearlDiscoveryCheckpoint
  ) => Promise<void>
  readonly signal?: AbortSignal
}

export interface PearlDiscoveryResult {
  readonly checkpoint: PearlDiscoveryCheckpoint
  readonly observations: readonly PearlAddressObservation[]
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value)
  return (
    actual.length === expected.length &&
    expected.every(key => Object.prototype.hasOwnProperty.call(value, key))
  )
}

function parseIndex(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`Invalid ${label}`)
  }
  return value as number
}

function parseTargets(value: readonly PearlDiscoveryTarget[]): readonly PearlDiscoveryTarget[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) {
    throw new Error('Invalid Pearl discovery targets')
  }
  const seen = new Set<string>()
  return Object.freeze(
    value.map(target => {
      if (
        !isPlainRecord(target) ||
        !hasExactKeys(target, ['change']) ||
        typeof target.change !== 'boolean'
      ) {
        throw new Error('Invalid Pearl discovery target')
      }
      const key = target.change ? 'change' : 'receive'
      if (seen.has(key)) throw new Error('Duplicate Pearl discovery target')
      seen.add(key)
      return Object.freeze({ change: target.change })
    })
  )
}

function sameTarget(left: PearlDiscoveryTarget, right: PearlDiscoveryTarget): boolean {
  return left.change === right.change
}

function freezeCheckpoint(
  chainId: ChainId,
  accountIndex: number,
  gapLimit: number,
  maximumAddressesPerTarget: number,
  cursors: readonly PearlDiscoveryCursor[]
): PearlDiscoveryCheckpoint {
  return Object.freeze({
    schemaVersion: PEARL_DISCOVERY_CHECKPOINT_SCHEMA_VERSION,
    chainId,
    accountIndex,
    gapLimit,
    maximumAddressesPerTarget,
    cursors: Object.freeze(
      cursors.map(cursor =>
        Object.freeze({
          target: Object.freeze({ ...cursor.target }),
          nextAddressIndex: cursor.nextAddressIndex,
          consecutiveUnused: cursor.consecutiveUnused,
          complete: cursor.complete
        })
      )
    )
  })
}

function initialCheckpoint(
  chainId: ChainId,
  accountIndex: number,
  gapLimit: number,
  maximumAddressesPerTarget: number,
  targets: readonly PearlDiscoveryTarget[]
): PearlDiscoveryCheckpoint {
  return freezeCheckpoint(
    chainId,
    accountIndex,
    gapLimit,
    maximumAddressesPerTarget,
    targets.map(target => ({
      target,
      nextAddressIndex: 0,
      consecutiveUnused: 0,
      complete: false
    }))
  )
}

function parseCheckpoint(
  value: PearlDiscoveryCheckpoint,
  chainId: ChainId,
  accountIndex: number,
  gapLimit: number,
  maximumAddressesPerTarget: number,
  targets: readonly PearlDiscoveryTarget[],
  fixedAddressCountPerTarget?: number
): PearlDiscoveryCheckpoint {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'chainId',
      'accountIndex',
      'gapLimit',
      'maximumAddressesPerTarget',
      'cursors'
    ]) ||
    value.schemaVersion !== PEARL_DISCOVERY_CHECKPOINT_SCHEMA_VERSION ||
    value.chainId !== chainId ||
    value.accountIndex !== accountIndex ||
    value.gapLimit !== gapLimit ||
    value.maximumAddressesPerTarget !== maximumAddressesPerTarget ||
    !Array.isArray(value.cursors) ||
    value.cursors.length !== targets.length
  ) {
    throw new Error('Pearl discovery checkpoint does not match the scan')
  }

  const cursors = value.cursors.map((cursor, index) => {
    if (
      !isPlainRecord(cursor) ||
      !hasExactKeys(cursor, ['target', 'nextAddressIndex', 'consecutiveUnused', 'complete']) ||
      !isPlainRecord(cursor.target) ||
      !hasExactKeys(cursor.target, ['change']) ||
      typeof cursor.target.change !== 'boolean' ||
      !sameTarget({ change: cursor.target.change }, targets[index]) ||
      typeof cursor.complete !== 'boolean'
    ) {
      throw new Error('Invalid Pearl discovery checkpoint cursor')
    }
    const nextAddressIndex = parseIndex(
      cursor.nextAddressIndex,
      'Pearl discovery next address index',
      maximumAddressesPerTarget
    )
    const consecutiveUnused = parseIndex(
      cursor.consecutiveUnused,
      'Pearl discovery unused count',
      gapLimit
    )
    const expectedComplete =
      fixedAddressCountPerTarget === undefined
        ? consecutiveUnused === gapLimit
        : nextAddressIndex === fixedAddressCountPerTarget
    if (cursor.complete !== expectedComplete || consecutiveUnused > nextAddressIndex) {
      throw new Error('Inconsistent Pearl discovery checkpoint cursor')
    }
    return Object.freeze({
      target: targets[index],
      nextAddressIndex,
      consecutiveUnused,
      complete: cursor.complete
    })
  })
  return freezeCheckpoint(chainId, accountIndex, gapLimit, maximumAddressesPerTarget, cursors)
}

function replaceCursor(
  checkpoint: PearlDiscoveryCheckpoint,
  index: number,
  cursor: PearlDiscoveryCursor
): PearlDiscoveryCheckpoint {
  const cursors = [...checkpoint.cursors]
  cursors[index] = cursor
  return freezeCheckpoint(
    checkpoint.chainId,
    checkpoint.accountIndex,
    checkpoint.gapLimit,
    checkpoint.maximumAddressesPerTarget,
    cursors
  )
}

function cancellation(checkpoint: PearlDiscoveryCheckpoint): PearlDiscoveryError {
  return new PearlDiscoveryError('cancelled', checkpoint, 'Pearl discovery was cancelled')
}

export class PearlGapLimitScanner {
  constructor(private readonly options: PearlGapLimitScannerOptions) {}

  async scan(input: ScanPearlAccountInput): Promise<PearlDiscoveryResult> {
    const chainId = parseChainId(input.chainId).id
    if (chainId !== getPearlChainId('mainnet') && chainId !== getPearlChainId('testnet')) {
      throw new Error('Unsupported Pearl discovery chain')
    }
    const accountIndex = parseIndex(input.accountIndex, 'Pearl account index', 0x7fffffff)
    const gapLimit = parseIndex(
      input.gapLimit ?? PEARL_DEFAULT_GAP_LIMIT,
      'Pearl gap limit',
      PEARL_MAXIMUM_GAP_LIMIT
    )
    if (gapLimit === 0) throw new Error('Pearl gap limit must be positive')
    const maximumAddressesPerTarget = parseIndex(
      input.maximumAddressesPerTarget ?? PEARL_DEFAULT_MAXIMUM_ADDRESSES_PER_TARGET,
      'Pearl scan limit',
      PEARL_MAXIMUM_ADDRESSES_PER_TARGET
    )
    if (maximumAddressesPerTarget < gapLimit) {
      throw new Error('Pearl scan limit must cover the gap limit')
    }
    const fixedAddressCountPerTarget =
      input.fixedAddressCountPerTarget === undefined
        ? undefined
        : parseIndex(
            input.fixedAddressCountPerTarget,
            'Pearl fixed address count',
            maximumAddressesPerTarget
          )
    if (fixedAddressCountPerTarget === 0) {
      throw new Error('Pearl fixed address count must be positive')
    }
    const targets = parseTargets(input.targets ?? PEARL_DISCOVERY_TARGETS)
    let checkpoint: PearlDiscoveryCheckpoint
    try {
      checkpoint = input.checkpoint
        ? parseCheckpoint(
            input.checkpoint,
            chainId,
            accountIndex,
            gapLimit,
            maximumAddressesPerTarget,
            targets,
            fixedAddressCountPerTarget
          )
        : initialCheckpoint(chainId, accountIndex, gapLimit, maximumAddressesPerTarget, targets)
    } catch {
      const fallback = initialCheckpoint(
        chainId,
        accountIndex,
        gapLimit,
        maximumAddressesPerTarget,
        targets
      )
      throw new PearlDiscoveryError(
        'checkpoint-failure',
        fallback,
        'Pearl discovery checkpoint is invalid'
      )
    }

    try {
      await this.options.rpc.assertExpectedChain(input.signal)
    } catch {
      if (input.signal?.aborted) throw cancellation(checkpoint)
      throw new PearlDiscoveryError(
        'rpc-failure',
        checkpoint,
        'Pearl discovery chain attestation failed'
      )
    }

    const observations: PearlAddressObservation[] = []
    for (let cursorIndex = 0; cursorIndex < checkpoint.cursors.length; cursorIndex += 1) {
      let cursor = checkpoint.cursors[cursorIndex]
      while (!cursor.complete) {
        if (input.signal?.aborted) throw cancellation(checkpoint)
        if (cursor.nextAddressIndex >= maximumAddressesPerTarget) {
          throw new PearlDiscoveryError(
            'scan-limit-exceeded',
            checkpoint,
            'Pearl discovery reached the configured address limit'
          )
        }

        let derivedBatch: readonly DerivedPearlAddress[]
        try {
          const batchCount = Math.min(gapLimit, maximumAddressesPerTarget - cursor.nextAddressIndex)
          derivedBatch = this.options.derivation.deriveAddresses
            ? await this.options.derivation.deriveAddresses(
                input.keyDomainId,
                {
                  chainId,
                  accountIndex,
                  change: cursor.target.change,
                  startAddressIndex: cursor.nextAddressIndex,
                  count: batchCount
                },
                input.signal
              )
            : Object.freeze([
                await this.options.derivation.deriveAddress(
                  input.keyDomainId,
                  {
                    chainId,
                    accountIndex,
                    change: cursor.target.change,
                    addressIndex: cursor.nextAddressIndex
                  },
                  input.signal
                )
              ])
          if (derivedBatch.length === 0 || derivedBatch.length > batchCount) {
            throw new Error('Invalid Pearl derivation batch')
          }
        } catch {
          if (input.signal?.aborted) throw cancellation(checkpoint)
          throw new PearlDiscoveryError(
            'derivation-failure',
            checkpoint,
            'Pearl address derivation failed'
          )
        }

        for (const derived of derivedBatch) {
          if (cursor.complete) break
          if (
            derived.chainId !== chainId ||
            derived.addressScheme !== 'pearl_p2tr' ||
            derived.accountIndex !== accountIndex ||
            derived.change !== cursor.target.change ||
            derived.addressIndex !== cursor.nextAddressIndex
          ) {
            throw new PearlDiscoveryError(
              'derivation-failure',
              checkpoint,
              'Pearl address derivation did not match the scan'
            )
          }

          let activity: PearlAddressActivity
          let utxos: readonly PearlUtxo[] = Object.freeze([])
          try {
            activity = await this.options.rpc.getAddressActivity(derived.address, input.signal)
            if (isPearlAddressUsed(activity)) {
              utxos = await this.options.rpc.getAddressUtxos(derived.address, input.signal)
            }
          } catch {
            if (input.signal?.aborted) throw cancellation(checkpoint)
            throw new PearlDiscoveryError(
              'rpc-failure',
              checkpoint,
              'Pearl address discovery request failed'
            )
          }

          const observation = Object.freeze({
            derived,
            activity,
            utxos: Object.freeze([...utxos])
          })
          const used = isPearlAddressUsed(activity)
          const consecutiveUnused = used ? 0 : cursor.consecutiveUnused + 1
          const nextAddressIndex = cursor.nextAddressIndex + 1
          cursor = Object.freeze({
            target: cursor.target,
            nextAddressIndex,
            consecutiveUnused,
            complete:
              fixedAddressCountPerTarget === undefined
                ? consecutiveUnused === gapLimit
                : nextAddressIndex === fixedAddressCountPerTarget
          })
          const nextCheckpoint = replaceCursor(checkpoint, cursorIndex, cursor)
          if (input.onProgress) {
            try {
              await input.onProgress(observation, nextCheckpoint)
            } catch {
              throw new PearlDiscoveryError(
                'progress-persistence-failure',
                checkpoint,
                'Pearl discovery progress could not be persisted'
              )
            }
          }
          observations.push(observation)
          checkpoint = nextCheckpoint
        }
      }
    }

    return Object.freeze({
      checkpoint,
      observations: Object.freeze(observations)
    })
  }
}
