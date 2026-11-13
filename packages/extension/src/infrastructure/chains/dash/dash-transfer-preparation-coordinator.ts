import { parseTransactionId, type TransactionId } from '@/core/transactions/domain'
import type { DashAddressDerivationPort } from '@/infrastructure/keyring/multichain/dash-derivation-client'
import {
  nextDashChangeStartIndex,
  type DashChangeReservation,
  type DashChangeReservationRepository
} from './dash-change-reservation-model'
import { selectDashCoins } from './dash-coin-selection'
import { dashOutpointKey, collectDashSpendableUtxos } from './dash-spendable-utxos'
import {
  parseDashDiscoveryScope,
  type DashDiscoveryRepository,
  type DashDiscoveryScope,
  type DashDiscoveryState
} from './dash-discovery-model'
import {
  type DashInputReservation,
  type DashInputReservationRepository
} from './dash-input-reservation-model'
import { buildDashPsbt } from './dash-psbt-builder'
import {
  failInvalidDashTransaction,
  isPlainRecord,
  parseDashChain,
  parseDashFeeRate,
  parseDashRecipient,
  parseDashTransferAmount,
  type DashCoinSelection,
  type DashSelectableUtxo,
  type PreparedDashPsbt
} from './dash-transaction-model'

export interface PrepareDashTransferFromDiscoveryInput extends DashDiscoveryScope {
  readonly transactionId: TransactionId
  readonly recipient: string
  readonly amount:
    | { readonly mode: 'exact'; readonly valueDuffs: string }
    | { readonly mode: 'max' }
  readonly signal?: AbortSignal
}

export interface PreparedDashTransferPlan {
  readonly transactionId: TransactionId
  readonly signerAddress: string
  readonly masterFingerprint: string
  readonly selection: DashCoinSelection
  readonly inputReservation: DashInputReservation
  readonly changeReservation: DashChangeReservation | null
  readonly prepared: PreparedDashPsbt
}

export class DashTransferPreparationCoordinator {
  constructor(
    private readonly options: {
      readonly discoveryRepository: Pick<DashDiscoveryRepository, 'get'>
      readonly derivation: DashAddressDerivationPort
      readonly rpc: {
        readonly getNetworkFeeRate: (signal?: AbortSignal) => Promise<string>
        readonly getRawTransaction: (transactionId: string, signal?: AbortSignal) => Promise<string>
      }
      readonly inputReservations: Pick<
        DashInputReservationRepository,
        'list' | 'reserve' | 'release'
      >
      readonly changeReservations: Pick<
        DashChangeReservationRepository,
        'list' | 'allocate' | 'bindAddress' | 'transition'
      >
      readonly now?: () => number
    }
  ) {}

