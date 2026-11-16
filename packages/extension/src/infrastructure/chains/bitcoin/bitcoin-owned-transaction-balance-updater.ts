import { address, networks, Transaction } from 'bitcoinjs-lib'
import { Buffer } from 'buffer'
import { parseAccountIndex, type AccountIndex, type ChainAccount } from '@/core/accounts/domain'
import { keySourceSupportsChainFamily, resolveKeyDomain } from '@/core/accounts/application'
import type { BitcoinAddressObservation } from '@/core/chains/bitcoin'
import { parseChainId } from '@/core/chains/registry'
import type { TransactionAccountScope } from '@/core/transactions/domain'
import type { StorageV2ReadRepository } from '@/ports/repositories'
import { createRefreshedBitcoinDiscoveryCheckpoint } from './bitcoin-discovery-refresh'
import {
  parseBitcoinInputOutpoints,
  type BitcoinInputOutpoint
} from './bitcoin-input-reservation-model'
import type { BitcoinTransactionObservation } from './bitcoin-transaction-observer'
import type {
  BitcoinDiscoveryRepository,
  BitcoinDiscoveryState
} from './bitcoin-discovery-repository'
import {
  isFixedSingleAddressBitcoinCheckpoint,
  parseScope
} from './bitcoin-discovery-persistence-model'

type BitcoinBalanceStorageRepository = Pick<
  StorageV2ReadRepository,
  'getActivePointer' | 'getSnapshot'
>

interface BitcoinDiscoveryContext {
  readonly chainAccount: ChainAccount
  readonly accountIndex: AccountIndex
}

export interface BitcoinOwnedBroadcastInput {
  readonly scope: TransactionAccountScope
  readonly transactionId: string
  readonly rawTransactionHex: string
  readonly spentOutpoints: readonly BitcoinInputOutpoint[]
}

export interface BitcoinOwnedTransactionBalanceUpdaterOptions {
  readonly storageRepository: BitcoinBalanceStorageRepository
  readonly discoveryRepository: Pick<BitcoinDiscoveryRepository, 'get' | 'putRefresh'>
  readonly chainId: string
  readonly now?: () => number
  readonly onUpdated?: (scope: TransactionAccountScope) => Promise<void> | void
}

export interface BitcoinOwnedBalanceUpdateResult {
  readonly matched: number
  readonly updated: number
  readonly errors: number
}

function parseTransactionHash(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('Invalid Bitcoin transaction hash')
  return value
}

function scopesMatch(left: TransactionAccountScope, right: TransactionAccountScope): boolean {
  return left.keyDomainId === right.keyDomainId && left.accountId === right.accountId
}

function bitcoinNetwork(chainId: string) {
  if (chainId === 'bip122:000000000019d6689c085ae165831e93') return networks.bitcoin
  if (chainId === 'bip122:000000000933ea01ad0ee984209779ba') return networks.testnet
  throw new Error('Bitcoin balance updater requires a supported chain')
}

function outpointKey(value: BitcoinInputOutpoint): string {
  return `${value.transactionId}:${value.outputIndex}`
}

function observationScriptHex(observation: BitcoinAddressObservation, chainId: string): string {
  return address
    .toOutputScript(observation.derived.address, bitcoinNetwork(chainId))
    .toString('hex')
}

