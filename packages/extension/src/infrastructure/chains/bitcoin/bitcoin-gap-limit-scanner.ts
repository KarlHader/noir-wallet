import {
  BITCOIN_DEFAULT_GAP_LIMIT,
  BITCOIN_DEFAULT_MAXIMUM_ADDRESSES_PER_TARGET,
  BITCOIN_DISCOVERY_CHECKPOINT_SCHEMA_VERSION,
  BITCOIN_FIRST_SLICE_DISCOVERY_TARGETS,
  BITCOIN_MAXIMUM_ADDRESSES_PER_TARGET,
  BITCOIN_MAXIMUM_GAP_LIMIT,
  type BitcoinAddressActivity,
  type BitcoinAddressObservation,
  type BitcoinDiscoveryCheckpoint,
  type BitcoinDiscoveryCursor,
  type BitcoinDiscoveryTarget,
  type BitcoinSupportedAddressType,
  type BitcoinUtxo,
  type DerivedBitcoinAddress
} from '@/core/chains/bitcoin'
import type { ChainId } from '@/core/chains/domain'
import { parseChainId } from '@/core/chains/registry'
import type { KeyDomainId } from '@/core/keyring/domain'
import type { BitcoinAddressDerivationPort } from '@/infrastructure/keyring/multichain/bitcoin-derivation-client'
import type { BitcoinDiscoveryRpc } from './bitcoin-esplora-client'

export type BitcoinDiscoveryErrorCode =
  | 'cancelled'
  | 'derivation-failure'
  | 'rpc-failure'
  | 'checkpoint-failure'
  | 'progress-persistence-failure'
  | 'scan-limit-exceeded'

export class BitcoinDiscoveryError extends Error {
  readonly code: BitcoinDiscoveryErrorCode
  readonly checkpoint: BitcoinDiscoveryCheckpoint

  constructor(
    code: BitcoinDiscoveryErrorCode,
    checkpoint: BitcoinDiscoveryCheckpoint,
    message: string
  ) {
    super(message)
    this.name = 'BitcoinDiscoveryError'
    this.code = code
    this.checkpoint = checkpoint
  }
}

export interface BitcoinGapLimitScannerOptions {
  readonly derivation: BitcoinAddressDerivationPort
  readonly rpc: BitcoinDiscoveryRpc
}

export interface ScanBitcoinAccountInput {
  readonly keyDomainId: KeyDomainId
  readonly chainId: ChainId
  readonly accountIndex: number
  readonly targets?: readonly BitcoinDiscoveryTarget[]
  readonly gapLimit?: number
  readonly maximumAddressesPerTarget?: number
  readonly fixedAddressCountPerTarget?: number
  readonly addressType?: BitcoinSupportedAddressType
  readonly checkpoint?: BitcoinDiscoveryCheckpoint
  readonly onProgress?: (
    observation: BitcoinAddressObservation,
    checkpoint: BitcoinDiscoveryCheckpoint
  ) => Promise<void>
  readonly signal?: AbortSignal
}

export interface BitcoinDiscoveryResult {
  readonly checkpoint: BitcoinDiscoveryCheckpoint
  readonly observations: readonly BitcoinAddressObservation[]
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

function parseTargets(value: readonly BitcoinDiscoveryTarget[]): readonly BitcoinDiscoveryTarget[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    throw new Error('Invalid Bitcoin discovery targets')
  }
  const seen = new Set<string>()
  return Object.freeze(
    value.map(target => {
      if (
        !isPlainRecord(target) ||
        !hasExactKeys(target, ['addressType', 'change']) ||
        (target.addressType !== 'p2pkh' &&
          target.addressType !== 'p2sh-p2wpkh' &&
          target.addressType !== 'p2wpkh' &&
          target.addressType !== 'p2tr') ||
        typeof target.change !== 'boolean'
      ) {
        throw new Error('Invalid Bitcoin discovery target')
      }
      const key = `${target.addressType}:${target.change ? 'change' : 'receive'}`
      if (seen.has(key)) throw new Error('Duplicate Bitcoin discovery target')
      seen.add(key)
      return Object.freeze({ addressType: target.addressType, change: target.change })
    })
  )
}

function parseAddressTypeFilter(value: unknown): BitcoinSupportedAddressType | undefined {
  if (value === undefined) return undefined
  if (value !== 'p2pkh' && value !== 'p2sh-p2wpkh' && value !== 'p2wpkh' && value !== 'p2tr') {
    throw new Error('Invalid Bitcoin discovery address type')
  }
  return value
}