  async prepare(input: PrepareDashTransferFromDiscoveryInput): Promise<PreparedDashTransferPlan> {
    if (!isPlainRecord(input)) failInvalidDashTransaction('Invalid Dash transfer preparation input')
    const scope = parseDashDiscoveryScope(input)
    const transactionId = parseTransactionId(input.transactionId)
    const chainId = parseDashChain(scope.chainAccount.scope.chainId)
    const recipient = parseDashRecipient(input.recipient, chainId)
    const amount = parseDashTransferAmount(input.amount)
    if (input.signal?.aborted) throw new Error('Dash transfer preparation was cancelled')
    const state = await this.options.discoveryRepository.get(scope)
    if (state === null) throw new Error('Dash discovery must complete before spending')
    assertReceiveDiscoveryComplete(state)
    const signerObservation = state.observations.find(
      observation => !observation.derived.change && observation.derived.addressIndex === 0
    )
    if (
      !signerObservation ||
      signerObservation.derived.address !== scope.chainAccount.identity.value
    ) {
      throw new Error('Dash signer address does not match the selected account')
    }
    const reserved = new Set(
      (await this.options.inputReservations.list(scope)).flatMap(reservation =>
        reservation.state === 'reserved' || reservation.state === 'committed'
          ? reservation.outpoints.map(outpoint =>
              dashOutpointKey(outpoint.transactionId, outpoint.outputIndex)
            )
          : []
      )
    )
    const spendable = collectDashSpendableUtxos(state.observations).filter(
      utxo => !reserved.has(dashOutpointKey(utxo.transactionId, utxo.outputIndex))
    )
    const feeRate = parseDashFeeRate(await this.options.rpc.getNetworkFeeRate(input.signal))
    let fingerprint: string | null = null
    const selectable: DashSelectableUtxo[] = []
    for (const utxo of spendable) {
      const observation = state.observations.find(candidate =>
        candidate.utxos.some(
          candidateUtxo =>
            candidateUtxo.transactionId === utxo.transactionId &&
            candidateUtxo.outputIndex === utxo.outputIndex
        )
      )
      if (!observation || observation.derived.scheme !== 'dash_p2pkh') {
        failInvalidDashTransaction('Dash UTXO is missing its discovered address')
      }
      const derived = await this.options.derivation.deriveAddress(
        scope.chainAccount.scope.keyDomainId,
        {
          chainId,
          accountIndex: scope.accountIndex,
          change: observation.derived.change,
          addressIndex: observation.derived.addressIndex
        },
        input.signal
      )
      if (
        derived.address !== observation.derived.address ||
        derived.publicKey !== observation.derived.publicKey ||
        derived.derivationPath !== observation.derived.derivationPath ||
        derived.addressScheme !== 'dash_p2pkh'
      ) {
        failInvalidDashTransaction('Dash UTXO origin does not match the selected account')
      }
      if (fingerprint === null) fingerprint = derived.masterFingerprint
      if (derived.masterFingerprint !== fingerprint) {
        failInvalidDashTransaction('Dash UTXO fingerprints do not match')
      }
      selectable.push({
        chainId,
        accountIndex: scope.accountIndex,
        imported: scope.imported,
        change: observation.derived.change,
        addressIndex: observation.derived.addressIndex,
        address: observation.derived.address,
        derivationPath: observation.derived.derivationPath,
        publicKey: derived.publicKey,
        scriptHex: utxo.scriptHex,
        transactionId: utxo.transactionId,
        outputIndex: utxo.outputIndex,
        valueDuffs: utxo.valueDuffs,
        rawTransactionHex: await this.options.rpc.getRawTransaction(
          utxo.transactionId,
          input.signal
        )
      })
    }
    if (fingerprint === null) throw new Error('No spendable Dash UTXOs')
    const selection = selectDashCoins({
      chainId,
      accountIndex: scope.accountIndex,
      imported: scope.imported,
      recipient,
      amount,
      feeRateDuffsPerKb: feeRate,
      utxos: selectable
    })
    const now = this.options.now?.() ?? Date.now()
    const inputReservation = await this.options.inputReservations.reserve({
      ...scope,
      transactionId,
      outpoints: selection.selectedUtxos.map(utxo => ({
        transactionId: utxo.transactionId,
        outputIndex: utxo.outputIndex
      })),
      now
    })
    let changeReservation: DashChangeReservation | null = null
    try {
      let change: { address: string; derivationPath: string; publicKey: string } | undefined
      if (BigInt(selection.changeDuffs) > 0n) {
        const minimumAddressIndex = nextDashChangeStartIndex(state.observations)
        changeReservation = await this.options.changeReservations.allocate({
          ...scope,
          transactionId,
          minimumAddressIndex,
          now
        })
        const derivedChange = await this.options.derivation.deriveAddress(
          scope.chainAccount.scope.keyDomainId,
          {
            chainId,
            accountIndex: scope.accountIndex,
            change: true,
            addressIndex: changeReservation.addressIndex
          },
          input.signal
        )
        if (
          derivedChange.masterFingerprint !== fingerprint ||
          derivedChange.addressScheme !== 'dash_p2pkh'
        ) {
          failInvalidDashTransaction('Dash change address does not belong to the selected account')
        }
        changeReservation = await this.options.changeReservations.bindAddress({
          ...scope,
          transactionId,
          now,
          address: {
            chainId,
            network: scope.network,
            accountIndex: scope.accountIndex,
            change: true,
            addressIndex: changeReservation.addressIndex,
            address: derivedChange.address,
            scheme: 'dash_p2pkh',
            purpose: 'change',
            privacy: 'transparent',
            derivationScheme: 'bip44',
            derivationPath: derivedChange.derivationPath,
            publicKey: derivedChange.publicKey,
            scriptPubKey: derivedChange.scriptPubKey
          }
        })
        change = {
          address: derivedChange.address,
          derivationPath: derivedChange.derivationPath,
          publicKey: derivedChange.publicKey
        }
      }
      const prepared = buildDashPsbt({ selection, masterFingerprint: fingerprint, change })
      return Object.freeze({
        transactionId,
        signerAddress: signerObservation.derived.address,
        masterFingerprint: fingerprint,
        selection,
        inputReservation,
        changeReservation,
        prepared
      })
    } catch (error) {
      await this.options.inputReservations.release(scope, transactionId).catch(() => undefined)
      if (changeReservation) {
        await this.options.changeReservations
          .transition({ ...scope, transactionId, state: 'abandoned', now })
          .catch(() => undefined)
      }
      throw error
    }
  }
}

function assertReceiveDiscoveryComplete(state: DashDiscoveryState): void {
  const receive = state.checkpoint.cursors.find(cursor => !cursor.change)
  if (!receive?.complete)
    throw new Error('Dash receive address discovery must complete before spending')
}
