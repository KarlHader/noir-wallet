import { address, networks, Transaction } from 'bitcoinjs-lib'
import { Buffer } from 'buffer'
import { parseAccountIndex, type AccountIndex, type ChainAccount } from '@/core/accounts/domain'
import { keySourceSupportsChainFamily, resolveKeyDomain } from '@/core/accounts/application'
import type { PearlAddressObservation } from '@/core/chains/pearl'
import { parseChainId } from '@/core/chains/registry'
import type { TransactionAccountScope } from '@/core/transactions/domain'
import type { StorageV2ReadRepository } from '@/ports/repositories'
import { createRefreshedPearlDiscoveryCheckpoint } from './pearl-discovery-refresh'
import { parsePearlInputOutpoints, type PearlInputOutpoint } from './pearl-input-reservation-model'
import type { PearlTransactionObservation } from './pearl-transaction-observer'
import type { PearlDiscoveryRepository, PearlDiscoveryState } from './pearl-discovery-repository'
import {
  isFixedSingleAddressPearlCheckpoint,
  parseScope
} from './pearl-discovery-persistence-model'

type PearlBalanceStorageRepository = Pick<
  StorageV2ReadRepository,
  'getActivePointer' | 'getSnapshot'
>

interface PearlDiscoveryContext {
  readonly chainAccount: ChainAccount
  readonly accountIndex: AccountIndex
}

export interface PearlOwnedBroadcastInput {
  readonly scope: TransactionAccountScope
  readonly transactionId: string
  readonly rawTransactionHex: string
  readonly spentOutpoints: readonly PearlInputOutpoint[]
}

export interface PearlOwnedTransactionBalanceUpdaterOptions {
  readonly storageRepository: PearlBalanceStorageRepository
  readonly discoveryRepository: Pick<PearlDiscoveryRepository, 'get' | 'putRefresh'>
  readonly chainId: string
  readonly now?: () => number
  readonly onUpdated?: (scope: TransactionAccountScope) => Promise<void> | void
}

export interface PearlOwnedBalanceUpdateResult {
  readonly matched: number
  readonly updated: number
  readonly errors: number
}

function parseTransactionHash(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('Invalid Pearl transaction hash')
  return value
}

function scopesMatch(left: TransactionAccountScope, right: TransactionAccountScope): boolean {
  return left.keyDomainId === right.keyDomainId && left.accountId === right.accountId
}

function pearlNetwork(chainId: string) {
  if (chainId === 'bip122:a18d3093b7ff618f0cdd073fa3d10374')
    return networks.bitcoin /* pearl uses custom network via pearlBitcoinJsNetwork */
  if (chainId === 'bip122:b0c86d0cd8825f4d72260d2de46f4704') return networks.testnet
  throw new Error('Pearl balance updater requires a supported chain')
}

function outpointKey(value: PearlInputOutpoint): string {
  return `${value.transactionId}:${value.outputIndex}`
}

function observationScriptHex(observation: PearlAddressObservation, chainId: string): string {
  return address.toOutputScript(observation.derived.address, pearlNetwork(chainId)).toString('hex')
}

export function applyOptimisticPearlBroadcast(
  state: PearlDiscoveryState,
  input: Omit<PearlOwnedBroadcastInput, 'scope'>
): PearlDiscoveryState | null {
  const transactionId = parseTransactionHash(input.transactionId)
  const transaction = Transaction.fromHex(input.rawTransactionHex)
  if (transaction.getId() !== transactionId) {
    throw new Error('Pearl broadcast transaction bytes do not match the transaction ID')
  }
  const spentOutpoints = parsePearlInputOutpoints(input.spentOutpoints)
  const transactionInputs = parsePearlInputOutpoints(
    transaction.ins.map(transactionInput => ({
      transactionId: Buffer.from(transactionInput.hash).reverse().toString('hex'),
      outputIndex: transactionInput.index
    }))
  )
  if (JSON.stringify(transactionInputs) !== JSON.stringify(spentOutpoints)) {
    throw new Error('Pearl broadcast inputs do not match the committed input reservation')
  }
  const spent = new Set(spentOutpoints.map(outpointKey))
  const outputsByScript = new Map<string, Array<{ outputIndex: number; valueSats: string }>>()
  transaction.outs.forEach((output, outputIndex) => {
    const script = output.script.toString('hex')
    const matches = outputsByScript.get(script) ?? []
    matches.push({ outputIndex, valueSats: output.value.toString() })
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
          valueSats: output.valueSats,
          address: observation.derived.address,
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
        used: confirmedTransactionCount + mempoolTransactionCount > 0,
        balanceSats: observation.activity.balanceSats
      }),
      utxos: Object.freeze([...retained, ...added])
    })
  })
  if (!stateChanged) return null
  return Object.freeze({
    ...state,
    checkpoint: createRefreshedPearlDiscoveryCheckpoint(
      state.checkpoint,
      observations,
      isFixedSingleAddressPearlCheckpoint(state.checkpoint)
    ),
    observations: Object.freeze(observations)
  })
}

