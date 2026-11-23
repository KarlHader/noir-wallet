import { NEAR_CHAIN_FEATURE_FLAG } from '@/config/multichain-feature-flags'
import { isDeprecatedIntentsToken } from '@/core/services/intents-evm-assets'
import type { Network } from '@/types'
import {
  supportsNearPrivateExecution,
  type NearPrivateExecutionWalletSource
} from './execution-capability'
import { parseNearAccountId } from './identifiers'
import {
  decodeNearContractId,
  NEAR_MAINNET_CHAIN_ID,
  NEAR_MAINNET_NATIVE_ASSET_ID,
  NEAR_MAINNET_WRAPPED_ASSET_ID,
  NEAR_WRAPPED_PROTOCOL_ASSET_ID,
  nearConfidentialPortfolioAssetId
} from './near-portfolio-assets'

export const NEAR_MOVE_UNAVAILABLE = 'NEAR Move is unavailable.'
export const NEAR_MOVE_NO_PEA = 'This account has no Incognito NEAR address.'
export const NEAR_MOVE_CANNOT_SIGN = 'This account cannot sign an Incognito NEAR transfer.'
export const NEAR_MOVE_IMPORTED_INDEX = 'Imported NEAR keys can only sign from account index 0.'
export const NEAR_MOVE_MEMO = 'The quote included a memo and cannot fund this transfer.'
export const NEAR_MOVE_DEPOSIT_ADDRESS = 'The quote did not include a usable NEAR deposit address.'

const NEAR_IMPLICIT_ACCOUNT = /^[0-9a-f]{64}$/
const NO_FUNDING_TRANSFERS: readonly [] = []
const NEAR_DIRECT_TOKEN_LIST_CHAIN_ID = 900001
const NATIVE_QUOTE_PROTOCOL_ASSET_ID = NEAR_WRAPPED_PROTOCOL_ASSET_ID
const NATIVE_QUOTE_ADDRESS = 'wrap.near'

export type NearIncognitoMoveMethod = 'cluster' | 'directly'
export type NearIncognitoMoveDomain = 'public' | 'private' | 'shield'

export interface NearMoveBalance {
  readonly totalRaw?: string
  readonly availableRaw?: string
  readonly mainRaw?: string
  readonly privateRaw?: string
  readonly privateOnchainRaw?: string
  readonly confidentialRaw?: string
}

export interface NearMoveAccountNetwork {
  readonly chain: Readonly<{ family: string; id: string }>
  readonly addresses: readonly Readonly<{ preferredForReceive?: boolean; value: string }>[]
  readonly privateExecutionAddress?: string
}

export interface NearMoveAccount {
  readonly walletSource:
    | Readonly<{ kind: 'software' }>
    | Readonly<{
        kind: 'private-key'
        chainFamily: 'eip155' | 'bip122' | 'solana' | 'near'
      }>
    | Readonly<{ kind: 'hardware' }>
  readonly accountIndex: number
  readonly networks: readonly NearMoveAccountNetwork[]
}

/**
 * Mainnet public ↔ Incognito NEAR Move. Testnet and a disabled chain.near flag
 * expose nothing, so Move stays on the current EVM path.
 */
export function nearIncognitoMoveExposed(
  network: Network,
  enabledFlags: readonly string[]
): boolean {
  return network === 'mainnet' && enabledFlags.includes(NEAR_CHAIN_FEATURE_FLAG)
}

export function getNearMoveChainIds(input: {
  readonly account: NearMoveAccount | null
  readonly mainnet: boolean
  readonly enabledFlags: readonly string[]
}): readonly string[] {
  if (
    !input.mainnet ||
    !nearIncognitoMoveExposed('mainnet', input.enabledFlags) ||
    !input.account
  ) {
    return []
  }
  const network = input.account.networks.find(
    item => item.chain.family === 'near' && item.chain.id === NEAR_MAINNET_CHAIN_ID
  )
  if (
    !network?.addresses.some(address => address.preferredForReceive && address.value.length > 0)
  ) {
    return []
  }
  return Object.freeze([NEAR_MAINNET_CHAIN_ID])
}