function sameTarget(left: BitcoinDiscoveryTarget, right: BitcoinDiscoveryTarget): boolean {
  return left.addressType === right.addressType && left.change === right.change
}

function freezeCheckpoint(
  chainId: ChainId,
  accountIndex: number,
  gapLimit: number,
  maximumAddressesPerTarget: number,
  cursors: readonly BitcoinDiscoveryCursor[]
): BitcoinDiscoveryCheckpoint {
  return Object.freeze({
    schemaVersion: BITCOIN_DISCOVERY_CHECKPOINT_SCHEMA_VERSION,
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
  targets: readonly BitcoinDiscoveryTarget[]
): BitcoinDiscoveryCheckpoint {
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
  value: BitcoinDiscoveryCheckpoint,
  chainId: ChainId,
  accountIndex: number,
  gapLimit: number,
  maximumAddressesPerTarget: number,
  targets: readonly BitcoinDiscoveryTarget[],
  fixedAddressCountPerTarget?: number
): BitcoinDiscoveryCheckpoint {
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
    value.schemaVersion !== BITCOIN_DISCOVERY_CHECKPOINT_SCHEMA_VERSION ||
    value.chainId !== chainId ||
    value.accountIndex !== accountIndex ||
    value.gapLimit !== gapLimit ||
    value.maximumAddressesPerTarget !== maximumAddressesPerTarget ||
    !Array.isArray(value.cursors) ||
    value.cursors.length !== targets.length
  ) {
    throw new Error('Bitcoin discovery checkpoint does not match the scan')
  }

  const cursors = value.cursors.map((cursor, index) => {
    if (
      !isPlainRecord(cursor) ||
      !hasExactKeys(cursor, ['target', 'nextAddressIndex', 'consecutiveUnused', 'complete']) ||
      !isPlainRecord(cursor.target) ||
      !hasExactKeys(cursor.target, ['addressType', 'change']) ||
      (cursor.target.addressType !== 'p2pkh' &&
        cursor.target.addressType !== 'p2sh-p2wpkh' &&
        cursor.target.addressType !== 'p2wpkh' &&
        cursor.target.addressType !== 'p2tr') ||
      typeof cursor.target.change !== 'boolean' ||
      !sameTarget(
        { addressType: cursor.target.addressType, change: cursor.target.change },
        targets[index]
      ) ||
      typeof cursor.complete !== 'boolean'
    ) {
      throw new Error('Invalid Bitcoin discovery checkpoint cursor')
    }
    const nextAddressIndex = parseIndex(
      cursor.nextAddressIndex,
      'Bitcoin discovery next address index',
      maximumAddressesPerTarget
    )
    const consecutiveUnused = parseIndex(
      cursor.consecutiveUnused,
      'Bitcoin discovery unused count',
      gapLimit
    )
    const expectedComplete =
      fixedAddressCountPerTarget === undefined
        ? consecutiveUnused === gapLimit
        : nextAddressIndex === fixedAddressCountPerTarget
    if (cursor.complete !== expectedComplete || consecutiveUnused > nextAddressIndex) {
      throw new Error('Inconsistent Bitcoin discovery checkpoint cursor')
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
  checkpoint: BitcoinDiscoveryCheckpoint,
  index: number,
  cursor: BitcoinDiscoveryCursor
): BitcoinDiscoveryCheckpoint {
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

function cancellation(checkpoint: BitcoinDiscoveryCheckpoint): BitcoinDiscoveryError {
  return new BitcoinDiscoveryError('cancelled', checkpoint, 'Bitcoin discovery was cancelled')
}

export class BitcoinGapLimitScanner {
  constructor(private readonly options: BitcoinGapLimitScannerOptions) {}

  async scan(input: ScanBitcoinAccountInput): Promise<BitcoinDiscoveryResult> {
    const chainId = parseChainId(input.chainId).id
    if (
      chainId !== 'bip122:000000000019d6689c085ae165831e93' &&
      chainId !== 'bip122:000000000933ea01ad0ee984209779ba'
    ) {
      throw new Error('Unsupported Bitcoin discovery chain')
    }
    const accountIndex = parseIndex(input.accountIndex, 'Bitcoin account index', 0x7fffffff)
    const gapLimit = parseIndex(
      input.gapLimit ?? BITCOIN_DEFAULT_GAP_LIMIT,
      'Bitcoin gap limit',
      BITCOIN_MAXIMUM_GAP_LIMIT
    )
    if (gapLimit === 0) throw new Error('Bitcoin gap limit must be positive')
    const maximumAddressesPerTarget = parseIndex(
      input.maximumAddressesPerTarget ?? BITCOIN_DEFAULT_MAXIMUM_ADDRESSES_PER_TARGET,
      'Bitcoin scan limit',
      BITCOIN_MAXIMUM_ADDRESSES_PER_TARGET
    )
    if (maximumAddressesPerTarget < gapLimit) {
      throw new Error('Bitcoin scan limit must cover the gap limit')
    }
    const fixedAddressCountPerTarget =
      input.fixedAddressCountPerTarget === undefined
        ? undefined
        : parseIndex(
            input.fixedAddressCountPerTarget,
            'Bitcoin fixed address count',
            maximumAddressesPerTarget
          )
    if (fixedAddressCountPerTarget === 0) {
      throw new Error('Bitcoin fixed address count must be positive')
    }
    const targets = parseTargets(input.targets ?? BITCOIN_FIRST_SLICE_DISCOVERY_TARGETS)
    const addressType = parseAddressTypeFilter(input.addressType)
    if (addressType !== undefined && !targets.some(target => target.addressType === addressType)) {
      throw new Error('Bitcoin discovery address type is not supported by the active Wallet')
    }
    let checkpoint: BitcoinDiscoveryCheckpoint
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
      throw new BitcoinDiscoveryError(
        'checkpoint-failure',
        fallback,
        'Bitcoin discovery checkpoint is invalid'
      )
    }

    try {
      await this.options.rpc.assertExpectedChain(input.signal)
    } catch {
      if (input.signal?.aborted) throw cancellation(checkpoint)
      throw new BitcoinDiscoveryError(
        'rpc-failure',
        checkpoint,
        'Bitcoin discovery chain attestation failed'
      )
    }

    const observations: BitcoinAddressObservation[] = []
    for (let cursorIndex = 0; cursorIndex < checkpoint.cursors.length; cursorIndex += 1) {
      let cursor = checkpoint.cursors[cursorIndex]
      if (addressType !== undefined && cursor.target.addressType !== addressType) continue
      while (!cursor.complete) {
        if (input.signal?.aborted) throw cancellation(checkpoint)
        if (cursor.nextAddressIndex >= maximumAddressesPerTarget) {
          throw new BitcoinDiscoveryError(
            'scan-limit-exceeded',
            checkpoint,
            'Bitcoin discovery reached the configured address limit'
          )
        }

        let derivedBatch: readonly DerivedBitcoinAddress[]
        try {
          const batchCount = Math.min(gapLimit, maximumAddressesPerTarget - cursor.nextAddressIndex)
          derivedBatch = this.options.derivation.deriveAddresses
            ? await this.options.derivation.deriveAddresses(
                input.keyDomainId,
                {
                  chainId,
                  addressType: cursor.target.addressType,
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
                    addressType: cursor.target.addressType,
                    accountIndex,
                    change: cursor.target.change,
                    addressIndex: cursor.nextAddressIndex
                  },
                  input.signal
                )
              ])
          if (derivedBatch.length === 0 || derivedBatch.length > batchCount) {
            throw new Error('Invalid Bitcoin derivation batch')
          }
        } catch {
          if (input.signal?.aborted) throw cancellation(checkpoint)
          throw new BitcoinDiscoveryError(
            'derivation-failure',
            checkpoint,
            'Bitcoin address derivation failed'
          )
        }

        for (const derived of derivedBatch) {
          if (cursor.complete) break
          if (
            derived.chainId !== chainId ||
            derived.addressType !== cursor.target.addressType ||
            derived.accountIndex !== accountIndex ||
            derived.change !== cursor.target.change ||
            derived.addressIndex !== cursor.nextAddressIndex
          ) {
            throw new BitcoinDiscoveryError(
              'derivation-failure',
              checkpoint,
              'Bitcoin address derivation did not match the scan'
            )
          }

          let activity: BitcoinAddressActivity
          let utxos: readonly BitcoinUtxo[] = Object.freeze([])
          try {
            activity = await this.options.rpc.getAddressActivity(derived.address, input.signal)
            if (activity.used) {
              utxos = await this.options.rpc.getAddressUtxos(derived.address, input.signal)
            }
          } catch {
            if (input.signal?.aborted) throw cancellation(checkpoint)
            throw new BitcoinDiscoveryError(
              'rpc-failure',
              checkpoint,
              'Bitcoin address discovery request failed'
            )
          }

          const observation = Object.freeze({
            derived,
            activity,
            utxos: Object.freeze([...utxos])
          })
          const consecutiveUnused = activity.used ? 0 : cursor.consecutiveUnused + 1
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
              throw new BitcoinDiscoveryError(
                'progress-persistence-failure',
                checkpoint,
                'Bitcoin discovery progress could not be persisted'
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
