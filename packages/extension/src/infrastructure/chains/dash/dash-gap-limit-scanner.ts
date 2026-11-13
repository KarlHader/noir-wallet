import type { KeyDomainId } from '@/core/keyring/domain'
import type {
  DashAddressDerivationPort,
  DerivedDashAddress
} from '@/infrastructure/keyring/multichain/dash-derivation-client'
import { DASH_GAP_LIMIT, DASH_LOOKAHEAD_ADDRESSES, DASH_MAX_ADDRESSES_PER_CHAIN } from './config'
import type { DashInsightRpc, DashTransaction, DashUtxo } from './dash-insight-client'
import {
  dashAddressPath,
  initialDashCheckpoint,
  parseDashP2pkhAddress,
  type DashDerivedAddress,
  type DashDiscoveryCheckpoint,
  type DashDiscoveryCursor,
  type DashDiscoveryObservation,
  type DashDiscoveryScope,
  type DashObservedTransaction
} from './dash-discovery-model'
import { classifyDashUtxo } from './dash-spendable-utxos'

export type DashDiscoveryErrorCode =
  | 'cancelled'
  | 'derivation-failure'
  | 'rpc-failure'
  | 'checkpoint-failure'
  | 'progress-persistence-failure'
  | 'scan-limit-exceeded'

export class DashDiscoveryError extends Error {
  readonly code: DashDiscoveryErrorCode
  readonly checkpoint: DashDiscoveryCheckpoint
  readonly cause?: unknown

  constructor(
    code: DashDiscoveryErrorCode,
    checkpoint: DashDiscoveryCheckpoint,
    message: string,
    cause?: unknown
  ) {
    super(message)
    this.name = 'DashDiscoveryError'
    this.code = code
    this.checkpoint = checkpoint
    if (cause !== undefined) this.cause = cause
  }
}

export interface DashGapLimitScannerOptions {
  readonly derivation: DashAddressDerivationPort
  readonly rpc: Pick<
    DashInsightRpc,
    'assertExpectedChain' | 'getAddressTransactions' | 'getAddressUtxos' | 'getTransaction'
  >
}

export interface ScanDashAccountInput {
  readonly keyDomainId: KeyDomainId
  readonly scope: DashDiscoveryScope
  readonly checkpoint?: DashDiscoveryCheckpoint
  readonly observations?: readonly DashDiscoveryObservation[]
  readonly onProgress?: (
    observation: DashDiscoveryObservation,
    checkpoint: DashDiscoveryCheckpoint
  ) => Promise<void>
  readonly signal?: AbortSignal
}

export interface DashDiscoveryScanResult {
  readonly checkpoint: DashDiscoveryCheckpoint
  readonly observations: readonly DashDiscoveryObservation[]
}

function cancellation(checkpoint: DashDiscoveryCheckpoint): DashDiscoveryError {
  return new DashDiscoveryError('cancelled', checkpoint, 'Dash discovery was cancelled')
}

function replaceCursor(
  checkpoint: DashDiscoveryCheckpoint,
  change: boolean,
  cursor: DashDiscoveryCursor
): DashDiscoveryCheckpoint {
  return Object.freeze({
    ...checkpoint,
    cursors: Object.freeze(checkpoint.cursors.map(item => (item.change === change ? cursor : item)))
  })
}

function observationKey(observation: DashDiscoveryObservation): string {
  return `${observation.derived.change ? 1 : 0}:${observation.derived.addressIndex}`
}

function summary(transaction: DashTransaction): DashObservedTransaction {
  return Object.freeze({
    transactionId: transaction.transactionId,
    type: transaction.type,
    isCoinbase: transaction.isCoinbase,
    confirmations: transaction.confirmations
  })
}

export class DashGapLimitScanner {
  constructor(private readonly options: DashGapLimitScannerOptions) {}

