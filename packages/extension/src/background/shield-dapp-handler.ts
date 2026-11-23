import type { Network } from '@/types'
import { isAddress } from 'viem'
import type { ConfidentialFundingCoordinator } from './confidential-funding-coordinator'
import { ShieldProviderError, isShieldUnlockRetryError } from '@/core/dapp/shield-provider'
import type { ShieldDappOperationReport } from '@/core/services/confidential-funding/shield-dapp-projection'

const NEAR_CONFIDENTIAL_LAYER = 'near-confidential'
const CATALOG_KEYS = new Set([
  'layer',
  'action',
  'destinationKind',
  'sourceChainId',
  'destinationChainId'
])

type ShieldScope = Readonly<{
  network: Network
  keyDomainId: string
  accountId: string
}>

/**
 * Imported private-key accounts live in Storage V2 and clear the retained
 * wallet-store pointer. Prefer that active account, and keep the retained
 * pointer only when Storage V2 has not selected one.
 */
export function resolveShieldDappScope(input: {
  readonly network: Network
  readonly activeAccount: Readonly<{ walletId: string; accountId: string }> | null
  readonly retainedWalletId: string | null
  readonly retainedAccountId: string | null
}): ShieldScope | null {
  const retained =
    input.retainedWalletId && input.retainedAccountId
      ? { walletId: input.retainedWalletId, accountId: input.retainedAccountId }
      : null
  const selected =
    input.activeAccount?.walletId && input.activeAccount.accountId ? input.activeAccount : retained
  if (!selected) return null
  return Object.freeze({
    network: input.network,
    keyDomainId: selected.walletId,
    accountId: selected.accountId
  })
}

function readParams(params: unknown): Record<string, unknown> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new ShieldProviderError(-32602, 'Shield request params must be an object.')
  }
  return params as Record<string, unknown>
}

function requireLayerOnly(params: unknown, label: string): void {
  const record = readParams(params)
  const keys = Object.keys(record)
  if (keys.length !== 1 || record.layer !== NEAR_CONFIDENTIAL_LAYER) {
    throw new ShieldProviderError(-32602, `${label} requires layer "near-confidential".`)
  }
}

const DECIMAL_CHAIN = /^[1-9]\d*$/
const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/

function normalizeShieldChainId(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ShieldProviderError(-32602, 'Shield chain ID is invalid.')
    }
    return `eip155:${value}`
  }
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    value.length > 128
  ) {
    throw new ShieldProviderError(-32602, 'Shield chain ID is invalid.')
  }
  if (DECIMAL_CHAIN.test(value) || value.startsWith('eip155:') || /^0x[0-9a-fA-F]+$/.test(value)) {
    const reference = DECIMAL_CHAIN.test(value)
      ? value
      : value.startsWith('eip155:')
        ? value.slice('eip155:'.length)
        : String(Number.parseInt(value.slice(2), 16))
    if (value.startsWith('0x') || value.startsWith('0X')) {
      const body = value.slice(2)
      if (body.length > 1 && body.startsWith('0')) {
        throw new ShieldProviderError(-32602, 'Shield chain ID is invalid.')
      }
      const parsed = Number.parseInt(body, 16)
      if (
        !Number.isSafeInteger(parsed) ||
        parsed <= 0 ||
        body.toLowerCase() !== parsed.toString(16)
      ) {
        throw new ShieldProviderError(-32602, 'Shield chain ID is invalid.')
      }
      return `eip155:${parsed}`
    }
    if (!DECIMAL_CHAIN.test(reference)) {
      throw new ShieldProviderError(-32602, 'Shield chain ID is invalid.')
    }
    const parsed = Number(reference)
    if (!Number.isSafeInteger(parsed) || String(parsed) !== reference) {
      throw new ShieldProviderError(-32602, 'Shield chain ID is invalid.')
    }
    return `eip155:${parsed}`
  }
  if (!CAIP2.test(value)) {
    throw new ShieldProviderError(-32602, 'Shield chain ID is invalid.')
  }
  return value
}