export function applyPearlTransactionObservation(
  state: PearlDiscoveryState,
  observation: PearlTransactionObservation
): PearlDiscoveryState | null {
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
        used: confirmedTransactionCount + mempoolTransactionCount > 0,
        balanceSats: addressObservation.activity.balanceSats
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

export class PearlOwnedTransactionBalanceUpdater {
  private readonly chainId: string
  private readonly now: () => number

  constructor(private readonly options: PearlOwnedTransactionBalanceUpdaterOptions) {
    this.chainId = parseChainId(options.chainId).id
    pearlNetwork(this.chainId)
    this.now = options.now ?? Date.now
  }

  async applyBroadcast(input: PearlOwnedBroadcastInput): Promise<PearlOwnedBalanceUpdateResult> {
    const contexts = await this.loadContexts()
    const senderContexts = contexts.filter(context =>
      scopesMatch(context.chainAccount.scope, input.scope)
    )
    if (senderContexts.length !== 1) {
      throw new Error('Pearl broadcast sender Account is missing or ambiguous')
    }
    const senderState = await this.options.discoveryRepository.get(senderContexts[0])
    if (!senderState) throw new Error('Pearl broadcast sender discovery state is missing')
    const senderOutpoints = new Set(
      senderState.observations.flatMap(observation =>
        observation.utxos.map(utxo => `${utxo.transactionId}:${utxo.outputIndex}`)
      )
    )
    if (input.spentOutpoints.some(outpoint => !senderOutpoints.has(outpointKey(outpoint)))) {
      throw new Error('Pearl broadcast input is not owned by the sender discovery state')
    }
    const settled = await Promise.allSettled(
      contexts.map(async context => {
        const state = scopesMatch(context.chainAccount.scope, input.scope)
          ? senderState
          : await this.options.discoveryRepository.get(context)
        if (!state) return false
        const optimistic = applyOptimisticPearlBroadcast(state, input)
        if (!optimistic) return false
        await this.persist(context, optimistic)
        return true
      })
    )
    return this.result(settled)
  }

  async applyObservation(
    observation: PearlTransactionObservation
  ): Promise<PearlOwnedBalanceUpdateResult> {
    const contexts = await this.loadContexts()
    const settled = await Promise.allSettled(
      contexts.map(async context => {
        const state = await this.options.discoveryRepository.get(context)
        if (!state) return false
        const updated = applyPearlTransactionObservation(state, observation)
        if (!updated) return false
        await this.persist(context, updated)
        return true
      })
    )
    return this.result(settled)
  }

  private async persist(
    context: PearlDiscoveryContext,
    state: Pick<PearlDiscoveryState, 'checkpoint' | 'observations'>
  ): Promise<void> {
    await this.options.discoveryRepository.putRefresh({
      ...context,
      checkpoint: state.checkpoint,
      observations: state.observations,
      updatedAt: this.now()
    })
    await this.options.onUpdated?.(context.chainAccount.scope)
  }

  private result(settled: readonly PromiseSettledResult<boolean>[]): PearlOwnedBalanceUpdateResult {
    return Object.freeze({
      matched: settled.filter(result => result.status === 'fulfilled').length,
      updated: settled.filter(result => result.status === 'fulfilled' && result.value).length,
      errors: settled.filter(result => result.status === 'rejected').length
    })
  }

  private async loadContexts(): Promise<readonly PearlDiscoveryContext[]> {
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

    const contexts: PearlDiscoveryContext[] = []
    for (const chainAccount of snapshot.chainAccounts) {
      if (chainAccount.scope.chainId !== this.chainId) continue
      const keyDomain = resolveKeyDomain(snapshot.keyDomains, chainAccount.scope.keyDomainId)
      if (!keySourceSupportsChainFamily(keyDomain.source, 'pearl')) continue
      const accounts = snapshot.accounts.filter(
        account =>
          account.keyDomainId === chainAccount.scope.keyDomainId &&
          account.id === chainAccount.scope.accountId
      )
      if (accounts.length !== 1) {
        throw new Error('Pearl Account metadata is missing or ambiguous')
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
