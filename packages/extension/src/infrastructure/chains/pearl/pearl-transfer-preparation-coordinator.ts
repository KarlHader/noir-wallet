import { parseTransactionId, type TransactionId } from '@/core/transactions/domain'
import type { PearlAddressDerivationPort } from '@/infrastructure/keyring/multichain/pearl-derivation-client'
import type { PearlChangeReservation } from './pearl-change-reservation-model'
import type { PearlChangeReservationCoordinator } from './pearl-change-reservation-coordinator'
import { selectPearlCoins, selectPearlFeeRate } from './pearl-coin-selection'
import type { PearlDiscoveryRpc, PearlTransactionRpc } from './pearl-blockbook-client'
import { assertPearlDiscoverySigner } from './pearl-pending-transfer-lifecycle'
import {
  pearlChainAccountsMatch,
  hasExactKeys,
  isRecord,
  parseCheckpoint,
  parseScope,
  parseTimestamp,
  type PearlDiscoveryRepository,
  type PearlDiscoveryScope
} from './pearl-discovery-persistence-model'
import { parseObservation } from './pearl-discovery-persistence-observation'
import {
  parsePearlInputReservation,
  type PearlInputReservation,
  type PearlInputReservationRepository
} from './pearl-input-reservation-model'
import { buildPearlPsbt } from './pearl-psbt-builder'
import { collectPearlSpendableUtxos } from './pearl-spendable-utxos'
import {
  PEARL_DEFAULT_FEE_TARGET_BLOCKS,
  PEARL_MAXIMUM_FEE_TARGET_BLOCKS,
  parsePearlAddress,
  parsePearlChain,
  parsePearlIndex,
  parsePearlFeeRate,
  parsePearlMasterFingerprint,
  parsePearlTransferAmount,
  type PearlChangeOutputPosition,
  type PearlCoinSelection,
  type PearlFeeRateQuote,
  type PearlTransferAmount,
  type PreparedPearlPsbt
} from './pearl-transaction-model'

export interface PearlTransferPreparationRpc extends Pick<
  PearlDiscoveryRpc,
  'assertExpectedChain' | 'getTipHeight'
> {
  readonly getFeeEstimates: PearlTransactionRpc['getFeeEstimates']
}

export interface PearlTransferPreparationCoordinatorOptions {
  readonly discoveryRepository: Pick<PearlDiscoveryRepository, 'get'>
  readonly derivation: PearlAddressDerivationPort
  readonly rpc: PearlTransferPreparationRpc
  readonly inputReservations: Pick<PearlInputReservationRepository, 'list' | 'reserve' | 'release'>
  readonly changeReservations?: Pick<PearlChangeReservationCoordinator, 'reserve' | 'abandon'>
  readonly now?: () => number
  readonly selectChangeOutputPosition?: (
    transactionId: TransactionId
  ) => Promise<PearlChangeOutputPosition> | PearlChangeOutputPosition
}

export interface PreparePearlTransferFromDiscoveryInput extends PearlDiscoveryScope {
  readonly transactionId: TransactionId
  readonly addressScheme: 'pearl_p2tr'
  readonly recipient: string
  readonly amount: PearlTransferAmount
  readonly feeTargetBlocks?: number
  readonly feeRateSatsPerVbyte?: number
  readonly signal?: AbortSignal
  readonly ledgerAccount?: boolean
}

export interface PreparedPearlTransferPlan {
  readonly transactionId: TransactionId
  readonly signerAddress: string
  readonly feeRate: PearlFeeRateQuote
  readonly selection: PearlCoinSelection
  readonly inputReservation: PearlInputReservation
  readonly changeReservation: PearlChangeReservation | null
  readonly prepared: PreparedPearlPsbt
  readonly discoveryUpdatedAt: number
}

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Pearl transfer preparation was cancelled')
}

function assertDiscoveryComplete(
  cursors: ReturnType<typeof parseCheckpoint>['cursors'],
  _addressScheme: 'pearl_p2tr',
  _ledgerAccount: boolean
): void {
  const selected = cursors.filter(() => true /* pearl p2tr only */)
  const receive = selected.find(cursor => !cursor.target.change)
  if (!receive?.complete) {
    throw new Error('Pearl receive address discovery must complete before spending')
  }
  if (_ledgerAccount && !selected.find(cursor => cursor.target.change)?.complete) {
    throw new Error('Pearl change address discovery must complete before spending')
  }
}

function inputOutpoints(selection: PearlCoinSelection) {
  return Object.freeze(
    selection.selectedUtxos.map(utxo =>
      Object.freeze({ transactionId: utxo.transactionId, outputIndex: utxo.outputIndex })
    )
  )
}

