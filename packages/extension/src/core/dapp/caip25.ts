import { parseChainId } from '@/core/chains/registry'
import type { AccountRef } from './dapp-manager'

export const CAIP25_RUNTIME_METHODS = Object.freeze([
  'wallet_createSession',
  'wallet_getSession',
  'wallet_revokeSession',
  'wallet_invokeMethod'
] as const)

export type Caip25RuntimeMethod = (typeof CAIP25_RUNTIME_METHODS)[number]

export interface Caip25ScopeRequest {
  readonly chains?: readonly string[]
  readonly accounts?: readonly string[]
  readonly methods: readonly string[]
  readonly notifications: readonly string[]
}

export interface Caip25CreateSessionRequest {
  readonly scopes: Readonly<Record<string, Caip25ScopeRequest>>
  readonly properties?: Readonly<Record<string, unknown>>
}

export interface Caip25SessionScope {
  readonly accounts: readonly string[]
  readonly methods: readonly string[]
  readonly notifications: readonly string[]
  readonly capabilities?: Readonly<Record<string, unknown>>
}

export interface Caip25Session {
  readonly scopes: Readonly<Record<string, Caip25SessionScope>>
  readonly properties?: Readonly<Record<string, unknown>>
}

export interface Caip25StoredScope {
  readonly chainId: string
  readonly methods: readonly string[]
  readonly notifications: readonly string[]
  readonly accounts?: readonly AccountRef[]
}

export interface Caip25StoredSession {
  readonly scopes: readonly Caip25StoredScope[]
  readonly properties?: Readonly<Record<string, unknown>>
}

export interface Caip27InvokeMethodRequest {
  readonly scope: string
  readonly request: {
    readonly method: string
    readonly params?: readonly unknown[] | Readonly<Record<string, unknown>>
  }
}

export class Caip25ProviderError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message)
    this.name = 'Caip25ProviderError'
  }
}

const MAX_SCOPES = 16
const MAX_SCOPE_VALUES = 128
const MAX_METHOD_LENGTH = 128
const MAX_NOTIFICATION_LENGTH = 128
const MAX_PROPERTIES = 64
const MAX_PROPERTY_KEY_LENGTH = 128
const MAX_STORED_ACCOUNT_REFS = 100

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every(key => allowed.has(key))
}

function parseScopeChainId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Caip25ProviderError(-32602, 'Invalid CAIP-25 scope chain.')
  }
  try {
    return parseChainId(value).id
  } catch {
    throw new Caip25ProviderError(-32602, 'Invalid CAIP-25 scope chain.')
  }
}

function parseCaip10Account(value: string): { readonly id: string; readonly chainId: string } {
  if (value.length === 0 || value.length > 512) {
    throw new Caip25ProviderError(-32602, 'Invalid scope account.')
  }
  const firstSeparator = value.indexOf(':')
  const secondSeparator = value.indexOf(':', firstSeparator + 1)
  if (
    firstSeparator <= 0 ||
    secondSeparator <= firstSeparator + 1 ||
    secondSeparator === value.length - 1
  ) {
    throw new Caip25ProviderError(-32602, 'Invalid scope account.')
  }
  const chainId = parseScopeChainId(value.slice(0, secondSeparator))
  const address = value.slice(secondSeparator + 1)
  if (!/^[A-Za-z0-9._%+-]{1,256}$/.test(address)) {
    throw new Caip25ProviderError(-32602, 'Invalid scope account address.')
  }
  return Object.freeze({ id: `${chainId}:${address}`, chainId })
}

function parseUniqueStrings(
  value: unknown,
  label: string,
  options: { readonly allowEmpty: boolean; readonly maxLength: number }
): readonly string[] {
  if (
    !Array.isArray(value) ||
    (!options.allowEmpty && value.length === 0) ||
    value.length > MAX_SCOPE_VALUES
  ) {
    throw new Caip25ProviderError(-32602, `Invalid ${label}.`)
  }
  const values = value.map(item => {
    if (
      typeof item !== 'string' ||
      item.length === 0 ||
      item.length > options.maxLength ||
      item.trim() !== item
    ) {
      throw new Caip25ProviderError(-32602, `Invalid ${label}.`)
    }
    return item
  })
  if (new Set(values).size !== values.length) {
    throw new Caip25ProviderError(-32602, `Duplicate ${label}.`)
  }
  return Object.freeze(values)
}