function readTokenRef(
  value: unknown,
  label: string
): Readonly<{ chainId: string; assetId: string }> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ShieldProviderError(-32602, `${label} is invalid.`)
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (
    keys.length === 0 ||
    keys.some(key => key !== 'chainId' && key !== 'assetId' && key !== 'symbol') ||
    !Object.prototype.hasOwnProperty.call(record, 'chainId') ||
    !Object.prototype.hasOwnProperty.call(record, 'assetId')
  ) {
    throw new ShieldProviderError(-32602, `${label} is invalid.`)
  }
  const chainId = normalizeShieldChainId(record.chainId)
  const assetId = record.assetId
  if (
    typeof assetId !== 'string' ||
    assetId.length === 0 ||
    assetId.length > 256 ||
    assetId !== assetId.trim() ||
    !assetId.startsWith(`${chainId}/`)
  ) {
    throw new ShieldProviderError(-32602, `${label} does not match its chain.`)
  }
  return Object.freeze({ chainId, assetId })
}

const SHIELD_OPERATION_ID = /^[a-zA-Z0-9:_-]{1,128}$/

function readShieldOperationId(params: unknown): string {
  const record = readParams(params)
  const keys = Object.keys(record)
  if (
    keys.length !== 2 ||
    keys.some(key => key !== 'layer' && key !== 'operationId') ||
    record.layer !== NEAR_CONFIDENTIAL_LAYER
  ) {
    throw new ShieldProviderError(-32602, 'Shield status query requires layer "near-confidential".')
  }
  const operationId = record.operationId
  if (typeof operationId !== 'string' || !SHIELD_OPERATION_ID.test(operationId)) {
    throw new ShieldProviderError(-32602, 'Shield operation id is invalid.')
  }
  return operationId
}

function readQuoteAmount(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    value !== value.trim()
  ) {
    throw new ShieldProviderError(-32602, 'Shield amount is invalid.')
  }
  return value
}

type ShieldTransferDestination =
  | Readonly<{ kind: 'public'; chainId: string; address: string }>
  | Readonly<{ kind: 'confidential'; accountId: string; chainId?: string }>

function readTransferDestination(value: unknown): ShieldTransferDestination {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ShieldProviderError(-32602, 'Shield destination is invalid.')
  }
  const record = value as Record<string, unknown>
  if (
    Object.prototype.hasOwnProperty.call(record, 'assetId') ||
    Object.prototype.hasOwnProperty.call(record, 'symbol')
  ) {
    throw new ShieldProviderError(-32602, 'Shield destination token cannot be selected.')
  }
  if (record.kind === 'confidential') {
    const keys = Object.keys(record)
    if (keys.length < 2 || keys.some(key => !['kind', 'accountId', 'chainId'].includes(key))) {
      throw new ShieldProviderError(-32602, 'Shield destination is invalid.')
    }
    const accountId = record.accountId
    if (typeof accountId !== 'string' || !isAddress(accountId) || /^0x0{40}$/i.test(accountId)) {
      throw new ShieldProviderError(-32602, 'Confidential recipient account ID is invalid.')
    }
    const chainId = Object.prototype.hasOwnProperty.call(record, 'chainId')
      ? normalizeShieldChainId(record.chainId)
      : undefined
    return Object.freeze({
      kind: 'confidential',
      accountId,
      ...(chainId !== undefined ? { chainId } : {})
    })
  }
  if (record.kind !== 'public') {
    throw new ShieldProviderError(-32602, 'Shield destination is invalid.')
  }
  const keys = Object.keys(record)
  if (keys.length !== 3 || keys.some(key => !['kind', 'chainId', 'address'].includes(key))) {
    throw new ShieldProviderError(-32602, 'Shield destination is invalid.')
  }
  const chainId = normalizeShieldChainId(record.chainId)
  const address = record.address
  if (
    typeof address !== 'string' ||
    address.length === 0 ||
    address.length > 256 ||
    address !== address.trim() ||
    /[\u0000-\u001f\u007f]/.test(address)
  ) {
    throw new ShieldProviderError(-32602, 'Shield destination address is invalid.')
  }
  return Object.freeze({ kind: 'public', chainId, address })
}

