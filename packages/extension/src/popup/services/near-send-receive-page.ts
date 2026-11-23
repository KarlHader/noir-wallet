import { parseNearAccountId } from '@/core/chains/near'
import { resolveNearAddressRole } from '@/core/accounts/near-address-role'
import {
  describeNearPrivateSendRoute,
  NEAR_PRIVATE_SEND_CHAIN_ASSET_ID,
  NEAR_PRIVATE_SEND_QUOTE_ASSET_ID,
  type NearPrivateSendAccount,
  type NearPrivateSendDepositRoute,
  type NearPrivateSendKeySource,
  type NearPrivateSendRoute,
  type NearPrivateSendRouteInput,
  type NearPrivateSendSource
} from '@/popup/services/near-send-routing'

export const NEAR_INCOGNITO_RECEIVE_NOTICE = 'This account is inactive until it receives NEAR.'
export const NEAR_PRIVATE_SEND_TOGGLE_MESSAGE =
  'Turn on Send privately to send to this Incognito address.'
export const NEAR_PRIVATE_SEND_SLIPPAGE_BPS = 50
const PRIVATE_SEND_DEADLINE_MS = 60 * 60 * 1000

export type NearReceiveMode = 'public' | 'incognito'

export type NearReceiveSelection =
  | Readonly<{ status: 'address'; mode: 'public'; address: string }>
  | Readonly<{
      status: 'address'
      mode: 'incognito'
      address: string
      notice: typeof NEAR_INCOGNITO_RECEIVE_NOTICE
    }>
  | Readonly<{ status: 'unavailable'; mode: NearReceiveMode }>

export type NearSendPageDecision =
  | Readonly<{ action: 'public' }>
  | Readonly<{ action: 'private'; route: NearPrivateSendRoute }>
  | Readonly<{ action: 'stopped'; message: string }>

function canonicalAccountId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const accountId = parseNearAccountId(value)
    return accountId === value ? accountId : null
  } catch {
    return null
  }
}

function persistedPea(value: unknown, mainAccountId: string | null): string | null {
  const accountId = canonicalAccountId(value)
  return accountId !== null && /^[0-9a-f]{64}$/.test(accountId) && accountId !== mainAccountId
    ? accountId
    : null
}

/**
 * Public receive is this account's Main account ID, named or implicit.
 * Incognito receive is only the persisted 64-hex PEA. Hardware accounts have none.
 * Address-book labels are not an input.
 */
export function selectNearReceiveAddress(input: {
  readonly mode: NearReceiveMode
  readonly keySource: NearPrivateSendKeySource
  readonly mainAccountId: unknown
  readonly persistedPeaAccountId?: unknown
}): NearReceiveSelection {
  const mainAccountId = canonicalAccountId(input.mainAccountId)
  if (input.mode === 'public') {
    return mainAccountId === null
      ? Object.freeze({ status: 'unavailable', mode: 'public' })
      : Object.freeze({ status: 'address', mode: 'public', address: mainAccountId })
  }
  const pea = persistedPea(input.persistedPeaAccountId, mainAccountId)
  if (input.keySource === 'hardware' || pea === null) {
    return Object.freeze({ status: 'unavailable', mode: 'incognito' })
  }
  return Object.freeze({
    status: 'address',
    mode: 'incognito',
    address: pea,
    notice: NEAR_INCOGNITO_RECEIVE_NOTICE
  })
}

export function nearIncognitoReceiveUnavailableMessage(
  keySource: NearPrivateSendKeySource
): string {
  return keySource === 'hardware'
    ? 'This hardware account has no Incognito NEAR address.'
    : 'This account has no Incognito NEAR address.'
}

export function createNearPrivateSendDeadline(now: number): string | null {
  if (!Number.isFinite(now)) return null
  const deadline = new Date(now + PRIVATE_SEND_DEADLINE_MS).toISOString()
  return Number.isNaN(Date.parse(deadline)) ? null : deadline
}

export function isNearPrivateSendAsset(assetId: string): boolean {
  return (
    assetId === NEAR_PRIVATE_SEND_QUOTE_ASSET_ID ||
    assetId === NEAR_PRIVATE_SEND_CHAIN_ASSET_ID ||
    assetId === 'near:mainnet/slip44:397'
  )
}

export function readNearSendAccount(input: {
  readonly accountIndex: number
  readonly walletKind: 'software' | 'private-key' | 'hardware'
  readonly mainAccountId: unknown
  readonly persistedPeaAccountId?: unknown
}): NearPrivateSendAccount | null {
  if (!Number.isSafeInteger(input.accountIndex) || input.accountIndex < 0) return null
  const mainAccountId = canonicalAccountId(input.mainAccountId)
  if (mainAccountId === null) return null
  const keySource: NearPrivateSendKeySource =
    input.walletKind === 'hardware'
      ? 'hardware'
      : input.walletKind === 'private-key'
        ? 'imported'
        : 'software'
  return Object.freeze({
    accountIndex: input.accountIndex,
    keySource,
    mainAccountId,
    peaImplicitAccountId:
      typeof input.persistedPeaAccountId === 'string' ? input.persistedPeaAccountId : null
  })
}