/** Public uses Main. Incognito uses the PEA bucket. Shield uses confidential holdings. */
export function readNearMoveDomainRaw(
  balance: NearMoveBalance,
  domain: Exclude<NearIncognitoMoveDomain, never>
): string | null {
  if (domain === 'private') return balance.privateOnchainRaw ?? null
  if (domain === 'shield') return balance.confidentialRaw ?? null
  if (balance.mainRaw !== undefined) return balance.mainRaw
  if (
    balance.privateRaw === undefined &&
    balance.privateOnchainRaw === undefined &&
    balance.confidentialRaw === undefined
  ) {
    return balance.availableRaw ?? balance.totalRaw ?? null
  }
  return null
}

export function nearIncognitoWalletSource(input: {
  readonly kind: 'software' | 'private-key' | 'hardware'
  readonly chainFamily?: 'eip155' | 'bip122' | 'solana' | 'near'
  readonly accountIndex: number
}): NearPrivateExecutionWalletSource {
  if (input.kind === 'private-key') {
    return Object.freeze({
      kind: 'private-key',
      chainFamily: input.chainFamily ?? 'eip155',
      accountIndex: input.accountIndex
    })
  }
  return Object.freeze({ kind: input.kind === 'hardware' ? 'hardware' : 'software' })
}

/** Same JSON the NEAR PEA signer submits. No appId or chainId. */
export function nearIncognitoPeaRequestJson(accountIndex: number): string {
  if (!Number.isSafeInteger(accountIndex) || accountIndex < 0) {
    throw new Error(NEAR_MOVE_CANNOT_SIGN)
  }
  return JSON.stringify({ version: 2, family: 'near', parent: { accountIndex } })
}

export function nearDirectQuoteAsset(asset: {
  readonly id: string
  readonly chainId: string
  readonly kind: string
  readonly reference?: string
}): Readonly<{ protocolAssetId: string; address: string; native: boolean }> | null {
  if (asset.chainId !== NEAR_MAINNET_CHAIN_ID) return null
  if (asset.kind === 'native' || asset.id === NEAR_MAINNET_NATIVE_ASSET_ID) {
    return Object.freeze({
      protocolAssetId: NATIVE_QUOTE_PROTOCOL_ASSET_ID,
      address: NATIVE_QUOTE_ADDRESS,
      native: true
    })
  }
  if (asset.kind !== 'token' || !asset.reference) return null
  const contractId = decodeNearContractId(asset.reference)
  const protocolAssetId = `nep141:${contractId}`
  // nearConfidentialPortfolioAssetId maps wrap.near onto native NEAR, so wNEAR must match its own id.
  if (contractId === 'wrap.near') {
    if (asset.id !== NEAR_MAINNET_WRAPPED_ASSET_ID) return null
    return Object.freeze({
      protocolAssetId: NATIVE_QUOTE_PROTOCOL_ASSET_ID,
      address: NATIVE_QUOTE_ADDRESS,
      native: false
    })
  }
  if (nearConfidentialPortfolioAssetId(protocolAssetId) !== asset.id) return null
  return Object.freeze({
    protocolAssetId,
    address: protocolAssetId.slice('nep141:'.length),
    native: false
  })
}

export const NEAR_DIRECT_RHEA_TOKEN_LIST_CHAIN_ID = NEAR_DIRECT_TOKEN_LIST_CHAIN_ID

export function nearDirectCatalogToken<
  T extends {
    readonly assetId: string
    readonly rheaAddress: string
    readonly rheaChainId: string
    readonly isNative?: boolean
  }
>(
  tokens: readonly T[],
  quoteAsset: Readonly<{ protocolAssetId: string; address: string; native?: boolean }>
): T | null {
  let first: T | undefined
  for (const token of tokens) {
    const matches =
      token.rheaChainId === 'near' &&
      (token.assetId === quoteAsset.protocolAssetId ||
        token.rheaAddress === quoteAsset.address ||
        (quoteAsset.address === NATIVE_QUOTE_ADDRESS &&
          (token.rheaAddress === 'near' || token.assetId === NATIVE_QUOTE_PROTOCOL_ASSET_ID)))
    if (!matches) continue
    if (first === undefined) first = token
    if (token.isNative === quoteAsset.native) return token
  }
  return first ?? null
}