function requireCatalogQuery(params: unknown): void {
  const record = readParams(params)
  const keys = Object.keys(record)
  if (
    keys.length === 0 ||
    keys.some(key => !CATALOG_KEYS.has(key)) ||
    record.layer !== NEAR_CONFIDENTIAL_LAYER
  ) {
    throw new ShieldProviderError(-32602, 'Shield catalog requires layer "near-confidential".')
  }
  if (record.action !== 'receive' && record.action !== 'transfer') {
    throw new ShieldProviderError(-32602, 'Shield catalog requires action "receive" or "transfer".')
  }
  if (
    Object.prototype.hasOwnProperty.call(record, 'destinationKind') &&
    record.destinationKind !== 'public' &&
    record.destinationKind !== 'confidential'
  ) {
    throw new ShieldProviderError(-32602, 'Shield destination kind is invalid.')
  }
}

type ShieldApprovalAction = 'shieldConnect' | 'shieldReceive' | 'shieldTransfer'

function requireShieldOrigin(origin: string | undefined): string {
  if (typeof origin !== 'string' || origin.length === 0 || origin.length > 2048) {
    throw new ShieldProviderError(4100, 'This site is not authorized for Shield.')
  }
  try {
    const url = new URL(origin)
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== origin) {
      throw new Error('invalid origin')
    }
  } catch (error) {
    if (error instanceof ShieldProviderError) throw error
    throw new ShieldProviderError(4100, 'This site is not authorized for Shield.')
  }
  return origin
}

function sameShieldScope(left: ShieldScope, right: ShieldScope): boolean {
  return (
    left.network === right.network &&
    left.keyDomainId === right.keyDomainId &&
    left.accountId === right.accountId
  )
}

async function readAuthorizedShieldScope(input: {
  readonly readScope?: () => Promise<ShieldScope | null>
}): Promise<ShieldScope> {
  if (!input.readScope) {
    throw new ShieldProviderError(4900, 'Shield approval is unavailable.')
  }
  const scope = await input.readScope()
  if (!scope) {
    throw new ShieldProviderError(4100, 'Select an active account before using Shield.')
  }
  return scope
}

type ShieldSite = Readonly<{ origin: string; scope: ShieldScope }>

async function readCurrentShieldSite(input: {
  readonly origin?: string
  readonly scope: ShieldScope
  readonly readScope?: () => Promise<ShieldScope | null>
}): Promise<ShieldSite> {
  const origin = requireShieldOrigin(input.origin)
  const scope = await readAuthorizedShieldScope(input)
  if (!sameShieldScope(scope, input.scope)) {
    throw new ShieldProviderError(
      4100,
      'This site authorization changed. Review the request again.'
    )
  }
  return Object.freeze({ origin, scope })
}

async function requireGrantedShieldSite(input: {
  readonly origin?: string
  readonly scope: ShieldScope
  readonly readScope?: () => Promise<ShieldScope | null>
  readonly coordinator: ConfidentialFundingCoordinator
}): Promise<ShieldSite> {
  const site = await readCurrentShieldSite(input)
  if (!(await input.coordinator.shieldDappAuthorized(site.origin, site.scope))) {
    throw new ShieldProviderError(4100, 'This site is not authorized for Shield.')
  }
  return site
}