export function buildNearPrivateSendRouteInput(input: {
  readonly chainId: string
  readonly source: NearPrivateSendSource
  readonly assetId: string
  readonly amountRaw: string
  readonly recipient: string
  readonly account: NearPrivateSendAccount
  readonly now: number
  readonly quote?: unknown
}): NearPrivateSendRouteInput | null {
  const deadline = createNearPrivateSendDeadline(input.now)
  if (deadline === null) return null
  return Object.freeze({
    chainId: input.chainId,
    source: input.source,
    assetId: input.assetId,
    amountRaw: input.amountRaw,
    recipient: input.recipient,
    slippageTolerance: NEAR_PRIVATE_SEND_SLIPPAGE_BPS,
    deadline,
    account: input.account,
    ...(input.quote === undefined ? {} : { quote: input.quote })
  })
}

/**
 * A private or Incognito send that cannot be funded stays stopped.
 * It does not become a public transfer, including Main to this account's PEA.
 * The recipient role comes only from resolveNearAddressRole.
 */
export function decideNearSendPage(input: {
  readonly sendPrivately: boolean
  readonly source: NearPrivateSendSource
  readonly route: NearPrivateSendRouteInput
}): NearSendPageDecision {
  if (input.source !== 'main' && input.source !== 'incognito') {
    return Object.freeze({
      action: 'stopped',
      message: 'The private transfer could not be prepared.'
    })
  }
  const account = input.route.account
  const role = resolveNearAddressRole(input.route.recipient, {
    mainAccountId: account.mainAccountId,
    peaImplicitAccountId: account.peaImplicitAccountId
  })
  const privateRequired =
    input.source === 'incognito' || input.sendPrivately || role === 'incognito'
  if (!privateRequired) return Object.freeze({ action: 'public' })
  const described = describeNearPrivateSendRoute(input.route)
  if (!described.ok) return Object.freeze({ action: 'stopped', message: described.message })
  if (!input.sendPrivately && input.source === 'main' && role === 'incognito') {
    return Object.freeze({ action: 'stopped', message: NEAR_PRIVATE_SEND_TOGGLE_MESSAGE })
  }
  return Object.freeze({ action: 'private', route: described })
}

const IMPLICIT_NEAR_ACCOUNT = /^[0-9a-f]{64}$/

/**
 * Public preparation must not run while a private route is required.
 * A 64-hex recipient stays blocked until this account's PEA is known.
 */
export function guardNearPublicPrepare(input: {
  readonly recipient: string
  readonly amountRaw: string
  readonly chainId: string
  readonly assetId: string
  readonly accountStatus: 'loading' | 'ready' | 'error'
  readonly account: NearPrivateSendAccount | null
  readonly now: number
}): string | null {
  const implicit = IMPLICIT_NEAR_ACCOUNT.test(input.recipient)
  if (input.accountStatus === 'loading') return implicit ? 'Loading account...' : null
  if (input.accountStatus !== 'ready' || input.account === null) {
    return implicit ? 'Unable to load account.' : null
  }
  const route = buildNearPrivateSendRouteInput({
    chainId: input.chainId,
    source: 'main',
    assetId: input.assetId,
    amountRaw: input.amountRaw,
    recipient: input.recipient,
    account: input.account,
    now: input.now
  })
  if (route === null) return 'The private transfer could not be prepared.'
  const decision = decideNearSendPage({ sendPrivately: false, source: 'main', route })
  if (decision.action === 'public') return null
  return decision.action === 'stopped'
    ? decision.message
    : 'The private transfer could not be prepared.'
}

export function nearPrivatePreparationMatches(
  prepared: {
    readonly assetId: string
    readonly recipient: string
    readonly amountRaw: string
    readonly signerId: string
  },
  route: NearPrivateSendDepositRoute
): boolean {
  const deposit = route.intentsDeposit
  return (
    deposit.transactionCount === 1 &&
    deposit.kind === 'intents-deposit' &&
    prepared.assetId === deposit.assetId &&
    prepared.recipient === deposit.depositAddress &&
    prepared.amountRaw === deposit.amountRaw &&
    prepared.signerId === deposit.signerId &&
    prepared.recipient !== route.quoteRequest.recipient &&
    prepared.recipient !== route.quoteRequest.refundTo
  )
}