  async scan(input: ScanDashAccountInput): Promise<DashDiscoveryScanResult> {
    const scope = input.scope
    let checkpoint = input.checkpoint ?? initialDashCheckpoint(scope)
    if (
      checkpoint.chainId !== scope.chainAccount.scope.chainId ||
      checkpoint.imported !== scope.imported ||
      checkpoint.gapLimit !== DASH_GAP_LIMIT ||
      checkpoint.accountIndex !== scope.accountIndex
    ) {
      throw new DashDiscoveryError(
        'checkpoint-failure',
        initialDashCheckpoint(scope),
        'Dash discovery checkpoint does not match the account'
      )
    }
    try {
      await this.options.rpc.assertExpectedChain(input.signal)
    } catch (error) {
      if (input.signal?.aborted) throw cancellation(checkpoint)
      throw new DashDiscoveryError(
        'rpc-failure',
        checkpoint,
        'Dash discovery chain attestation failed',
        error
      )
    }

    const observations = new Map<string, DashDiscoveryObservation>()
    for (const observation of input.observations ?? []) {
      observations.set(observationKey(observation), observation)
    }

    for (const cursor of checkpoint.cursors) {
      let active = cursor
      while (!active.complete) {
        if (input.signal?.aborted) throw cancellation(checkpoint)
        if (scope.imported && (active.change || active.nextAddressIndex > 0)) {
          throw new DashDiscoveryError(
            'checkpoint-failure',
            checkpoint,
            'Imported Dash keys cannot be scanned as an HD chain'
          )
        }
        if (active.nextAddressIndex >= DASH_MAX_ADDRESSES_PER_CHAIN) {
          throw new DashDiscoveryError(
            'scan-limit-exceeded',
            checkpoint,
            'Dash discovery reached the configured address limit'
          )
        }
        const derived = await this.derive(input, active, checkpoint)
        const existing = observations.get(`${active.change ? 1 : 0}:${active.nextAddressIndex}`)
        const resume =
          existing !== undefined &&
          !existing.historyComplete &&
          existing.pagesFetched === active.nextPage &&
          active.nextPage > 0
            ? existing
            : null
        let pagesFetched = resume?.pagesFetched ?? 0
        let pagesTotal = resume?.pagesTotal ?? null
        let transactions = [...(resume?.transactions ?? [])]
        const seen = new Set(transactions.map(transaction => transaction.transactionId))

        while (pagesTotal === null || (pagesTotal > 0 && pagesFetched < pagesTotal)) {
          if (input.signal?.aborted) throw cancellation(checkpoint)
          let page: Awaited<ReturnType<DashInsightRpc['getAddressTransactions']>>
          try {
            page = await this.options.rpc.getAddressTransactions(
              derived.address,
              pagesFetched,
              input.signal
            )
          } catch (error) {
            if (input.signal?.aborted) throw cancellation(checkpoint)
            throw new DashDiscoveryError(
              'rpc-failure',
              checkpoint,
              'Dash address history request failed',
              error
            )
          }
          if (pagesTotal !== null && page.pagesTotal !== pagesTotal) {
            throw new DashDiscoveryError(
              'rpc-failure',
              checkpoint,
              'Dash address history changed page count during a scan'
            )
          }
          pagesTotal = page.pagesTotal
          for (const transaction of page.transactions) {
            if (seen.has(transaction.transactionId)) continue
            seen.add(transaction.transactionId)
            transactions.push(summary(transaction))
          }
          pagesFetched += 1
          if (pagesTotal === 0) break
          if (pagesFetched < pagesTotal) {
            const partial = this.observation(
              derived,
              pagesFetched,
              pagesTotal,
              false,
              transactions,
              []
            )
            active = Object.freeze({
              ...active,
              nextPage: pagesFetched,
              complete: false
            })
            checkpoint = replaceCursor(checkpoint, active.change, active)
            await this.persist(input, partial, checkpoint)
            observations.set(observationKey(partial), partial)
          }
        }

        const settledPages = pagesTotal ?? 0
        let utxos: DashDiscoveryObservation['utxos'] = []
        if (transactions.length > 0) {
          try {
            utxos = await this.classifyUtxos(
              derived.address,
              transactions,
              checkpoint,
              input.signal
            )
          } catch (error) {
            if (error instanceof DashDiscoveryError) throw error
            if (input.signal?.aborted) throw cancellation(checkpoint)
            throw new DashDiscoveryError(
              'rpc-failure',
              checkpoint,
              'Dash UTXO request failed',
              error
            )
          }
        }
        const used = transactions.length > 0
        const nextAddressIndex = active.nextAddressIndex + 1
        const consecutiveUnused = used ? 0 : active.consecutiveUnused + 1
        const complete = scope.imported
          ? nextAddressIndex === 1
          : consecutiveUnused === DASH_GAP_LIMIT
        active = Object.freeze({
          change: active.change,
          nextAddressIndex,
          consecutiveUnused,
          complete,
          nextPage: 0
        })
        checkpoint = replaceCursor(checkpoint, active.change, active)
        const settled = this.observation(
          derived,
          settledPages === 0 ? 1 : pagesFetched,
          settledPages,
          true,
          transactions,
          utxos
        )
        await this.persist(input, settled, checkpoint)
        observations.set(observationKey(settled), settled)
      }
    }

    return Object.freeze({
      checkpoint,
      observations: Object.freeze([...observations.values()])
    })
  }