export async function handleShieldDAppRequest(input: {
  readonly method: string
  readonly params: unknown
  readonly coordinator: ConfidentialFundingCoordinator | null
  readonly origin?: string
  readonly scope: ShieldScope | null
  readonly readScope?: () => Promise<ShieldScope | null>
  readonly requestApproval?: (
    action: ShieldApprovalAction,
    summary: Readonly<Record<string, string>>
  ) => Promise<boolean>
  readonly unlock?: () => Promise<void>
}): Promise<
  Readonly<
    | { layer: typeof NEAR_CONFIDENTIAL_LAYER; connected: true }
    | { layer: typeof NEAR_CONFIDENTIAL_LAYER; connected: false }
    | { layer: typeof NEAR_CONFIDENTIAL_LAYER; balances: readonly unknown[] }
    | { layer: typeof NEAR_CONFIDENTIAL_LAYER; chains: readonly unknown[] }
    | { layer: typeof NEAR_CONFIDENTIAL_LAYER; tokens: readonly unknown[] }
    | {
        layer: typeof NEAR_CONFIDENTIAL_LAYER
        action: 'receive' | 'transfer'
        amount: string
        fee: string
        expectedReceive: string
        expiresAt: number
        source: Readonly<{ chainId: string; assetId: string; symbol: string }>
        destination: Readonly<{ chainId: string; assetId: string; symbol: string }>
      }
    | ShieldDappOperationReport
  >
> {
  if (!input.coordinator) {
    throw new ShieldProviderError(4200, 'Shield is unavailable in this wallet build.')
  }
  if (!input.scope) {
    throw new ShieldProviderError(4100, 'Select an active account before using Shield.')
  }
  const site = {
    origin: input.origin,
    scope: input.scope,
    readScope: input.readScope,
    coordinator: input.coordinator
  }
  if (input.method === 'shield_connect') {
    requireLayerOnly(input.params, 'Shield connect')
    const { origin, scope } = await readCurrentShieldSite(site)
    if (!input.requestApproval) {
      throw new ShieldProviderError(4900, 'Shield approval is unavailable.')
    }
    let approved = false
    try {
      approved = await input.requestApproval('shieldConnect', { layer: NEAR_CONFIDENTIAL_LAYER })
    } catch {
      throw new ShieldProviderError(4900, 'Shield approval is unavailable.')
    }
    if (!approved) {
      throw new ShieldProviderError(4001, 'The Shield connection was rejected.')
    }
    const grant = async () => {
      const current = await readCurrentShieldSite(site)
      if (current.origin !== origin || !sameShieldScope(current.scope, scope)) {
        throw new ShieldProviderError(
          4100,
          'This site authorization changed. Review the request again.'
        )
      }
      await site.coordinator.grantShieldDapp(origin, current.scope)
    }
    try {
      await grant()
    } catch (error) {
      // Retrying the whole request after unlock would ask for a second approval.
      if (!input.unlock || !isShieldUnlockRetryError(error)) throw error
      await input.unlock()
      await grant()
    }
    return Object.freeze({ layer: NEAR_CONFIDENTIAL_LAYER, connected: true })
  }
  if (input.method === 'shield_disconnect') {
    requireLayerOnly(input.params, 'Shield disconnect')
    const { origin, scope } = await readCurrentShieldSite(site)
    await input.coordinator.revokeShieldDapp(origin, scope)
    return Object.freeze({ layer: NEAR_CONFIDENTIAL_LAYER, connected: false })
  }
  if (input.method === 'shield_getQuote') {
    const { scope } = await requireGrantedShieldSite(site)
    const record = readParams(input.params)
    const keys = Object.keys(record)
    if (record.layer !== NEAR_CONFIDENTIAL_LAYER) {
      throw new ShieldProviderError(-32602, 'Shield quote requires layer "near-confidential".')
    }
    const amount = readQuoteAmount(record.amount)
    if (record.action === 'receive') {
      if (
        keys.length !== 4 ||
        keys.some(key => !['layer', 'action', 'amount', 'source'].includes(key))
      ) {
        throw new ShieldProviderError(-32602, 'Shield receive quote is invalid.')
      }
      return input.coordinator.quoteShieldDapp({
        scope,
        action: 'receive',
        amount,
        source: readTokenRef(record.source, 'Shield source')
      })
    }
    if (record.action === 'transfer') {
      if (
        keys.length !== 5 ||
        keys.some(key => !['layer', 'action', 'amount', 'token', 'destination'].includes(key))
      ) {
        throw new ShieldProviderError(-32602, 'Shield transfer quote is invalid.')
      }
      return input.coordinator.quoteShieldDapp({
        scope,
        action: 'transfer',
        amount,
        source: readTokenRef(record.token, 'Shield token'),
        destination: readTransferDestination(record.destination)
      })
    }
    throw new ShieldProviderError(-32602, 'Shield quote requires action "receive" or "transfer".')
  }
  if (input.method === 'shield_refreshBalances') {
    requireLayerOnly(input.params, 'Shield balance refresh')
    const { scope } = await requireGrantedShieldSite(site)
    const balances = await input.coordinator.refreshShieldDappBalances(scope, false)
    return Object.freeze({ layer: NEAR_CONFIDENTIAL_LAYER, balances })
  }
  if (
    input.method === 'shield_getSupportedChains' ||
    input.method === 'shield_getSupportedTokens'
  ) {
    requireCatalogQuery(input.params)
    const catalog = input.coordinator.listShieldDappCatalog()
    return input.method === 'shield_getSupportedChains'
      ? Object.freeze({ layer: NEAR_CONFIDENTIAL_LAYER, chains: catalog.chains })
      : Object.freeze({ layer: NEAR_CONFIDENTIAL_LAYER, tokens: catalog.tokens })
  }
  if (input.method === 'shield_getTransactionStatus') {
    const { scope } = await requireGrantedShieldSite(site)
    return input.coordinator.readShieldDappStatus({
      scope,
      operationId: readShieldOperationId(input.params)
    })
  }
  if (input.method === 'shield_receive' || input.method === 'shield_transfer') {
    const { origin, scope } = await requireGrantedShieldSite(site)
    const request = {
      params: input.params,
      coordinator: input.coordinator,
      origin,
      scope,
      requestApproval: input.requestApproval,
      verifySite: () => requireGrantedShieldSite(site)
    }
    return input.method === 'shield_receive' ? receiveShield(request) : transferShield(request)
  }
  throw new ShieldProviderError(4200, 'The requested Shield method is not supported.')
}

