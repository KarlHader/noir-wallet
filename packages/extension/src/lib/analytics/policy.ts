import {
  ANALYTICS_EVENTS,
  PAGE_IDS,
  resolveAnalyticsChain,
  type AnalyticsEventName
} from './constants.ts'
import type { TrackOptions } from './types.ts'
import { sanitizeCollectorMetrics } from './collector-metrics.ts'

type SafeAnalyticsValue = string | number | boolean

type EventFieldPolicy = {
  readonly params: readonly string[]
  readonly extra: readonly string[]
}

const EVENT_FIELD_POLICIES = {
  [ANALYTICS_EVENTS.ASSET_RECEIVED]: { params: [], extra: [] },
  [ANALYTICS_EVENTS.BALANCE_SNAPSHOT]: { params: [], extra: [] },
  [ANALYTICS_EVENTS.EXTENSION_ENGAGEMENT]: { params: [], extra: [] },
  [ANALYTICS_EVENTS.EXTENSION_INSTALLED]: { params: [], extra: [] },
  [ANALYTICS_EVENTS.EXTENSION_UPDATED]: {
    params: ['previous_version'],
    extra: []
  },
  [ANALYTICS_EVENTS.WALLET_CREATED]: {
    params: ['method'],
    extra: ['has_birthday_height', 'hardware']
  },
  [ANALYTICS_EVENTS.WALLET_UNLOCKED]: { params: [], extra: ['from_dapp'] },
  [ANALYTICS_EVENTS.SHOW_PAGE]: { params: [], extra: [] },
  [ANALYTICS_EVENTS.SEND_SUBMITTED]: {
    params: [],
    extra: ['fee_tier', 'hardware', 'funding_source', 'sourceFamily', 'kind']
  },
  [ANALYTICS_EVENTS.SEND_SUCCEEDED]: {
    params: ['hardware'],
    extra: ['funding_source', 'kind', 'sourceFamily']
  },
  [ANALYTICS_EVENTS.SEND_FAILED]: {
    params: [],
    extra: ['funding_source', 'kind', 'phase', 'sourceFamily']
  },
  [ANALYTICS_EVENTS.SHIELD_SUCCEEDED]: { params: [], extra: [] },
  [ANALYTICS_EVENTS.SHIELD_FAILED]: { params: [], extra: [] },
  [ANALYTICS_EVENTS.SHIELD_OPERATION_RESULT]: { params: [], extra: ['operation', 'status'] },
  [ANALYTICS_EVENTS.SWAP_QUOTED]: { params: [], extra: ['direction', 'sourceFamily'] },
  [ANALYTICS_EVENTS.SWAP_SUBMITTED]: {
    params: [],
    extra: ['direction', 'hardware', 'funding_source', 'sourceFamily']
  },
  [ANALYTICS_EVENTS.SWAP_DEPOSIT_SENT]: {
    params: ['from_token', 'to_token'],
    extra: ['direction', 'sourceFamily']
  },
  [ANALYTICS_EVENTS.SWAP_FAILED]: { params: [], extra: ['direction', 'sourceFamily'] },
  [ANALYTICS_EVENTS.SWAP_COMPLETED]: {
    params: [],
    extra: ['status', 'action', 'direction', 'sourceFamily']
  },
  [ANALYTICS_EVENTS.HW_CONNECTED]: {
    params: [],
    extra: ['is_existing_wallet', 'hardware']
  },
  [ANALYTICS_EVENTS.HW_SIGN_FAILED]: {
    params: [],
    extra: ['kind', 'phase']
  },
  [ANALYTICS_EVENTS.DAPP_CONNECTED]: {
    params: [],
    extra: ['account_count', 'source']
  },
  [ANALYTICS_EVENTS.DAPP_DISCONNECTED]: { params: [], extra: [] },
  [ANALYTICS_EVENTS.DAPP_REQUEST_REJECTED]: {
    params: [],
    extra: ['method']
  },
  [ANALYTICS_EVENTS.DAPP_TRANSACTION_SENT]: {
    params: [],
    extra: ['funding_source', 'hardware']
  },
  [ANALYTICS_EVENTS.DAPP_TRANSACTION_FAILED]: {
    params: [],
    extra: ['funding_source', 'hardware']
  },
  [ANALYTICS_EVENTS.DAPP_MESSAGE_SIGNED]: {
    params: [],
    extra: ['signing_mode']
  }
} as const satisfies Record<AnalyticsEventName, EventFieldPolicy>

const eventNames = new Set<string>(Object.values(ANALYTICS_EVENTS))
const pageIds = new Set<string>(Object.values(PAGE_IDS))
const directions = new Set([
  'zec_source',
  'multichain_source',
  'zec_to_other',
  'other_to_zec',
  'same_chain',
  'cross_chain'
])
const actions = new Set([
  'Swap',
  'Supply',
  'Withdraw',
  'Claim',
  'Transfer',
  'Cross-chain Send',
  'swap',
  'supply',
  'withdraw',
  'claim',
  'send',
  'transfer',
  'cross_chain_send'
])
const dappMethods = new Set([
  'connect',
  'sendTransaction',
  'signMessage',
  'shieldFunds',
  'session',
  'requestAccounts',
  'getAddresses',
  'getBalance',
  'getPublicKey',
  'getTransactionHistory'
])
const connectionSources = new Set(['wallet_prompt', 'approval', 'wallet', 'session'])
const kinds = new Set([
  'send',
  'swap',
  'shield',
  'private-transfer',
  'transfer',
  'claim',
  'withdraw'
])
const phases = new Set(['build', 'sign', 'broadcast', 'submit'])
const terminalStatuses = new Set(['SUCCESS', 'FAILED', 'REFUNDED'])
const shieldOperations = new Set(['deposit', 'withdraw', 'cluster', 'swap'])
const shieldResults = new Set(['success', 'refunded', 'failed', 'expired', 'cancelled'])