  async reload(
    observations: readonly DashDiscoveryObservation[],
    signal?: AbortSignal
  ): Promise<readonly DashDiscoveryObservation[]> {
    if (signal?.aborted) throw new Error('Dash discovery was cancelled')
    await this.options.rpc.assertExpectedChain(signal)
    if (observations.length === 0) return Object.freeze([])
    const fetched = await this.options.rpc.getAddressUtxos(
      observations.map(observation => observation.derived.address),
      signal
    )
    const known = new Map<string, DashObservedTransaction>()
    const reloaded: DashDiscoveryObservation[] = []
    for (const observation of observations) {
      const collected = await this.collectUtxos(observation.derived.address, fetched, known, signal)
      reloaded.push(
        Object.freeze({
          ...observation,
          transactions: Object.freeze(
            collected.transactions.length > 0 ? collected.transactions : observation.transactions
          ),
          utxos: collected.utxos,
          historyComplete: true
        })
      )
    }
    return Object.freeze(reloaded)
  }

  /**
   * Batch-derives the next lookahead window and returns addresses that still
   * hold a UTXO. Callers persist those observations directly: a completed gap
   * cursor cannot be reopened from inside a scan progress write.
   */
  async probeAhead(input: {
    readonly keyDomainId: KeyDomainId
    readonly scope: DashDiscoveryScope
    readonly checkpoint: DashDiscoveryCheckpoint
    readonly cursor: DashDiscoveryCursor
    readonly signal?: AbortSignal
  }): Promise<readonly DashDerivedAddress[]> {
    if (input.scope.imported) return Object.freeze([])
    if (input.signal?.aborted) throw cancellation(input.checkpoint)
    const start = input.cursor.nextAddressIndex
    if (start >= DASH_MAX_ADDRESSES_PER_CHAIN) return Object.freeze([])
    const count = Math.min(DASH_LOOKAHEAD_ADDRESSES, DASH_MAX_ADDRESSES_PER_CHAIN - start)
    const scanInput: ScanDashAccountInput = {
      keyDomainId: input.keyDomainId,
      scope: input.scope,
      checkpoint: input.checkpoint,
      signal: input.signal
    }
    let derived: readonly DashDerivedAddress[]
    try {
      derived = await this.deriveRange(
        scanInput,
        input.cursor.change,
        start,
        count,
        input.checkpoint
      )
    } catch (error) {
      if (error instanceof DashDiscoveryError) throw error
      if (input.signal?.aborted) throw cancellation(input.checkpoint)
      throw new DashDiscoveryError(
        'derivation-failure',
        input.checkpoint,
        'Dash address derivation failed',
        error
      )
    }
    let fetched: readonly DashUtxo[]
    try {
      fetched = await this.options.rpc.getAddressUtxos(
        derived.map(address => address.address),
        input.signal
      )
    } catch (error) {
      if (input.signal?.aborted) throw cancellation(input.checkpoint)
      throw new DashDiscoveryError(
        'rpc-failure',
        input.checkpoint,
        'Dash UTXO request failed',
        error
      )
    }
    const funded = new Set(fetched.map(utxo => utxo.address))
    return Object.freeze(derived.filter(address => funded.has(address.address)))
  }