const SHIELD_APPROVAL_FIELDS = [
  'amount',
  'symbol',
  'chainName',
  'assetId',
  'sourceAddress',
  'expectedReceive',
  'expectedSymbol',
  'quoteDifference',
  'networkFee',
  'networkFeeSymbol',
  'destinationAddress',
  'destinationChainName',
  'destinationSymbol',
  'destinationAssetId'
] as const

function shieldApprovalAwaiting(
  phase: string | undefined
): phase is undefined | 'prepared' | 'needs-auth' {
  return phase === undefined || phase === 'prepared' || phase === 'needs-auth'
}

function shieldApprovalSummary(prepared: object): Readonly<Record<string, string>> {
  const record = prepared as Record<string, unknown>
  const summary: Record<string, string> = { layer: NEAR_CONFIDENTIAL_LAYER }
  for (const key of SHIELD_APPROVAL_FIELDS) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) summary[key] = value
  }
  return Object.freeze(summary)
}

interface ShieldOperationRequest {
  readonly params: unknown
  readonly coordinator: ConfidentialFundingCoordinator
  readonly origin: string
  readonly scope: ShieldScope
  readonly requestApproval?: (
    action: ShieldApprovalAction,
    summary: Readonly<Record<string, string>>
  ) => Promise<boolean>
  readonly verifySite: () => Promise<ShieldSite>
}