export function nearWrappedClusterAsset(
  asset: Readonly<{ id: string; chainId: string; decimals: number }>,
  tokens: readonly Readonly<{
    assetId: string
    blockchain: string
    decimals: number
    symbol?: string
  }>[]
): Readonly<{
  assetId: string
  chainId: string
  protocolAssetId: string
  blockchain: string
}> | null {
  if (asset.id !== NEAR_MAINNET_WRAPPED_ASSET_ID || asset.decimals !== 24) return null
  const token = tokens.find(
    item =>
      item.assetId === NEAR_WRAPPED_PROTOCOL_ASSET_ID &&
      item.decimals === 24 &&
      !isDeprecatedIntentsToken(item)
  )
  if (!token) return null
  return Object.freeze({
    assetId: asset.id,
    chainId: asset.chainId,
    protocolAssetId: NEAR_WRAPPED_PROTOCOL_ASSET_ID,
    blockchain: token.blockchain
  })
}

function canonicalNearAccount(value: string): string | null {
  try {
    const accountId = parseNearAccountId(value)
    return accountId === value ? accountId : null
  } catch {
    return null
  }
}

function persistedPea(
  mainAccountId: string,
  peaAccountId: string | null | undefined
): string | null {
  if (
    !peaAccountId ||
    !NEAR_IMPLICIT_ACCOUNT.test(peaAccountId) ||
    peaAccountId === mainAccountId
  ) {
    return null
  }
  return peaAccountId
}

function privateSourceError(
  walletSource: NearPrivateExecutionWalletSource | null,
  accountIndex: number
): string | null {
  if (!walletSource) return NEAR_MOVE_CANNOT_SIGN
  const source =
    walletSource.kind === 'private-key'
      ? Object.freeze({
          kind: 'private-key' as const,
          chainFamily: walletSource.chainFamily,
          accountIndex
        })
      : walletSource
  if (supportsNearPrivateExecution(source)) return null
  if (
    walletSource.kind === 'private-key' &&
    walletSource.chainFamily === 'near' &&
    accountIndex !== 0
  ) {
    return NEAR_MOVE_IMPORTED_INDEX
  }
  return NEAR_MOVE_CANNOT_SIGN
}

export interface NearIncognitoMoveResolution {
  readonly ok: true
  readonly method: NearIncognitoMoveMethod
  readonly sender: string
  readonly recipient: string
  readonly executionMode: 'main' | 'private'
  readonly signingKind: 'near-transaction' | 'pea-near-transaction'
  readonly mainAccountId: string
  readonly peaAccountId: string
  readonly accountIndex: number
  readonly peaRequestJson?: string
}

export interface NearIncognitoMoveFailure {
  readonly ok: false
  readonly method: NearIncognitoMoveMethod
  readonly error: string
  readonly fundingTransfers: readonly []
}

export function resolveNearIncognitoMove(input: {
  readonly network: Network
  readonly enabledFlags: readonly string[]
  readonly method: NearIncognitoMoveMethod
  readonly from: NearIncognitoMoveDomain
  readonly to: NearIncognitoMoveDomain
  readonly mainAccountId: string
  readonly peaAccountId: string | null
  readonly accountIndex: number
  readonly walletSource: NearPrivateExecutionWalletSource | null
}): NearIncognitoMoveResolution | NearIncognitoMoveFailure {
  const fail = (error: string): NearIncognitoMoveFailure =>
    Object.freeze({
      ok: false,
      method: input.method,
      error,
      fundingTransfers: NO_FUNDING_TRANSFERS
    })
  if (!nearIncognitoMoveExposed(input.network, input.enabledFlags))
    return fail(NEAR_MOVE_UNAVAILABLE)
  if (
    !(
      (input.from === 'public' && input.to === 'private') ||
      (input.from === 'private' && input.to === 'public')
    )
  ) {
    return fail(NEAR_MOVE_UNAVAILABLE)
  }
  const mainAccountId = canonicalNearAccount(input.mainAccountId)
  if (!mainAccountId) return fail(NEAR_MOVE_UNAVAILABLE)
  const peaAccountId = persistedPea(mainAccountId, input.peaAccountId)
  if (!peaAccountId) return fail(NEAR_MOVE_NO_PEA)
  if (input.from === 'private') {
    const error = privateSourceError(input.walletSource, input.accountIndex)
    if (error) return fail(error)
  }
  const privateSource = input.from === 'private'
  return Object.freeze({
    ok: true,
    method: input.method,
    sender: privateSource ? peaAccountId : mainAccountId,
    recipient: privateSource ? mainAccountId : peaAccountId,
    executionMode: privateSource ? 'private' : 'main',
    signingKind: privateSource ? 'pea-near-transaction' : 'near-transaction',
    mainAccountId,
    peaAccountId,
    accountIndex: input.accountIndex,
    ...(privateSource ? { peaRequestJson: nearIncognitoPeaRequestJson(input.accountIndex) } : {})
  })
}

