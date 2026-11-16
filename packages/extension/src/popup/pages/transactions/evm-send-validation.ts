import { ZEC_ZCASH_ASSET } from '@/config/intents'
import { parseZcashAddress } from '@/core/address-book/address-book'
import { EvmWalletClientError } from '@/popup/services/evm-wallet-client'

export type EvmSendSourceMode = 'main' | 'private'

function assertRoutableAssetId(assetId: string): void {
  if (!assetId || assetId.length > 512 || /[\u0000-\u001f\u007f]/.test(assetId)) {
    throw new Error('Invalid EVM asset route')
  }
}

function isPositiveRouteAmount(amount: string): boolean {
  return /^\d+(?:\.\d+)?$/.test(amount) && /[1-9]/.test(amount)
}

function appendTransferAmount(
  query: URLSearchParams,
  amount: string | undefined,
  maximum = false
): void {
  if (amount === undefined) return
  if (!/^\d+(?:\.\d+)?$/.test(amount)) throw new Error('Invalid EVM transfer amount route')
  query.set('amount', amount)
  query.set('review', '1')
  if (maximum) query.set('maximum', '1')
}

export function buildAddToPrivateEvmPath(input: {
  readonly assetId: string
  readonly chainId: string
  readonly amount?: string
  readonly maximum?: boolean
}): string {
  assertRoutableAssetId(input.assetId)
  const chainMatch = /^eip155:([1-9][0-9]*)$/.exec(input.chainId)
  if (!chainMatch) throw new Error('Invalid EVM chain route')
  const query = new URLSearchParams({
    privateDestination: '1',
    balanceTransfer: '1',
    destinationChain: chainMatch[1],
    destinationAsset: input.assetId,
    source: input.assetId
  })
  appendTransferAmount(query, input.amount, input.maximum)
  return `/swap?${query.toString()}`
}

export function buildMoveToMainEvmPath(input: {
  readonly assetId: string
  readonly mainAddress: string
  readonly amount?: string
  readonly maximum?: boolean
}): string {
  assertRoutableAssetId(input.assetId)
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.mainAddress)) {
    throw new Error('Invalid Main EVM address route')
  }
  const query = new URLSearchParams({
    privateTransfer: '1',
    balanceTransfer: '1',
    source: input.assetId,
    recipient: input.mainAddress
  })
  appendTransferAmount(query, input.amount, input.maximum)
  return `/swap?${query.toString()}`
}

export function buildPrivateGasFundingPath(input: {
  readonly chainId: string
  readonly nativeAssetId: string
  readonly requestId: string
  readonly minimumOutputRaw: string
  readonly suggestedOutputRaw: string
}): string {
  if (
    !/^eip155:[1-9][0-9]*$/.test(input.chainId) ||
    !input.nativeAssetId.startsWith(`${input.chainId}/slip44:`) ||
    !/^eip155:[1-9][0-9]*\/slip44:[0-9]+$/.test(input.nativeAssetId) ||
    !/^[a-zA-Z0-9:_-]{1,160}$/.test(input.requestId) ||
    [input.minimumOutputRaw, input.suggestedOutputRaw].some(
      raw => raw.length > 512 || !/^[0-9]+$/.test(raw) || BigInt(raw) <= 0n
    ) ||
    BigInt(input.suggestedOutputRaw) < BigInt(input.minimumOutputRaw)
  ) {
    throw new Error('Invalid same-chain gas funding route')
  }
  const path = buildAddToPrivateEvmPath({ assetId: input.nativeAssetId, chainId: input.chainId })
  const query = new URLSearchParams(path.slice(path.indexOf('?') + 1))
  query.set('privateFundingRequestId', input.requestId)
  query.set('minimumOutputRaw', input.minimumOutputRaw)
  query.set('suggestedOutputRaw', input.suggestedOutputRaw)
  query.set('review', '1')
  return `/swap?${query.toString()}`
}

