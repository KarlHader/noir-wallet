import { nearConfidentialLayer, prepareQuote } from './layers/near-confidential'
import { createShieldOperation, snapshotFromReport, type ShieldStatusReport } from './operation'
import { sendShieldRequest } from './provider'
import {
  NEAR_CONFIDENTIAL_LAYER,
  ShieldError,
  type ShieldAction,
  type ShieldBalance,
  type ShieldChainInfo,
  type ShieldLayer,
  type ShieldOperationHandle,
  type ShieldQuote,
  type ShieldReceiveParams,
  type ShieldTokenInfo,
  type ShieldTransactionStatus,
  type ShieldTransferParams
} from './types'

function operation(action: ShieldAction, report: ShieldStatusReport): ShieldOperationHandle {
  const snapshot = snapshotFromReport(report, {
    id: typeof report.id === 'string' ? report.id : '',
    layer: NEAR_CONFIDENTIAL_LAYER,
    action
  })
  if (snapshot.id.length === 0) {
    throw new ShieldError('UNKNOWN', 'Shield operation id is missing.')
  }
  return createShieldOperation(snapshot, async id =>
    sendShieldRequest<ShieldStatusReport>('shield_getTransactionStatus', {
      layer: NEAR_CONFIDENTIAL_LAYER,
      operationId: id
    })
  )
}

/**
 * NEAR Confidential Shield client.
 * connect() opens a session and does not grant transfer permission.
 */
export class NoirShieldSDK {
  readonly layer: ShieldLayer = nearConfidentialLayer.id

  async connect(): Promise<Readonly<{ layer: ShieldLayer; connected: true }>> {
    await sendShieldRequest('shield_connect', { layer: this.layer })
    return Object.freeze({ layer: this.layer, connected: true })
  }

  async disconnect(): Promise<void> {
    await sendShieldRequest('shield_disconnect', { layer: this.layer })
  }

  readonly shield = Object.freeze({
    receive: async (params: ShieldReceiveParams): Promise<ShieldOperationHandle> => {
      const report = await sendShieldRequest<ShieldStatusReport>(
        'shield_receive',
        nearConfidentialLayer.prepareReceive(params)
      )
      return operation('receive', report)
    },
    transfer: async (params: ShieldTransferParams): Promise<ShieldOperationHandle> => {
      const report = await sendShieldRequest<ShieldStatusReport>(
        'shield_transfer',
        nearConfidentialLayer.prepareTransfer(params)
      )
      return operation('transfer', report)
    }
  })

  async getSupportedChains(
    input: Readonly<{
      layer: ShieldLayer
      action: ShieldAction
      destinationKind?: 'public' | 'confidential'
    }>
  ): Promise<readonly ShieldChainInfo[]> {
    if (input.layer !== this.layer) {
      throw new ShieldError('INVALID_PARAMS', 'Shield layer must be "near-confidential".')
    }
    const result = await sendShieldRequest<{ chains?: readonly ShieldChainInfo[] }>(
      'shield_getSupportedChains',
      input
    )
    return Object.freeze([...(result.chains ?? [])])
  }

  async getSupportedTokens(
    input: Readonly<{
      layer: ShieldLayer
      action: ShieldAction
      sourceChainId?: string | number
      destinationChainId?: string | number
      destinationKind?: 'public' | 'confidential'
    }>
  ): Promise<readonly ShieldTokenInfo[]> {
    if (input.layer !== this.layer) {
      throw new ShieldError('INVALID_PARAMS', 'Shield layer must be "near-confidential".')
    }
    const result = await sendShieldRequest<{ tokens?: readonly ShieldTokenInfo[] }>(
      'shield_getSupportedTokens',
      input
    )
    return Object.freeze([...(result.tokens ?? [])])
  }

  async refreshBalances(): Promise<readonly ShieldBalance[]> {
    const result = await sendShieldRequest<{ balances?: readonly ShieldBalance[] }>(
      'shield_refreshBalances',
      { layer: this.layer }
    )
    return Object.freeze([...(result.balances ?? [])])
  }

  async getQuote(input: Readonly<Record<string, unknown>>): Promise<ShieldQuote> {
    return sendShieldRequest<ShieldQuote>('shield_getQuote', prepareQuote(input))
  }

  async getTransactionStatus(
    input: Readonly<{ layer: ShieldLayer; operationId: string }>
  ): Promise<ShieldTransactionStatus> {
    if (
      input.layer !== this.layer ||
      typeof input.operationId !== 'string' ||
      input.operationId.length === 0
    ) {
      throw new ShieldError(
        'INVALID_PARAMS',
        'Shield status query requires a layer and operation id.'
      )
    }
    return sendShieldRequest<ShieldTransactionStatus>('shield_getTransactionStatus', input)
  }
}