export interface NearIncognitoClusterPlan {
  readonly ok: true
  readonly method: 'cluster'
  readonly fundingTransfers: readonly []
  readonly signerChainFamily: 'near'
  readonly intentStandard: 'nep413'
  readonly signerId: string
  readonly refundTo: string
  readonly withdrawRecipient: string
  readonly sourceAddress: string
  readonly destinationAddress: string
  readonly deposit: Readonly<{
    originAsset: string
    destinationAsset: string
    amountRaw: string
    signerId: string
    refundTo: string
    recipient: string
    depositType: 'ORIGIN_CHAIN'
    refundType: 'ORIGIN_CHAIN'
    recipientType: 'CONFIDENTIAL_INTENTS'
    slippageBps: number
  }>
  readonly withdraw: Readonly<{
    signerId: string
    recipient: string
    destinationAsset: string
    depositType: 'CONFIDENTIAL_INTENTS'
    recipientType: 'DESTINATION_CHAIN'
  }>
}

/**
 * 1Click deposit plus withdraw intents. The intents signer is the NEAR account,
 * named or implicit. A missing on-chain implicit account does not add a public
 * transfer from Main to the PEA.
 */
export function planNearIncognitoCluster(input: {
  readonly network: Network
  readonly enabledFlags: readonly string[]
  readonly from: NearIncognitoMoveDomain
  readonly to: NearIncognitoMoveDomain
  readonly mainAccountId: string
  readonly peaAccountId: string | null
  readonly accountIndex: number
  readonly walletSource: NearPrivateExecutionWalletSource | null
  readonly originAsset: string
  readonly destinationAsset: string
  readonly amountRaw: string
  readonly slippageBps: number
  readonly implicitAccountOnChain?: boolean
}): NearIncognitoClusterPlan | NearIncognitoMoveFailure {
  // Quoted before the implicit account exists. Never fund that account from Main.
  void input.implicitAccountOnChain
  const resolved = resolveNearIncognitoMove({ ...input, method: 'cluster' })
  if (!resolved.ok) return resolved
  const signerId = resolved.mainAccountId
  const deposit = Object.freeze({
    originAsset: input.originAsset,
    destinationAsset: input.originAsset,
    amountRaw: input.amountRaw,
    signerId,
    refundTo: resolved.sender,
    recipient: signerId,
    depositType: 'ORIGIN_CHAIN' as const,
    refundType: 'ORIGIN_CHAIN' as const,
    recipientType: 'CONFIDENTIAL_INTENTS' as const,
    slippageBps: input.slippageBps
  })
  return Object.freeze({
    ok: true,
    method: 'cluster',
    fundingTransfers: NO_FUNDING_TRANSFERS,
    signerChainFamily: 'near',
    intentStandard: 'nep413',
    signerId,
    refundTo: resolved.sender,
    withdrawRecipient: resolved.recipient,
    sourceAddress: resolved.sender,
    destinationAddress: resolved.recipient,
    deposit,
    withdraw: Object.freeze({
      signerId,
      recipient: resolved.recipient,
      destinationAsset: input.destinationAsset,
      depositType: 'CONFIDENTIAL_INTENTS' as const,
      recipientType: 'DESTINATION_CHAIN' as const
    })
  })
}

export function selectBalanceTransferMethod(input: {
  readonly family: string
  readonly method: NearIncognitoMoveMethod
  readonly clusterUnavailable: boolean
  readonly directUnavailable: boolean
  readonly clusterQuoted: boolean
  readonly directQuoted: boolean
}): NearIncognitoMoveMethod {
  if (input.family === 'near') return input.method
  if (input.method === 'cluster' && input.clusterUnavailable && input.directQuoted)
    return 'directly'
  if (input.method === 'directly' && input.directUnavailable && input.clusterQuoted)
    return 'cluster'
  return input.method
}