  async observeDerived(
    derived: DashDerivedAddress,
    signal?: AbortSignal
  ): Promise<DashDiscoveryObservation> {
    if (signal?.aborted) throw new Error('Dash discovery was cancelled')
    const fetched = await this.options.rpc.getAddressUtxos([derived.address], signal)
    const collected = await this.collectUtxos(derived.address, fetched, new Map(), signal)
    const hasHistory = collected.transactions.length > 0
    return this.observation(
      derived,
      1,
      hasHistory ? 1 : 0,
      true,
      collected.transactions,
      collected.utxos
    )
  }

  private async derive(
    input: ScanDashAccountInput,
    cursor: DashDiscoveryCursor,
    checkpoint: DashDiscoveryCheckpoint
  ): Promise<DashDerivedAddress> {
    const scope = input.scope
    if (scope.imported && (cursor.change || cursor.nextAddressIndex !== 0)) {
      throw new DashDiscoveryError(
        'derivation-failure',
        checkpoint,
        'Imported Dash keys cannot be scanned as an HD chain'
      )
    }
    try {
      const derived = await this.options.derivation.deriveAddress(
        input.keyDomainId,
        {
          chainId: scope.chainAccount.scope.chainId,
          accountIndex: scope.accountIndex,
          change: cursor.change,
          addressIndex: cursor.nextAddressIndex
        },
        input.signal
      )
      return this.acceptDerived(derived, scope, cursor.change, cursor.nextAddressIndex)
    } catch (error) {
      if (error instanceof DashDiscoveryError) throw error
      if (input.signal?.aborted) throw cancellation(checkpoint)
      throw new DashDiscoveryError(
        'derivation-failure',
        checkpoint,
        'Dash address derivation failed',
        error
      )
    }
  }

  private async deriveRange(
    input: ScanDashAccountInput,
    change: boolean,
    startAddressIndex: number,
    count: number,
    checkpoint: DashDiscoveryCheckpoint
  ): Promise<readonly DashDerivedAddress[]> {
    const scope = input.scope
    const derivation = this.options.derivation
    if (!derivation.deriveAddresses) {
      const sequential: DashDerivedAddress[] = []
      for (let offset = 0; offset < count; offset += 1) {
        sequential.push(
          await this.derive(
            input,
            {
              change,
              nextAddressIndex: startAddressIndex + offset,
              consecutiveUnused: 0,
              complete: false,
              nextPage: 0
            },
            checkpoint
          )
        )
      }
      return Object.freeze(sequential)
    }
    const derived = await derivation.deriveAddresses(
      input.keyDomainId,
      {
        chainId: scope.chainAccount.scope.chainId,
        accountIndex: scope.accountIndex,
        change,
        startAddressIndex,
        count
      },
      input.signal
    )
    if (derived.length !== count)
      throw new Error('Derived Dash account batch has an invalid length')
    return Object.freeze(
      derived.map((address, offset) =>
        this.acceptDerived(address, scope, change, startAddressIndex + offset)
      )
    )
  }