function copyJsonValue(value: unknown, depth = 0): unknown {
  if (depth > 8) throw new Caip25ProviderError(-32602, 'Session properties are too deeply nested.')
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Caip25ProviderError(-32602, 'Invalid session property.')
    return value
  }
  if (typeof value === 'string') {
    if (value.length > 4_096) throw new Caip25ProviderError(-32602, 'Session property is too long.')
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > 128) throw new Caip25ProviderError(-32602, 'Too many session properties.')
    return Object.freeze(value.map(item => copyJsonValue(item, depth + 1)))
  }
  if (!isRecord(value) || Object.keys(value).length > MAX_PROPERTIES) {
    throw new Caip25ProviderError(-32602, 'Invalid session properties.')
  }
  const result: Record<string, unknown> = Object.create(null)
  for (const [key, item] of Object.entries(value)) {
    if (key.length === 0 || key.length > MAX_PROPERTY_KEY_LENGTH) {
      throw new Caip25ProviderError(-32602, 'Invalid session property key.')
    }
    result[key] = copyJsonValue(item, depth + 1)
  }
  return Object.freeze(result)
}

export function parseCaip25ScopeRequest(chainIdValue: string, value: unknown): Caip25ScopeRequest {
  const chainId = parseScopeChainId(chainIdValue)
  if (!isRecord(value) || !hasOnlyKeys(value, ['chains', 'accounts', 'methods', 'notifications'])) {
    throw new Caip25ProviderError(-32602, `Invalid scope for ${chainId}.`)
  }
  const chains =
    value.chains === undefined
      ? undefined
      : parseUniqueStrings(value.chains, 'scope chains', {
          allowEmpty: false,
          maxLength: 128
        }).map(parseScopeChainId)
  if (chains && (chains.length !== 1 || chains[0] !== chainId)) {
    throw new Caip25ProviderError(5100, `Scope ${chainId} can only contain its own chain.`)
  }
  const accounts =
    value.accounts === undefined
      ? undefined
      : parseUniqueStrings(value.accounts, 'scope accounts', {
          allowEmpty: true,
          maxLength: 512
        }).map(item => {
          const account = parseCaip10Account(item)
          if (account.chainId !== chainId) {
            throw new Caip25ProviderError(5100, `Account ${item} does not belong to ${chainId}.`)
          }
          return account.id
        })
  return Object.freeze({
    ...(chains === undefined ? {} : { chains: Object.freeze(chains) }),
    ...(accounts === undefined ? {} : { accounts: Object.freeze(accounts) }),
    methods: parseUniqueStrings(value.methods, 'scope methods', {
      allowEmpty: false,
      maxLength: MAX_METHOD_LENGTH
    }),
    notifications: parseUniqueStrings(value.notifications, 'scope notifications', {
      allowEmpty: true,
      maxLength: MAX_NOTIFICATION_LENGTH
    })
  })
}

export function parseCaip25CreateSessionRequest(value: unknown): Caip25CreateSessionRequest {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['scopes', 'properties']) ||
    !isRecord(value.scopes)
  ) {
    throw new Caip25ProviderError(-32602, 'Invalid wallet_createSession parameters.')
  }
  const entries = Object.entries(value.scopes)
  if (entries.length === 0 || entries.length > MAX_SCOPES) {
    throw new Caip25ProviderError(-32602, 'A session requires a bounded non-empty scope set.')
  }
  const scopes: Record<string, Caip25ScopeRequest> = Object.create(null)
  for (const [key, scopeValue] of entries) {
    const chainId = parseScopeChainId(key)
    if (Object.prototype.hasOwnProperty.call(scopes, chainId)) {
      throw new Caip25ProviderError(-32602, `Duplicate scope ${chainId}.`)
    }
    scopes[chainId] = parseCaip25ScopeRequest(chainId, scopeValue)
  }
  return Object.freeze({
    scopes: Object.freeze(scopes),
    ...(value.properties === undefined
      ? {}
      : { properties: copyJsonValue(value.properties) as Readonly<Record<string, unknown>> })
  })
}

export function parseCaip25NoParams(value: unknown): void {
  if (
    value !== undefined &&
    !(Array.isArray(value) && value.length === 0) &&
    !(isRecord(value) && Object.keys(value).length === 0)
  ) {
    throw new Caip25ProviderError(-32602, 'This method does not accept parameters.')
  }
}

