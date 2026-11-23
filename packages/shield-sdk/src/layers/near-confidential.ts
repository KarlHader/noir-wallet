import { assertShieldAmount } from '../amount'
import { normalizeShieldChainId } from '../chain-id'
import {
  NEAR_CONFIDENTIAL_LAYER,
  ShieldError,
  type ShieldLayer,
  type ShieldTokenRef
} from '../types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

/** 1Click rejects a confidential account id that is not entirely lowercase. */
function lowercaseConfidentialAccountId(accountId: string): string {
  return accountId.toLowerCase()
}

function withLowercaseConfidentialAccountId(
  input: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  const destination = input.destination
  if (
    !isRecord(destination) ||
    destination.kind !== 'confidential' ||
    typeof destination.accountId !== 'string'
  ) {
    return input
  }
  const accountId = lowercaseConfidentialAccountId(destination.accountId)
  if (accountId === destination.accountId) return input
  return Object.freeze({
    ...input,
    destination: Object.freeze({ ...destination, accountId })
  })
}

export function assertNearConfidentialLayer(value: unknown): ShieldLayer {
  if (value !== NEAR_CONFIDENTIAL_LAYER) {
    throw new ShieldError('INVALID_PARAMS', 'Shield layer must be "near-confidential".')
  }
  return value
}

function tokenRef(value: unknown, label: string): ShieldTokenRef {
  if (!isRecord(value) || !exactKeys(value, ['chainId', 'assetId', 'symbol'])) {
    throw new ShieldError('INVALID_PARAMS', `${label} token is invalid.`)
  }
  if (value.chainId === undefined) {
    throw new ShieldError('INVALID_PARAMS', `${label} chain ID is required.`)
  }
  const assetId = value.assetId
  const symbol = value.symbol
  if (
    assetId !== undefined &&
    (typeof assetId !== 'string' || assetId.length === 0 || assetId.length > 160)
  ) {
    throw new ShieldError('INVALID_PARAMS', `${label} asset ID is invalid.`)
  }
  if (
    symbol !== undefined &&
    (typeof symbol !== 'string' || symbol.trim().length === 0 || symbol.length > 32)
  ) {
    throw new ShieldError('INVALID_PARAMS', `${label} symbol is invalid.`)
  }
  if (assetId === undefined && symbol === undefined) {
    throw new ShieldError('INVALID_PARAMS', `${label} requires an asset ID or a unique symbol.`)
  }
  return Object.freeze({
    chainId: normalizeShieldChainId(value.chainId),
    ...(typeof assetId === 'string' ? { assetId } : {}),
    ...(typeof symbol === 'string' ? { symbol } : {})
  })
}

export function prepareReceive(input: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(input) || !exactKeys(input, ['layer', 'source', 'amount'])) {
    throw new ShieldError('INVALID_PARAMS', 'Shield receive parameters are invalid.')
  }
  assertNearConfidentialLayer(input.layer)
  const source = tokenRef(input.source, 'Source')
  return Object.freeze({
    layer: NEAR_CONFIDENTIAL_LAYER,
    source,
    amount: assertShieldAmount(input.amount, 255)
  })
}

function rejectDestinationToken(destination: unknown): void {
  if (!isRecord(destination)) return
  if (
    Object.prototype.hasOwnProperty.call(destination, 'assetId') ||
    Object.prototype.hasOwnProperty.call(destination, 'symbol')
  ) {
    throw new ShieldError('INVALID_PARAMS', 'Shield destination token cannot be selected.')
  }
}

export function prepareQuote(
  input: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  rejectDestinationToken(input.destination)
  return withLowercaseConfidentialAccountId(input)
}

export function prepareTransfer(input: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(input) || !exactKeys(input, ['layer', 'token', 'amount', 'destination'])) {
    throw new ShieldError('INVALID_PARAMS', 'Shield transfer parameters are invalid.')
  }
  if ('peaAddress' in input) {
    throw new ShieldError(
      'INVALID_PARAMS',
      'Shield recipient account ID is the only recipient field.'
    )
  }
  assertNearConfidentialLayer(input.layer)
  const token = tokenRef(input.token, 'Token')
  const destination = input.destination
  rejectDestinationToken(destination)
  if (!isRecord(destination) || destination.kind === 'confidential') {
    if (
      !isRecord(destination) ||
      !exactKeys(destination, ['kind', 'accountId', 'chainId']) ||
      destination.kind !== 'confidential' ||
      typeof destination.accountId !== 'string' ||
      destination.accountId.trim() !== destination.accountId ||
      destination.accountId.length === 0 ||
      destination.accountId.length > 128
    ) {
      throw new ShieldError('INVALID_PARAMS', 'Confidential recipient account ID is invalid.')
    }
    const chainId = Object.prototype.hasOwnProperty.call(destination, 'chainId')
      ? normalizeShieldChainId(destination.chainId)
      : undefined
    return Object.freeze({
      layer: NEAR_CONFIDENTIAL_LAYER,
      token,
      amount: assertShieldAmount(input.amount, 255),
      destination: Object.freeze({
        kind: 'confidential',
        accountId: lowercaseConfidentialAccountId(destination.accountId),
        ...(chainId !== undefined ? { chainId } : {})
      })
    })
  }
  if (
    destination.kind !== 'public' ||
    !exactKeys(destination, ['kind', 'chainId', 'address']) ||
    typeof destination.address !== 'string'
  ) {
    throw new ShieldError('INVALID_PARAMS', 'Public Shield destination is invalid.')
  }
  const address = destination.address
  return Object.freeze({
    layer: NEAR_CONFIDENTIAL_LAYER,
    token,
    amount: assertShieldAmount(input.amount, 255),
    destination: Object.freeze({
      kind: 'public',
      chainId: normalizeShieldChainId(destination.chainId),
      address
    })
  })
}

export const nearConfidentialLayer = Object.freeze({
  id: NEAR_CONFIDENTIAL_LAYER,
  prepareReceive,
  prepareTransfer
})