  private acceptDerived(
    derived: DerivedDashAddress,
    scope: DashDiscoveryScope,
    change: boolean,
    addressIndex: number
  ): DashDerivedAddress {
    const path = dashAddressPath(
      scope.chainAccount.scope.chainId,
      scope.accountIndex,
      change,
      addressIndex,
      scope.imported
    )
    if (
      derived.chainId !== scope.chainAccount.scope.chainId ||
      derived.network !== scope.network ||
      derived.accountIndex !== scope.accountIndex ||
      derived.change !== change ||
      derived.addressIndex !== addressIndex ||
      derived.addressScheme !== 'dash_p2pkh' ||
      derived.derivationScheme !== (scope.imported ? 'imported' : 'bip44') ||
      derived.derivationPath !== path ||
      !/^0x0[23][0-9a-f]{64}$/.test(derived.publicKey) ||
      !/^0x76a914[0-9a-f]{40}88ac$/.test(derived.scriptPubKey)
    ) {
      throw new Error('Derived Dash address does not match the scan')
    }
    return Object.freeze({
      chainId: derived.chainId,
      network: derived.network,
      accountIndex: derived.accountIndex,
      change: derived.change,
      addressIndex: derived.addressIndex,
      address: parseDashP2pkhAddress(derived.address, derived.chainId),
      scheme: 'dash_p2pkh',
      purpose: derived.change ? 'change' : 'receive',
      privacy: 'transparent',
      derivationScheme: derived.derivationScheme,
      derivationPath: derived.derivationPath,
      publicKey: derived.publicKey,
      scriptPubKey: derived.scriptPubKey
    })
  }

  private async classifyUtxos(
    address: string,
    transactions: readonly DashObservedTransaction[],
    checkpoint: DashDiscoveryCheckpoint,
    signal?: AbortSignal
  ): Promise<DashDiscoveryObservation['utxos']> {
    const fetched = await this.options.rpc.getAddressUtxos([address], signal)
    const known = new Map(transactions.map(transaction => [transaction.transactionId, transaction]))
    const collected = await this.collectUtxos(address, fetched, known, signal)
    if (checkpoint.imported && collected.utxos.length > 10_000) {
      throw new DashDiscoveryError('rpc-failure', checkpoint, 'Dash UTXO response is too large')
    }
    return collected.utxos
  }

  private async collectUtxos(
    address: string,
    fetched: readonly DashUtxo[],
    known: Map<string, DashObservedTransaction>,
    signal?: AbortSignal
  ): Promise<{
    readonly transactions: readonly DashObservedTransaction[]
    readonly utxos: DashDiscoveryObservation['utxos']
  }> {
    const transactions: DashObservedTransaction[] = []
    const seen = new Set<string>()
    const utxos = []
    for (const utxo of fetched) {
      if (utxo.address !== address) continue
      let transaction = known.get(utxo.transactionId)
      if (!transaction) {
        const loaded = await this.options.rpc.getTransaction(utxo.transactionId, signal)
        transaction = summary(loaded)
        known.set(transaction.transactionId, transaction)
      }
      if (!seen.has(transaction.transactionId)) {
        seen.add(transaction.transactionId)
        transactions.push(transaction)
      }
      utxos.push(
        transaction.type === 0
          ? classifyDashUtxo(utxo, transaction)
          : classifyDashUtxo(
              {
                transactionId: utxo.transactionId,
                outputIndex: utxo.outputIndex,
                valueDuffs: utxo.valueDuffs,
                confirmations: utxo.confirmations,
                ...(utxo.height === undefined ? {} : { height: utxo.height }),
                scriptHex: ''
              },
              transaction
            )
      )
    }
    return { transactions: Object.freeze(transactions), utxos: Object.freeze(utxos) }
  }

  private observation(
    derived: DashDerivedAddress,
    pagesFetched: number,
    pagesTotal: number,
    historyComplete: boolean,
    transactions: readonly DashObservedTransaction[],
    utxos: DashDiscoveryObservation['utxos']
  ): DashDiscoveryObservation {
    return Object.freeze({
      derived,
      pagesFetched,
      pagesTotal,
      historyComplete,
      transactions: Object.freeze([...transactions]),
      utxos: Object.freeze([...utxos])
    })
  }

  private async persist(
    input: ScanDashAccountInput,
    observation: DashDiscoveryObservation,
    checkpoint: DashDiscoveryCheckpoint
  ): Promise<void> {
    if (!input.onProgress) return
    try {
      await input.onProgress(observation, checkpoint)
    } catch (error) {
      throw new DashDiscoveryError(
        'progress-persistence-failure',
        checkpoint,
        'Dash discovery progress could not be persisted',
        error
      )
    }
  }
}