export function acceptNearDirectDeposit(input: {
  readonly depositAddress?: string | null
  readonly memo?: string | null
  readonly depositMemo?: string | null
}): Readonly<{ ok: true; depositAddress: string } | { ok: false; error: string }> {
  if (
    (typeof input.memo === 'string' && input.memo.length > 0) ||
    (typeof input.depositMemo === 'string' && input.depositMemo.length > 0)
  ) {
    return Object.freeze({ ok: false, error: NEAR_MOVE_MEMO })
  }
  if (!input.depositAddress || !NEAR_IMPLICIT_ACCOUNT.test(input.depositAddress)) {
    return Object.freeze({ ok: false, error: NEAR_MOVE_DEPOSIT_ADDRESS })
  }
  return Object.freeze({ ok: true, depositAddress: input.depositAddress })
}

function quoteTokenAddress(address: string): string {
  return address === 'near' || address === 'native' ? NATIVE_QUOTE_ADDRESS : address
}

export function isNearIncognitoQuoteSender(
  request: Readonly<{ fromChain: string; sender: string }>,
  account:
    | Readonly<{
        networks: readonly Readonly<{
          chainId: string
          privateExecutionAddress?: string
          addresses?: readonly Readonly<{ value: string }>[]
        }>[]
      }>
    | null
    | undefined
): boolean {
  if (request.fromChain !== 'near' || !account) return false
  const network = account.networks.find(item => item.chainId === NEAR_MAINNET_CHAIN_ID)
  const pea = network?.privateExecutionAddress
  const mains = network?.addresses?.map(address => address.value) ?? []
  return Boolean(
    pea && NEAR_IMPLICIT_ACCOUNT.test(pea) && !mains.includes(pea) && request.sender === pea
  )
}

type NearDirectQuoteAccount = Readonly<{
  walletId: string
  accountId: string
  accountIndex?: number
  walletSource?: NearPrivateExecutionWalletSource
  networks: readonly Readonly<{
    chainId: string
    privateExecutionAddress?: string
    addresses?: readonly Readonly<{ value: string }>[]
  }>[]
}>

/**
 * Same-chain public ↔ PEA quote. Does not fall through to a public transfer
 * from Main to the PEA.
 */
export function assertNearIncognitoDirectQuote(
  request: Readonly<{
    fromChain: string
    toChain: string
    tokenIn: Readonly<{ address: string }>
    tokenOut: Readonly<{ address: string }>
    sender: string
    recipient?: string
    confidentiality?: 'basic'
  }>,
  account: NearDirectQuoteAccount | null,
  purpose: 'confidential-funding' | 'private-transfer',
  scope?: Readonly<{ walletId: string; accountId: string }>
): void {
  const changed = 'Private quote account changed. Get a new quote.'
  const recipient = request.recipient
  if (
    request.confidentiality !== 'basic' ||
    request.fromChain !== 'near' ||
    request.toChain !== 'near' ||
    !recipient
  ) {
    throw new Error(changed)
  }
  if (quoteTokenAddress(request.tokenIn.address) !== quoteTokenAddress(request.tokenOut.address)) {
    throw new Error(NEAR_MOVE_UNAVAILABLE)
  }
  if (
    !account ||
    (scope && (account.walletId !== scope.walletId || account.accountId !== scope.accountId))
  ) {
    throw new Error(changed)
  }
  const quoteAccount = account
  const network = quoteAccount.networks.find(item => item.chainId === NEAR_MAINNET_CHAIN_ID)
  const mains = network?.addresses?.map(address => address.value) ?? []
  const pea = network?.privateExecutionAddress
  if (!pea || !NEAR_IMPLICIT_ACCOUNT.test(pea) || mains.length === 0 || mains.includes(pea)) {
    throw new Error(NEAR_MOVE_NO_PEA)
  }
  if (purpose === 'confidential-funding') {
    if (!mains.includes(request.sender) || recipient !== pea) throw new Error(changed)
    return
  }
  if (request.sender !== pea || !mains.includes(recipient)) throw new Error(changed)
  const signing = privateSourceError(
    quoteAccount.walletSource ?? null,
    quoteAccount.accountIndex ?? -1
  )
  if (signing) throw new Error(signing)
}