async function defaultChangeOutputPosition(
  transactionId: TransactionId
): Promise<PearlChangeOutputPosition> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(transactionId))
  return new Uint8Array(digest)[0] % 2 === 0 ? 'first' : 'last'
}

export class PearlTransferPreparationCoordinator {
  constructor(private readonly options: PearlTransferPreparationCoordinatorOptions) {}

  async prepare(input: PreparePearlTransferFromDiscoveryInput): Promise<PreparedPearlTransferPlan> {
    if (
      !isRecord(input) ||
      !hasExactKeys(
        input,
        ['chainAccount', 'accountIndex', 'transactionId', 'addressScheme', 'recipient', 'amount'],
        ['feeTargetBlocks', 'feeRateSatsPerVbyte', 'signal', 'ledgerAccount']
      ) ||
      (input.signal !== undefined && !(input.signal instanceof AbortSignal))
    ) {
      throw new Error('Invalid Pearl transfer preparation input')
    }
    const scope = parseScope({
      chainAccount: input.chainAccount,
      accountIndex: input.accountIndex
    })
    const transactionId = parseTransactionId(input.transactionId)
    const chainId = parsePearlChain(scope.chainAccount.scope.chainId)
    const addressScheme =
      input.addressScheme === 'pearl_p2tr' || input.addressScheme === 'p2tr'
        ? ('pearl_p2tr' as const)
        : (() => {
            throw new Error('Unsupported Pearl address scheme')
          })()
    const recipient = parsePearlAddress(input.recipient, chainId)
    const amount = parsePearlTransferAmount(input.amount)
    const ledgerAccount = input.ledgerAccount === true
    if (input.ledgerAccount !== undefined && typeof input.ledgerAccount !== 'boolean') {
      throw new Error('Invalid Ledger Pearl account selection')
    }
    if (ledgerAccount) {
      throw new Error('Pearl hardware transfers are unsupported')
    }
    if (input.feeTargetBlocks !== undefined && input.feeRateSatsPerVbyte !== undefined) {
      throw new Error('Pearl fee target and explicit fee rate are mutually exclusive')
    }
    const feeTargetBlocks = parsePearlIndex(
      input.feeTargetBlocks ?? PEARL_DEFAULT_FEE_TARGET_BLOCKS,
      'Pearl fee target',
      PEARL_MAXIMUM_FEE_TARGET_BLOCKS
    )
    if (feeTargetBlocks === 0) throw new Error('Invalid Pearl fee target')
    const explicitFeeRate =
      input.feeRateSatsPerVbyte === undefined
        ? undefined
        : parsePearlFeeRate(input.feeRateSatsPerVbyte)
    assertNotCancelled(input.signal)

    const state = await this.options.discoveryRepository.get(scope)
    if (state === null) {
      throw new Error('Pearl discovery must complete before spending')
    }
    const storedScope = parseScope({
      chainAccount: state.chainAccount,
      accountIndex: state.accountIndex
    })
    if (!pearlChainAccountsMatch(storedScope.chainAccount, scope.chainAccount)) {
      throw new Error('Pearl discovery does not match the selected ChainAccount')
    }
    const checkpoint = parseCheckpoint(state.checkpoint, scope)
    const discoveryUpdatedAt = parseTimestamp(state.updatedAt)
    assertDiscoveryComplete(checkpoint.cursors, addressScheme, ledgerAccount)
    const observations = state.observations.map(value => parseObservation(value, scope))
    const signer = observations.find(
      observation => !observation.derived.change && observation.derived.addressIndex === 0
    )?.derived.address
    assertPearlDiscoverySigner(signer, scope.chainAccount.identity.value)

    assertNotCancelled(input.signal)
    const derivedSigner = await this.options.derivation.deriveAddress(
      scope.chainAccount.scope.keyDomainId,
      {
        chainId,
        accountIndex: scope.accountIndex,
        change: false,
        addressIndex: 0
      },
      input.signal
    )
    if (ledgerAccount && derivedSigner.derivationPath !== scope.chainAccount.derivation.path) {
      throw new Error('Ledger Pearl signer path does not match the selected account')
    }
    if (derivedSigner.address !== signer) {
      throw new Error(
        ledgerAccount
          ? 'Ledger Pearl signer does not match discovery'
          : 'WASM-derived Pearl signer does not match discovery'
      )
    }
    const masterFingerprint = parsePearlMasterFingerprint(derivedSigner.masterFingerprint)

    assertNotCancelled(input.signal)
    await this.options.rpc.assertExpectedChain(input.signal)
    const [tipHeight, feeEstimates] = await Promise.all([
      this.options.rpc.getTipHeight(input.signal),
      explicitFeeRate === undefined
        ? this.options.rpc.getFeeEstimates(input.signal)
        : Promise.resolve(null)
    ])
    assertNotCancelled(input.signal)
    const feeRate =
      explicitFeeRate === undefined
        ? selectPearlFeeRate(feeEstimates, feeTargetBlocks)
        : Object.freeze({
            requestedTargetBlocks: feeTargetBlocks,
            sourceTargetBlocks: feeTargetBlocks,
            satsPerVbyte: explicitFeeRate
          })
    const unavailableOutpoints = new Set(
      (await this.options.inputReservations.list({ ...scope, addressScheme }))
        .filter(reservation => reservation.transactionId !== transactionId)
        .flatMap(reservation =>
          reservation.outpoints.map(outpoint => `${outpoint.transactionId}:${outpoint.outputIndex}`)
        )
    )
    const utxos = collectPearlSpendableUtxos(observations).filter(
      utxo => !unavailableOutpoints.has(`${utxo.transactionId}:${utxo.outputIndex}`)
    )
    if (utxos.some(utxo => utxo.blockHeight > tipHeight)) {
      throw new Error('Pearl discovery contains a UTXO above the current tip')
    }
    const selection = selectPearlCoins({
      chainId,
      accountIndex: scope.accountIndex,
      recipient,
      amount,
      feeRateSatsPerVbyte: feeRate.satsPerVbyte,
      utxos
    })
    assertNotCancelled(input.signal)

    let inputReservation: PearlInputReservation | null = null
    let changeReservation: PearlChangeReservation | null = null
    try {
      const reservedInputs = parsePearlInputReservation(
        await this.options.inputReservations.reserve({
          ...scope,
          addressScheme,
          transactionId,
          outpoints: inputOutpoints(selection),
          now: this.timestamp()
        }),
        { ...scope, addressScheme },
        transactionId
      )
      if (reservedInputs.state !== 'reserved') {
        throw new Error('Pearl input reservation is not ready')
      }
      inputReservation = reservedInputs
      assertNotCancelled(input.signal)
      const commonBuildInput = {
        selection,
        masterFingerprint,
        lockTime: tipHeight
      } as const
      if (ledgerAccount && BigInt(selection.changeSats) > 0n) {
        if (!this.options.changeReservations) {
          throw new Error('Ledger Pearl change reservation is unavailable')
        }
        changeReservation = await this.options.changeReservations.reserve({
          ...scope,
          addressScheme,
          transactionId,
          signal: input.signal
        })
        if (!changeReservation.address || changeReservation.state !== 'reserved') {
          throw new Error('Ledger Pearl change reservation is not ready')
        }
      }
      // Software change reuses the receive address so a change reservation is not required.
      // Ledger paths reserve a BIP-86 change-branch address above.
      const prepared: PreparedPearlPsbt =
        BigInt(selection.changeSats) === 0n
          ? buildPearlPsbt(commonBuildInput)
          : buildPearlPsbt({
              ...commonBuildInput,
              change: {
                address: changeReservation?.address ?? derivedSigner,
                outputPosition: await this.changeOutputPosition(transactionId)
              }
            })
      return Object.freeze({
        transactionId,
        signerAddress: signer,
        feeRate,
        selection,
        inputReservation,
        changeReservation,
        prepared,
        discoveryUpdatedAt
      })
    } catch (error) {
      const cleanup = await Promise.allSettled([
        ...(changeReservation === null || !this.options.changeReservations
          ? []
          : [
              this.options.changeReservations.abandon(
                {
                  chainAccount: changeReservation.chainAccount,
                  accountIndex: changeReservation.accountIndex,
                  addressScheme: changeReservation.addressScheme
                },
                changeReservation.transactionId
              )
            ]),
        ...(inputReservation === null
          ? []
          : [
              this.options.inputReservations.release(
                {
                  chainAccount: inputReservation.chainAccount,
                  accountIndex: inputReservation.accountIndex,
                  addressScheme: inputReservation.addressScheme
                },
                inputReservation.transactionId
              )
            ])
      ])
      if (cleanup.some(result => result.status === 'rejected')) {
        throw new Error('Pearl transfer preparation cleanup failed')
      }
      throw error
    }
  }

  private async changeOutputPosition(
    transactionId: TransactionId
  ): Promise<PearlChangeOutputPosition> {
    const position = await (this.options.selectChangeOutputPosition ?? defaultChangeOutputPosition)(
      transactionId
    )
    if (position !== 'first' && position !== 'last') {
      throw new Error('Invalid Pearl change output position')
    }
    return position
  }

  private timestamp(): number {
    const value = (this.options.now ?? Date.now)()
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('Invalid Pearl transfer preparation timestamp')
    }
    return value
  }
}