export function parseCaip27InvokeMethodRequest(value: unknown): Caip27InvokeMethodRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, ['scope', 'request']) || !isRecord(value.request)) {
    throw new Caip25ProviderError(-32602, 'Invalid wallet_invokeMethod parameters.')
  }
  const requestKeys = value.request.params === undefined ? ['method'] : ['method', 'params']
  if (
    !hasOnlyKeys(value.request, requestKeys) ||
    typeof value.request.method !== 'string' ||
    value.request.method.length === 0 ||
    value.request.method.length > MAX_METHOD_LENGTH ||
    (value.request.params !== undefined &&
      !Array.isArray(value.request.params) &&
      !isRecord(value.request.params))
  ) {
    throw new Caip25ProviderError(-32602, 'Invalid wallet_invokeMethod request.')
  }
  return Object.freeze({
    scope: parseScopeChainId(value.scope),
    request: Object.freeze({
      method: value.request.method,
      ...(value.request.params === undefined
        ? {}
        : {
            params: value.request.params as readonly unknown[] | Readonly<Record<string, unknown>>
          })
    })
  })
}

export function parseStoredCaip25Session(value: unknown): Caip25StoredSession {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['scopes', 'properties']) ||
    !Array.isArray(value.scopes)
  ) {
    throw new Error('Invalid stored CAIP-25 session')
  }
  if (value.scopes.length === 0 || value.scopes.length > MAX_SCOPES) {
    throw new Error('Invalid stored CAIP-25 scopes')
  }
  const scopes = value.scopes.map(candidate => {
    if (
      !isRecord(candidate) ||
      !hasOnlyKeys(candidate, ['chainId', 'methods', 'notifications', 'accounts'])
    ) {
      throw new Error('Invalid stored CAIP-25 scope')
    }
    if (typeof candidate.chainId !== 'string') throw new Error('Invalid stored CAIP-25 chain')
    let accounts: readonly AccountRef[] | undefined
    if (candidate.accounts !== undefined) {
      if (
        !Array.isArray(candidate.accounts) ||
        candidate.accounts.length > MAX_STORED_ACCOUNT_REFS
      ) {
        throw new Error('Invalid stored CAIP-25 scope accounts')
      }
      const seen = new Set<string>()
      accounts = Object.freeze(
        candidate.accounts.map((account: unknown) => {
          if (
            !isRecord(account) ||
            !hasOnlyKeys(account, ['walletId', 'accountId']) ||
            Object.keys(account).length !== 2 ||
            typeof account.walletId !== 'string' ||
            account.walletId.length === 0 ||
            account.walletId.length > 256 ||
            typeof account.accountId !== 'string' ||
            account.accountId.length === 0 ||
            account.accountId.length > 256
          ) {
            throw new Error('Invalid stored CAIP-25 scope account')
          }
          const key = JSON.stringify([account.walletId, account.accountId])
          if (seen.has(key)) throw new Error('Duplicate stored CAIP-25 scope account')
          seen.add(key)
          return Object.freeze({ walletId: account.walletId, accountId: account.accountId })
        })
      )
    }
    return Object.freeze({
      chainId: parseChainId(candidate.chainId).id,
      ...(accounts === undefined ? {} : { accounts }),
      methods: parseUniqueStrings(candidate.methods, 'stored scope methods', {
        allowEmpty: false,
        maxLength: MAX_METHOD_LENGTH
      }),
      notifications: parseUniqueStrings(candidate.notifications, 'stored scope notifications', {
        allowEmpty: true,
        maxLength: MAX_NOTIFICATION_LENGTH
      })
    })
  })
  if (new Set(scopes.map(scope => scope.chainId)).size !== scopes.length) {
    throw new Error('Duplicate stored CAIP-25 scope')
  }
  return Object.freeze({
    scopes: Object.freeze(scopes),
    ...(value.properties === undefined
      ? {}
      : { properties: copyJsonValue(value.properties) as Readonly<Record<string, unknown>> })
  })
}

export function caip25SessionAllowsMethod(
  session: Caip25StoredSession | null | undefined,
  chainIdValue: string,
  method: string
): boolean {
  if (!session) return true
  const chainId = parseChainId(chainIdValue).id
  const scope = session.scopes.find(candidate => candidate.chainId === chainId)
  return scope === undefined || scope.methods.includes(method)
}