function isSafeValue(value: unknown): value is SafeAnalyticsValue {
  if (typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  return typeof value === 'string' && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value)
}

function isAllowedFieldValue(
  eventName: AnalyticsEventName,
  key: string,
  value: unknown
): value is SafeAnalyticsValue {
  if (!isSafeValue(value)) return false
  if (key === 'sourceFamily') return resolveAnalyticsChain(value) !== undefined
  if (key === 'direction') return typeof value === 'string' && directions.has(value)
  if (key === 'action') return typeof value === 'string' && actions.has(value)
  if (key === 'funding_source') {
    return ['shielded', 'transparent', 'main', 'private'].includes(String(value))
  }
  if (key === 'source') return typeof value === 'string' && connectionSources.has(value)
  if (key === 'kind') return typeof value === 'string' && kinds.has(value)
  if (key === 'phase') return typeof value === 'string' && phases.has(value)
  if (key === 'operation') {
    return (
      eventName === ANALYTICS_EVENTS.SHIELD_OPERATION_RESULT &&
      typeof value === 'string' &&
      shieldOperations.has(value)
    )
  }
  if (key === 'status' && eventName === ANALYTICS_EVENTS.SHIELD_OPERATION_RESULT) {
    return typeof value === 'string' && shieldResults.has(value)
  }
  if (key === 'status') return typeof value === 'string' && terminalStatuses.has(value)
  if (key === 'signing_mode') {
    return value === 'derived' || value === 'current' || value === 'legacy_index0'
  }
  if (key === 'fee_tier') return value === 'low' || value === 'standard' || value === 'fast'
  if (key === 'hardware') {
    if (
      eventName === ANALYTICS_EVENTS.WALLET_CREATED ||
      eventName === ANALYTICS_EVENTS.HW_CONNECTED
    ) {
      return value === 'ledger' || value === 'keystone'
    }
    return typeof value === 'boolean'
  }
  if (key === 'from_token' || key === 'to_token') {
    return typeof value === 'string' && /^[A-Za-z0-9._-]{1,16}$/.test(value)
  }
  if (key === 'account_count')
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100
  if (key === 'from_dapp' || key === 'has_birthday_height' || key === 'is_existing_wallet') {
    return typeof value === 'boolean'
  }
  if (key === 'method' && eventName === ANALYTICS_EVENTS.WALLET_CREATED) {
    return ['create', 'import', 'hardware', 'private_key'].includes(String(value))
  }
  if (key === 'method' && eventName === ANALYTICS_EVENTS.DAPP_REQUEST_REJECTED) {
    return typeof value === 'string' && dappMethods.has(value)
  }
  return true
}

function pickAllowedFields(
  value: Record<string, unknown> | undefined,
  allowedFields: readonly string[],
  eventName: AnalyticsEventName
): Record<string, SafeAnalyticsValue> | undefined {
  if (!value || allowedFields.length === 0) return undefined
  const allowed = new Set(allowedFields)
  const entries = Object.entries(value).filter(
    (entry): entry is [string, SafeAnalyticsValue] =>
      allowed.has(entry[0]) && isAllowedFieldValue(eventName, entry[0], entry[1])
  )
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function sanitizeTokenLabel(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : undefined
}

export function sanitizeAnalyticsEvent(
  name: string,
  options: TrackOptions = {}
): { readonly name: AnalyticsEventName; readonly options: TrackOptions } | null {
  if (!eventNames.has(name)) return null

  const eventName = name as AnalyticsEventName
  const policy = EVENT_FIELD_POLICIES[eventName]
  const params = pickAllowedFields(options.params, policy.params, eventName)
  const extra = pickAllowedFields(options.extra, policy.extra, eventName)
  const collector = sanitizeCollectorMetrics(eventName, options.collector)
  const pageId =
    typeof options.pageId === 'string' && pageIds.has(options.pageId)
      ? options.pageId
      : PAGE_IDS.BACKGROUND
  const inputSymbol = sanitizeTokenLabel(options.inputSymbol)
  const outputSymbol = sanitizeTokenLabel(options.outputSymbol)
  const chain = resolveAnalyticsChain(options.chain)
  if (options.chain !== undefined && !chain) return null
  const idempotencyKey =
    typeof options.idempotencyKey === 'string' &&
    options.idempotencyKey.length > 0 &&
    options.idempotencyKey.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(options.idempotencyKey)
      ? options.idempotencyKey
      : undefined
  if (options.idempotencyKey !== undefined && !idempotencyKey) return null

  return {
    name: eventName,
    options: {
      pageId,
      ...(chain ? { chain } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(options.hasTransaction === 0 || options.hasTransaction === 1
        ? { hasTransaction: options.hasTransaction }
        : {}),
      ...(inputSymbol ? { inputSymbol } : {}),
      ...(outputSymbol ? { outputSymbol } : {}),
      ...(params ? { params } : {}),
      ...(extra ? { extra } : {}),
      ...(collector ? { collector } : {})
    }
  }
}