export function applyOptimisticBitcoinBroadcast(
  state: BitcoinDiscoveryState,
  input: Omit<BitcoinOwnedBroadcastInput, 'scope'>
): BitcoinDiscoveryState | null {
  const transactionId = parseTransactionHash(input.transactionId)
  const transaction = Transaction.fromHex(input.rawTransactionHex)
  if (transaction.getId() !== transactionId) {
    throw new Error('Bitcoin broadcast transaction bytes do not match the transaction ID')
  }
  const spentOutpoints = parseBitcoinInputOutpoints(input.spentOutpoints)
  const transactionInputs = parseBitcoinInputOutpoints(
    transaction.ins.map(transactionInput => ({
      transactionId: Buffer.from(transactionInput.hash).reverse().toString('hex'),
      outputIndex: transactionInput.index
    }))
  )
  if (JSON.stringify(transactionInputs) !== JSON.stringify(spentOutpoints)) {
    throw new Error('Bitcoin broadcast inputs do not match the committed input reservation')
  }
  const spent = new Set(spentOutpoints.map(outpointKey))
  const outputsByScript = new Map<string, Array<{ outputIndex: number; valueRaw: string }>>()
  transaction.outs.forEach((output, outputIndex) => {
    const script = output.script.toString('hex')
    const matches = outputsByScript.get(script) ?? []
    matches.push({ outputIndex, valueRaw: output.value.toString() })
    outputsByScript.set(script, matches)
  })

  let stateChanged = false
  const observations = state.observations.map(observation => {
    const transactionAlreadyPresent = observation.utxos.some(
      utxo => utxo.transactionId === transactionId
    )
    const retained = observation.utxos.filter(
      utxo => !spent.has(`${utxo.transactionId}:${utxo.outputIndex}`)
    )
    const removedSpentOutput = retained.length !== observation.utxos.length
    const ownedOutputs = outputsByScript.get(
      observationScriptHex(observation, state.chainAccount.scope.chainId)
    )
    const known = new Set(retained.map(utxo => `${utxo.transactionId}:${utxo.outputIndex}`))
    const added = (ownedOutputs ?? []).flatMap(output => {
      const key = `${transactionId}:${output.outputIndex}`
      if (known.has(key)) return []
      known.add(key)
      return [
        Object.freeze({
          transactionId,
          outputIndex: output.outputIndex,
          valueRaw: output.valueRaw,
          status: Object.freeze({ confirmed: false as const })
        })
      ]
    })
    if (!removedSpentOutput && added.length === 0) return observation

    stateChanged = true
    const incrementActivity = !transactionAlreadyPresent
    const confirmedTransactionCount = observation.activity.confirmedTransactionCount
    const mempoolTransactionCount =
      observation.activity.mempoolTransactionCount + (incrementActivity ? 1 : 0)
    return Object.freeze({
      ...observation,
      activity: Object.freeze({
        confirmedTransactionCount,
        mempoolTransactionCount,
        used: confirmedTransactionCount + mempoolTransactionCount > 0
      }),
      utxos: Object.freeze([...retained, ...added])
    })
  })
  if (!stateChanged) return null
  return Object.freeze({
    ...state,
    checkpoint: createRefreshedBitcoinDiscoveryCheckpoint(
      state.checkpoint,
      observations,
      isFixedSingleAddressBitcoinCheckpoint(state.checkpoint)
    ),
    observations: Object.freeze(observations)
  })
}

export function applyBitcoinTransactionObservation(
  state: BitcoinDiscoveryState,
  observation: BitcoinTransactionObservation
): BitcoinDiscoveryState | null {
  let stateChanged = false
  const confirmedStatus =
    observation.status === 'broadcast'
      ? null
      : Object.freeze({
          confirmed: true as const,
          blockHeight: observation.blockHeight,
          blockHash: observation.blockHash
        })
  const confirmed = confirmedStatus !== null
  const observations = state.observations.map(addressObservation => {
    const transactionUtxos = addressObservation.utxos.filter(
      utxo => utxo.transactionId === observation.transactionId
    )
    if (transactionUtxos.length === 0) return addressObservation
    const previouslyConfirmed = transactionUtxos.every(utxo => utxo.status.confirmed)
    if (previouslyConfirmed === confirmed) return addressObservation

    stateChanged = true
    const confirmedTransactionCount = Math.max(
      0,
      addressObservation.activity.confirmedTransactionCount + (confirmed ? 1 : -1)
    )
    const mempoolTransactionCount = Math.max(
      0,
      addressObservation.activity.mempoolTransactionCount + (confirmed ? -1 : 1)
    )
    return Object.freeze({
      ...addressObservation,
      activity: Object.freeze({
        confirmedTransactionCount,
        mempoolTransactionCount,
        used: confirmedTransactionCount + mempoolTransactionCount > 0
      }),
      utxos: Object.freeze(
        addressObservation.utxos.map(utxo => {
          if (utxo.transactionId !== observation.transactionId) return utxo
          return Object.freeze({
            ...utxo,
            status: confirmedStatus ?? Object.freeze({ confirmed: false as const })
          })
        })
      )
    })
  })
  if (!stateChanged) return null
  return Object.freeze({ ...state, observations: Object.freeze(observations) })
}

export class BitcoinOwnedTransactionBalanceUpdater {
  private readonly chainId: string
  private readonly now: () => number

  constructor(private readonly options: BitcoinOwnedTransactionBalanceUpdaterOptions) {
    this.chainId = parseChainId(options.chainId).id
    bitcoinNetwork(this.chainId)
    this.now = options.now ?? Date.now
  }