export function buildPrivateEvmTransferPath(input: {
  readonly assetId: string
  readonly recipient: string
  readonly amount: string
  readonly maximum?: boolean
}): string {
  if (
    !input.assetId ||
    !/^0x[0-9a-fA-F]{40}$/.test(input.recipient) ||
    !/^\d+(?:\.\d+)?$/.test(input.amount)
  ) {
    throw new Error('Invalid Confidential EVM transfer route')
  }
  assertRoutableAssetId(input.assetId)
  const query = new URLSearchParams({
    privateTransfer: '1',
    source: input.assetId,
    recipient: input.recipient,
    amount: input.amount,
    review: '1'
  })
  if (input.maximum) query.set('maximum', '1')
  return `/swap?${query.toString()}`
}

export function isPublicPrivateSendRecipient(assetId: string, recipient: string): boolean {
  if (assetId === ZEC_ZCASH_ASSET) {
    try {
      return parseZcashAddress(recipient, 'mainnet').scheme.startsWith('zcash-transparent-')
    } catch {
      return false
    }
  }
  return (
    /^eip155:[1-9][0-9]*\//.test(assetId) &&
    /^0x[0-9a-fA-F]{40}$/.test(recipient) &&
    !/^0x0{40}$/i.test(recipient)
  )
}

export function buildPublicPrivateEvmSendPath(input: {
  readonly assetId: string
  readonly recipient: string
  readonly amount: string
  readonly maximum?: boolean
  readonly walletId: string
  readonly accountId: string
  readonly network: 'mainnet' | 'testnet'
}): string {
  assertRoutableAssetId(input.assetId)
  if (
    !isPublicPrivateSendRecipient(input.assetId, input.recipient) ||
    !isPositiveRouteAmount(input.amount) ||
    !input.walletId ||
    !input.accountId ||
    [input.walletId, input.accountId].some(
      value => value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)
    ) ||
    (input.network !== 'mainnet' && input.network !== 'testnet')
  ) {
    throw new Error('Invalid Public Confidential Send route')
  }
  const query = new URLSearchParams({
    privateTransfer: '1',
    publicPrivacySend: '1',
    sourceMode: 'main',
    sourceWalletId: input.walletId,
    sourceAccountId: input.accountId,
    sourceNetwork: input.network,
    source: input.assetId,
    recipient: input.recipient,
    amount: input.amount,
    review: '1'
  })
  if (input.assetId === ZEC_ZCASH_ASSET) query.set('fundingSource', 'transparent')
  if (input.maximum) query.set('maximum', '1')
  return `/swap?${query.toString()}`
}

function parseScopedPublicPrivacyDraft(
  searchParams: URLSearchParams,
  scope: Readonly<{
    walletId: string
    accountId: string
    network: 'mainnet' | 'testnet'
    assetId: string
  }>,
  assetKey: 'assetId' | 'source',
  privacyKey: 'sendPrivately' | 'publicPrivacySend'
): Readonly<{
  recipient: string
  amount: string
  maximum: boolean
  sendPrivately: true
}> | null {
  const required = [
    'sourceWalletId',
    'sourceAccountId',
    'sourceNetwork',
    assetKey,
    'sourceMode',
    privacyKey,
    'recipient',
    'amount'
  ]
  if (required.some(key => searchParams.getAll(key).length !== 1)) return null
  const recipient = searchParams.get('recipient') ?? ''
  const amount = searchParams.get('amount') ?? ''
  if (
    searchParams.get('sourceWalletId') !== scope.walletId ||
    searchParams.get('sourceAccountId') !== scope.accountId ||
    searchParams.get('sourceNetwork') !== scope.network ||
    searchParams.get(assetKey) !== scope.assetId ||
    searchParams.get('sourceMode') !== 'main' ||
    searchParams.get(privacyKey) !== '1' ||
    !isPublicPrivateSendRecipient(scope.assetId, recipient) ||
    (scope.assetId === ZEC_ZCASH_ASSET &&
      privacyKey === 'publicPrivacySend' &&
      (searchParams.getAll('fundingSource').length !== 1 ||
        searchParams.get('fundingSource') !== 'transparent')) ||
    !isPositiveRouteAmount(amount) ||
    (searchParams.has('maximum') && searchParams.get('maximum') !== '1')
  ) {
    return null
  }
  return Object.freeze({
    recipient,
    amount,
    maximum: searchParams.get('maximum') === '1',
    sendPrivately: true
  })
}