async function confirmApprovedShieldPlan(
  input: ShieldOperationRequest,
  prepared: Readonly<{ planId: string; payloadFingerprint: string }>,
  rejectPrepared: () => Promise<void>
): Promise<ShieldDappOperationReport> {
  let current: ShieldSite
  try {
    current = await input.verifySite()
  } catch (error) {
    await rejectPrepared()
    throw error
  }
  if (!sameShieldScope(current.scope, input.scope)) {
    await rejectPrepared()
    throw new ShieldProviderError(
      4100,
      'This site authorization changed. Review the request again.'
    )
  }
  const plan = await input.coordinator.confirm(prepared.planId, prepared.payloadFingerprint)
  return input.coordinator.reportStoredShieldDappPlan(plan)
}

async function receiveShield(input: ShieldOperationRequest): Promise<ShieldDappOperationReport> {
  const record = readParams(input.params)
  const keys = Object.keys(record)
  if (
    keys.length !== 3 ||
    keys.some(key => !['layer', 'source', 'amount'].includes(key)) ||
    record.layer !== NEAR_CONFIDENTIAL_LAYER
  ) {
    throw new ShieldProviderError(-32602, 'Shield receive is invalid.')
  }
  const prepared = await input.coordinator.prepareShieldDappReceive({
    origin: input.origin,
    scope: input.scope,
    amount: readQuoteAmount(record.amount),
    source: readTokenRef(record.source, 'Shield source')
  })
  if (!shieldApprovalAwaiting(prepared.phase)) {
    return input.coordinator.reportStoredShieldDappPlan(
      await input.coordinator.getPlan(prepared.planId)
    )
  }
  const rejectPrepared = async () => {
    await input.coordinator.cancel(prepared.planId).catch(() => undefined)
  }
  if (!input.requestApproval) {
    await rejectPrepared()
    throw new ShieldProviderError(4900, 'Shield approval is unavailable.')
  }
  let approved = false
  try {
    approved = await input.requestApproval('shieldReceive', shieldApprovalSummary(prepared))
  } catch {
    await rejectPrepared()
    throw new ShieldProviderError(4900, 'Shield approval is unavailable.')
  }
  if (!approved) {
    await rejectPrepared()
    throw new ShieldProviderError(4001, 'The Shield receive was rejected.')
  }
  return confirmApprovedShieldPlan(input, prepared, rejectPrepared)
}

async function transferShield(input: ShieldOperationRequest): Promise<ShieldDappOperationReport> {
  const record = readParams(input.params)
  const keys = Object.keys(record)
  if (
    keys.length !== 4 ||
    keys.some(key => !['layer', 'token', 'amount', 'destination'].includes(key)) ||
    record.layer !== NEAR_CONFIDENTIAL_LAYER
  ) {
    throw new ShieldProviderError(-32602, 'Shield transfer is invalid.')
  }
  const prepared = await input.coordinator.prepareShieldDappTransfer({
    origin: input.origin,
    scope: input.scope,
    amount: readQuoteAmount(record.amount),
    token: readTokenRef(record.token, 'Shield token'),
    destination: readTransferDestination(record.destination)
  })
  if (!shieldApprovalAwaiting(prepared.phase)) {
    return input.coordinator.reportStoredShieldDappPlan(
      await input.coordinator.getPlan(prepared.planId)
    )
  }
  const rejectPrepared = async () => {
    await input.coordinator.cancel(prepared.planId).catch(() => undefined)
  }
  if (!input.requestApproval) {
    await rejectPrepared()
    throw new ShieldProviderError(4900, 'Shield approval is unavailable.')
  }
  let approved = false
  try {
    approved = await input.requestApproval('shieldTransfer', shieldApprovalSummary(prepared))
  } catch {
    await rejectPrepared()
    throw new ShieldProviderError(4900, 'Shield approval is unavailable.')
  }
  if (!approved) {
    await rejectPrepared()
    throw new ShieldProviderError(4001, 'The Shield transfer was rejected.')
  }
  return confirmApprovedShieldPlan(input, prepared, rejectPrepared)
}