  async applyBroadcast(
    input: BitcoinOwnedBroadcastInput
  ): Promise<BitcoinOwnedBalanceUpdateResult> {
    const contexts = await this.loadContexts()
    const senderContexts = contexts.filter(context =>
      scopesMatch(context.chainAccount.scope, input.scope)
    )
    if (senderContexts.length !== 1) {
      throw new Error('Bitcoin broadcast sender Account is missing or ambiguous')
    }
    const senderState = await this.options.discoveryRepository.get(senderContexts[0])
    if (!senderState) throw new Error('Bitcoin broadcast sender discovery state is missing')
    const senderOutpoints = new Set(
      senderState.observations.flatMap(observation =>
        observation.utxos.map(utxo => `${utxo.transactionId}:${utxo.outputIndex}`)
      )
    )
    if (input.spentOutpoints.some(outpoint => !senderOutpoints.has(outpointKey(outpoint)))) {
      throw new Error('Bitcoin broadcast input is not owned by the sender discovery state')
    }
    const settled = await Promise.allSettled(
      contexts.map(async context => {
        const state = scopesMatch(context.chainAccount.scope, input.scope)
          ? senderState
          : await this.options.discoveryRepository.get(context)
        if (!state) return false
        const optimistic = applyOptimisticBitcoinBroadcast(state, input)
        if (!optimistic) return false
        await this.persist(context, optimistic)
        return true
      })
    )
    return this.result(settled)
  }

  async applyObservation(
    observation: BitcoinTransactionObservation
  ): Promise<BitcoinOwnedBalanceUpdateResult> {
    const contexts = await this.loadContexts()
    const settled = await Promise.allSettled(
      contexts.map(async context => {
        const state = await this.options.discoveryRepository.get(context)
        if (!state) return false
        const updated = applyBitcoinTransactionObservation(state, observation)
        if (!updated) return false
        await this.persist(context, updated)
        return true
      })
    )
    return this.result(settled)
  }

  private async persist(
    context: BitcoinDiscoveryContext,
    state: Pick<BitcoinDiscoveryState, 'checkpoint' | 'observations'>
  ): Promise<void> {
    await this.options.discoveryRepository.putRefresh({
      ...context,
      checkpoint: state.checkpoint,
      observations: state.observations,
      updatedAt: this.now()
    })
    await this.options.onUpdated?.(context.chainAccount.scope)
  }

  private result(
    settled: readonly PromiseSettledResult<boolean>[]
  ): BitcoinOwnedBalanceUpdateResult {
    return Object.freeze({
      matched: settled.filter(result => result.status === 'fulfilled').length,
      updated: settled.filter(result => result.status === 'fulfilled' && result.value).length,
      errors: settled.filter(result => result.status === 'rejected').length
    })
  }

  private async loadContexts(): Promise<readonly BitcoinDiscoveryContext[]> {
    const pointer = await this.options.storageRepository.getActivePointer()
    if (!pointer) return Object.freeze([])
    const snapshot = await this.options.storageRepository.getSnapshot(pointer.generationId)
    if (!snapshot) throw new Error('Active Storage V2 generation is missing')
    if (
      snapshot.manifest.status !== 'verified' ||
      snapshot.manifest.generationId !== pointer.generationId ||
      snapshot.manifest.sourceFingerprint !== pointer.sourceFingerprint
    ) {
      throw new Error('Active Storage V2 generation does not match its pointer')
    }

    const contexts: BitcoinDiscoveryContext[] = []
    for (const chainAccount of snapshot.chainAccounts) {
      if (chainAccount.scope.chainId !== this.chainId) continue
      const keyDomain = resolveKeyDomain(snapshot.keyDomains, chainAccount.scope.keyDomainId)
      if (!keySourceSupportsChainFamily(keyDomain.source, 'bitcoin')) continue
      const accounts = snapshot.accounts.filter(
        account =>
          account.keyDomainId === chainAccount.scope.keyDomainId &&
          account.id === chainAccount.scope.accountId
      )
      if (accounts.length !== 1) {
        throw new Error('Bitcoin Account metadata is missing or ambiguous')
      }
      const accountIndex = parseAccountIndex(accounts[0].accountIndex)
      contexts.push(
        Object.freeze({
          chainAccount: parseScope({ chainAccount, accountIndex }).chainAccount,
          accountIndex
        })
      )
    }
    return Object.freeze(contexts)
  }
}