export function parsePublicPrivateEvmSendDraft(
  searchParams: URLSearchParams,
  scope: Readonly<{
    walletId: string
    accountId: string
    network: 'mainnet' | 'testnet'
    assetId: string
  }>
): ReturnType<typeof parseScopedPublicPrivacyDraft> {
  return parseScopedPublicPrivacyDraft(searchParams, scope, 'assetId', 'sendPrivately')
}

export function parsePublicPrivateEvmSwapRoute(
  searchParams: URLSearchParams,
  scope: Readonly<{
    walletId: string
    accountId: string
    network: 'mainnet' | 'testnet'
    assetId: string
  }>
): ReturnType<typeof parseScopedPublicPrivacyDraft> {
  if (
    searchParams.getAll('privateTransfer').length !== 1 ||
    searchParams.get('privateTransfer') !== '1'
  )
    return null
  return parseScopedPublicPrivacyDraft(searchParams, scope, 'source', 'publicPrivacySend')
}

export function getEvmTokenFeeBalanceError(
  assetKind: 'native' | 'token',
  nativeAvailableRaw: string | undefined,
  nativeSymbol: string
): string | null {
  if (
    assetKind !== 'token' ||
    (nativeAvailableRaw !== undefined && BigInt(nativeAvailableRaw) > 0n)
  ) {
    return null
  }
  return `Insufficient ${nativeSymbol} balance.`
}

export function getEvmTransferBalanceError(input: {
  readonly assetKind: 'native' | 'token'
  readonly transferAmountRaw: string
  readonly maximumFeeRaw: string
  readonly assetAvailableRaw: string
  readonly nativeAvailableRaw: string
  readonly nativeSymbol: string
}): string | null {
  if (
    input.assetKind === 'native' &&
    BigInt(input.transferAmountRaw) + BigInt(input.maximumFeeRaw) > BigInt(input.assetAvailableRaw)
  ) {
    return `Leave enough ${input.nativeSymbol} available for the maximum network fee.`
  }
  if (
    input.assetKind === 'token' &&
    BigInt(input.nativeAvailableRaw) < BigInt(input.maximumFeeRaw)
  ) {
    return `Not enough ${input.nativeSymbol} is available for the maximum network fee.`
  }
  return null
}

export function resolveEvmNativeMaximumAmount(availableRaw: string, maximumFeeRaw: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(availableRaw) || !/^(0|[1-9][0-9]*)$/.test(maximumFeeRaw)) {
    throw new Error('Invalid EVM maximum amount input')
  }
  const maximum = BigInt(availableRaw) - BigInt(maximumFeeRaw)
  if (maximum <= 0n) throw new Error('The native balance does not cover the maximum network fee')
  return maximum.toString()
}
export function getEvmSendPrepareError(error: unknown, sourceMode: EvmSendSourceMode): string {
  if (!(error instanceof EvmWalletClientError)) {
    return 'The transfer could not be prepared. Please try again.'
  }
  if (error.code === 'network-unavailable') {
    return 'The network is unavailable. Check your connection and try again.'
  }
  if (error.code === 'nonce-recovery-required') {
    return 'An earlier transaction needs attention. Open Activity to resolve its nonce before sending.'
  }
  if (error.code === 'account-unavailable') return 'This wallet does not have an EVM account.'
  if (error.code === 'expired') return 'The review expired. Prepare the transfer again.'
  if (error.code === 'review-unavailable') {
    return 'This review is no longer available. Check Activity before preparing another transfer.'
  }
  if (error.code === 'asset-unavailable') return 'This asset is unavailable for sending.'
  if (error.code === 'invalid-request') return 'Check the amount and recipient address.'
  if (error.code === 'insufficient-funds') {
    return sourceMode === 'private'
      ? 'The Confidential address does not have enough native balance for the amount and maximum network fee.'
      : 'The Public account does not have enough native balance for the amount and maximum network fee.'
  }
  return 'The transfer could not be prepared. Please try again.'
}
