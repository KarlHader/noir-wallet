import { parseChainId } from './registry'

const CHAIN_ENDPOINT_SETTINGS_SCHEMA_VERSION = 1 as const

export type ChainRpcProtocol =
  | 'evm-json-rpc'
  | 'bitcoin-esplora'
  | 'zcash-lightwalletd'
  | 'solana-json-rpc'
  | 'tron-http-api'
  | 'near-json-rpc'

export interface CustomChainRpcEndpoint {
  readonly protocol: ChainRpcProtocol
  readonly label: string
  readonly url: string
}

export interface CustomChainExplorer {
  readonly label: string
  readonly baseUrl: string
  readonly transactionPath: string
}

export interface ChainEndpointOverride {
  readonly chainId: string
  readonly rpc?: CustomChainRpcEndpoint
  readonly explorer?: CustomChainExplorer
}

export interface SavedChainRpcEndpoint {
  readonly chainId: string
  readonly rpc: CustomChainRpcEndpoint
}

export interface CustomEvmNetwork {
  readonly chainId: `eip155:${string}`
  readonly numericChainId: number
  readonly displayName: string
  readonly nativeCurrency: Readonly<{
    readonly name: string
    readonly symbol: string
    readonly decimals: number
  }>
  readonly rpc: CustomChainRpcEndpoint
  readonly explorer?: CustomChainExplorer
}

export interface ChainEndpointSettings {
  readonly schemaVersion: typeof CHAIN_ENDPOINT_SETTINGS_SCHEMA_VERSION
  readonly activeEvmChainId?: `eip155:${string}`
  readonly customEvmNetworks: readonly CustomEvmNetwork[]
  readonly overrides: readonly ChainEndpointOverride[]
  readonly savedRpcEndpoints?: readonly SavedChainRpcEndpoint[]
}

export const DEFAULT_CHAIN_ENDPOINT_SETTINGS: ChainEndpointSettings = Object.freeze({
  schemaVersion: CHAIN_ENDPOINT_SETTINGS_SCHEMA_VERSION,
  customEvmNetworks: Object.freeze([]),
  overrides: Object.freeze([])
})

let activeChainEndpointSettings: ChainEndpointSettings = DEFAULT_CHAIN_ENDPOINT_SETTINGS

export function setActiveChainEndpointSettings(value?: unknown): ChainEndpointSettings {
  activeChainEndpointSettings = parseChainEndpointSettings(value)
  return activeChainEndpointSettings
}

export function getActiveChainEndpointSettings(): ChainEndpointSettings {
  return activeChainEndpointSettings
}

export function getChainEndpointRuntimeKey(settings: ChainEndpointSettings): string {
  return JSON.stringify({
    activeEvmChainId: settings.activeEvmChainId ?? null,
    customEvmNetworks: settings.customEvmNetworks.map(network => ({
      chainId: network.chainId,
      displayName: network.displayName,
      nativeCurrency: network.nativeCurrency,
      rpc: network.rpc
    })),
    rpcOverrides: settings.overrides.flatMap(override =>
      override.rpc ? [{ chainId: override.chainId, rpc: override.rpc }] : []
    )
  })
}

const RPC_PROTOCOLS = new Set<ChainRpcProtocol>([
  'evm-json-rpc',
  'bitcoin-esplora',
  'zcash-lightwalletd',
  'solana-json-rpc',
  'tron-http-api',
  'near-json-rpc'
])
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string
): void {
  const allowed = new Set([...required, ...optional])
  if (
    required.some(key => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some(key => !allowed.has(key))
  ) {
    throw new Error(`${label} has invalid fields`)
  }
}

function parseLabel(value: unknown, label: string, maximum = 64): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${label}`)
  const normalized = value.normalize('NFC')
  if (
    normalized.length === 0 ||
    normalized.trim() !== normalized ||
    [...normalized].length > maximum ||
    CONTROL_CHARACTERS.test(normalized)
  ) {
    throw new Error(`Invalid ${label}`)
  }
  return normalized
}

function isLocalDevelopmentHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

export function parseCustomServiceUrl(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 2_048) throw new Error(`Invalid ${label}`)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Invalid ${label}`)
  }
  if (
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && isLocalDevelopmentHost(url.hostname))) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(`${label} must be a credential-free HTTPS endpoint`)
  }
  return url.toString()
}

function parseRpcEndpoint(value: unknown, expectedProtocol?: ChainRpcProtocol) {
  if (!isRecord(value)) throw new Error('Invalid custom RPC endpoint')
  assertKeys(value, ['protocol', 'label', 'url'], [], 'Custom RPC endpoint')
  if (
    typeof value.protocol !== 'string' ||
    !RPC_PROTOCOLS.has(value.protocol as ChainRpcProtocol)
  ) {
    throw new Error('Invalid custom RPC protocol')
  }
  const protocol = value.protocol as ChainRpcProtocol
  if (expectedProtocol !== undefined && protocol !== expectedProtocol) {
    throw new Error('Custom RPC protocol does not match its chain')
  }
  const url = parseCustomServiceUrl(value.url, 'custom RPC URL')
  return Object.freeze({
    protocol,
    label: parseLabel(value.label, 'custom RPC label'),
    // The packaged gRPC-Web client appends its service path with a leading slash.
    url: protocol === 'zcash-lightwalletd' ? url.replace(/\/+$/, '') : url
  })
}

function parseExplorer(value: unknown): CustomChainExplorer {
  if (!isRecord(value)) throw new Error('Invalid custom block explorer')
  assertKeys(value, ['label', 'baseUrl'], ['transactionPath'], 'Custom block explorer')
  const baseUrl = new URL(parseCustomServiceUrl(value.baseUrl, 'custom block explorer URL'))
  baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, '')
  const transactionPath =
    value.transactionPath === undefined
      ? 'tx'
      : parseLabel(value.transactionPath, 'custom block explorer transaction path', 64)
  if (
    !/^[A-Za-z0-9._~!$&'()*+,;=:@/-]+$/.test(transactionPath) ||
    transactionPath.startsWith('/') ||
    transactionPath.endsWith('/') ||
    transactionPath.split('/').some(segment => segment === '.' || segment === '..')
  ) {
    throw new Error('Invalid custom block explorer transaction path')
  }
  return Object.freeze({
    label: parseLabel(value.label, 'custom block explorer label'),
    baseUrl: baseUrl.toString().replace(/\/$/, ''),
    transactionPath
  })
}

function protocolForChainId(chainId: string): ChainRpcProtocol {
  const parsed = parseChainId(chainId)
  switch (parsed.namespace) {
    case 'eip155':
      return 'evm-json-rpc'
    case 'bip122':
      throw new Error('BIP-122 endpoint protocol must be selected by the chain adapter')
    case 'solana':
      return 'solana-json-rpc'
    case 'near':
      return 'near-json-rpc'
    default:
      throw new Error('Unsupported custom RPC chain namespace')
  }
}

function parseChainEndpointOverride(value: unknown): ChainEndpointOverride {
  if (!isRecord(value)) throw new Error('Invalid chain endpoint override')
  assertKeys(value, ['chainId'], ['rpc', 'explorer'], 'Chain endpoint override')
  if (typeof value.chainId !== 'string') throw new Error('Invalid endpoint override chain ID')
  const chainId = parseChainId(value.chainId).id
  if (value.rpc === undefined && value.explorer === undefined) {
    throw new Error('Empty chain endpoint override')
  }
  let rpc: CustomChainRpcEndpoint | undefined
  if (value.rpc !== undefined) {
    const expected = chainId.startsWith('bip122:') ? undefined : protocolForChainId(chainId)
    rpc = parseRpcEndpoint(value.rpc, expected)
    if (
      chainId.startsWith('bip122:') &&
      rpc.protocol !== 'bitcoin-esplora' &&
      rpc.protocol !== 'zcash-lightwalletd'
    ) {
      throw new Error('Invalid BIP-122 RPC protocol')
    }
  }
  return Object.freeze({
    chainId,
    ...(rpc === undefined ? {} : { rpc }),
    ...(value.explorer === undefined ? {} : { explorer: parseExplorer(value.explorer) })
  })
}

function parseEvmChainId(value: unknown): {
  readonly chainId: `eip155:${string}`
  readonly numericChainId: number
} {
  if (typeof value !== 'string') throw new Error('Invalid custom EVM chain ID')
  const parsed = parseChainId(value)
  if (parsed.namespace !== 'eip155' || !/^[1-9][0-9]*$/.test(parsed.reference)) {
    throw new Error('Invalid custom EVM chain ID')
  }
  const numericChainId = Number(parsed.reference)
  if (!Number.isSafeInteger(numericChainId)) throw new Error('Custom EVM chain ID is too large')
  return Object.freeze({
    chainId: parsed.id as `eip155:${string}`,
    numericChainId
  })
}

export function parseCustomEvmNetwork(value: unknown): CustomEvmNetwork {
  if (!isRecord(value)) throw new Error('Invalid custom EVM network')
  assertKeys(
    value,
    ['chainId', 'numericChainId', 'displayName', 'nativeCurrency', 'rpc'],
    ['explorer'],
    'Custom EVM network'
  )
  const identity = parseEvmChainId(value.chainId)
  if (value.numericChainId !== identity.numericChainId) {
    throw new Error('Custom EVM numeric chain ID does not match its CAIP-2 ID')
  }
  if (!isRecord(value.nativeCurrency)) throw new Error('Invalid custom EVM native currency')
  assertKeys(value.nativeCurrency, ['name', 'symbol', 'decimals'], [], 'Custom EVM native currency')
  if (
    !Number.isSafeInteger(value.nativeCurrency.decimals) ||
    (value.nativeCurrency.decimals as number) < 0 ||
    (value.nativeCurrency.decimals as number) > 255
  ) {
    throw new Error('Custom EVM native currency decimals must be between 0 and 255')
  }
  return Object.freeze({
    ...identity,
    displayName: parseLabel(value.displayName, 'custom EVM network name'),
    nativeCurrency: Object.freeze({
      name: parseLabel(value.nativeCurrency.name, 'custom EVM native currency name'),
      symbol: parseLabel(value.nativeCurrency.symbol, 'custom EVM native currency symbol', 16),
      decimals: value.nativeCurrency.decimals as number
    }),
    rpc: parseRpcEndpoint(value.rpc, 'evm-json-rpc'),
    ...(value.explorer === undefined ? {} : { explorer: parseExplorer(value.explorer) })
  })
}

export function parseChainEndpointSettings(value: unknown): ChainEndpointSettings {
  if (value === undefined || value === null) return DEFAULT_CHAIN_ENDPOINT_SETTINGS
  if (!isRecord(value)) throw new Error('Invalid chain endpoint settings')
  assertKeys(
    value,
    ['schemaVersion', 'customEvmNetworks', 'overrides'],
    ['activeEvmChainId', 'savedRpcEndpoints'],
    'Chain endpoint settings'
  )
  if (value.schemaVersion !== CHAIN_ENDPOINT_SETTINGS_SCHEMA_VERSION) {
    throw new Error('Unsupported chain endpoint settings version')
  }
  if (
    !Array.isArray(value.customEvmNetworks) ||
    value.customEvmNetworks.length > 32 ||
    !Array.isArray(value.overrides) ||
    value.overrides.length > 64
  ) {
    throw new Error('Chain endpoint settings exceed the supported limits')
  }
  const customEvmNetworks = Object.freeze(value.customEvmNetworks.map(parseCustomEvmNetwork))
  const overrides = Object.freeze(value.overrides.map(parseChainEndpointOverride))
  let savedRpcEndpoints: readonly SavedChainRpcEndpoint[] | undefined
  if (value.savedRpcEndpoints !== undefined) {
    if (!Array.isArray(value.savedRpcEndpoints) || value.savedRpcEndpoints.length > 128) {
      throw new Error('Saved RPC endpoints exceed the supported limits')
    }
    savedRpcEndpoints = Object.freeze(
      value.savedRpcEndpoints.map(item => {
        if (!isRecord(item)) throw new Error('Invalid saved RPC endpoint')
        assertKeys(item, ['chainId', 'rpc'], [], 'Saved RPC endpoint')
        const parsed = parseChainEndpointOverride(item)
        if (!parsed.rpc) throw new Error('Missing saved RPC endpoint')
        return Object.freeze({ chainId: parsed.chainId, rpc: parsed.rpc })
      })
    )
    const identities = savedRpcEndpoints.map(item => `${item.chainId}:${item.rpc.url}`)
    if (new Set(identities).size !== identities.length)
      throw new Error('Duplicate saved RPC endpoints')
  }
  const customChainIds = customEvmNetworks.map(network => network.chainId)
  const overrideChainIds = overrides.map(override => override.chainId)
  if (
    new Set(customChainIds).size !== customChainIds.length ||
    new Set(overrideChainIds).size !== overrideChainIds.length
  ) {
    throw new Error('Duplicate custom chain endpoint settings')
  }
  const activeEvmChainId =
    value.activeEvmChainId === undefined
      ? undefined
      : parseEvmChainId(value.activeEvmChainId).chainId
  return Object.freeze({
    schemaVersion: CHAIN_ENDPOINT_SETTINGS_SCHEMA_VERSION,
    ...(activeEvmChainId === undefined ? {} : { activeEvmChainId }),
    customEvmNetworks,
    overrides,
    ...(savedRpcEndpoints === undefined ? {} : { savedRpcEndpoints })
  })
}

export function findChainEndpointOverride(
  settings: ChainEndpointSettings,
  chainId: string
): ChainEndpointOverride | undefined {
  const normalized = parseChainId(chainId).id
  return settings.overrides.find(override => override.chainId === normalized)
}

export function withChainEndpointOverride(
  settings: ChainEndpointSettings,
  override: ChainEndpointOverride
): ChainEndpointSettings {
  const parsed = parseChainEndpointOverride(override)
  return parseChainEndpointSettings({
    ...settings,
    overrides: [...settings.overrides.filter(item => item.chainId !== parsed.chainId), parsed]
  })
}

function withoutChainEndpointOverride(
  settings: ChainEndpointSettings,
  chainId: string
): ChainEndpointSettings {
  const normalized = parseChainId(chainId).id
  return parseChainEndpointSettings({
    ...settings,
    overrides: settings.overrides.filter(item => item.chainId !== normalized)
  })
}

export function withChainRpcEndpoint(
  settings: ChainEndpointSettings,
  chainId: string,
  rpc?: CustomChainRpcEndpoint
): ChainEndpointSettings {
  const existing = findChainEndpointOverride(settings, chainId)
  if (rpc === undefined && existing?.explorer === undefined) {
    return withoutChainEndpointOverride(settings, chainId)
  }
  return withChainEndpointOverride(settings, {
    chainId,
    ...(rpc === undefined ? {} : { rpc }),
    ...(existing?.explorer === undefined ? {} : { explorer: existing.explorer })
  })
}

export function withSavedChainRpcEndpoint(
  settings: ChainEndpointSettings,
  chainId: string,
  rpc: CustomChainRpcEndpoint
): ChainEndpointSettings {
  const selected = withChainRpcEndpoint(settings, chainId, rpc)
  const normalized = findChainEndpointOverride(selected, chainId)
  if (!normalized?.rpc) throw new Error('Missing saved RPC endpoint')
  return parseChainEndpointSettings({
    ...selected,
    savedRpcEndpoints: [
      ...(settings.savedRpcEndpoints ?? []).filter(
        item => item.chainId !== normalized.chainId || item.rpc.url !== normalized.rpc?.url
      ),
      { chainId: normalized.chainId, rpc: normalized.rpc }
    ]
  })
}

export function withoutSavedChainRpcEndpoint(
  settings: ChainEndpointSettings,
  chainId: string,
  url: string
): ChainEndpointSettings {
  const normalizedChainId = parseChainId(chainId).id
  const normalizedUrl = parseCustomServiceUrl(url, 'saved RPC URL')
  const selected = findChainEndpointOverride(settings, normalizedChainId)?.rpc
  const next =
    selected && new URL(selected.url).toString() === normalizedUrl
      ? withChainRpcEndpoint(settings, normalizedChainId)
      : settings
  return parseChainEndpointSettings({
    ...next,
    savedRpcEndpoints: (settings.savedRpcEndpoints ?? []).filter(
      item =>
        item.chainId !== normalizedChainId || new URL(item.rpc.url).toString() !== normalizedUrl
    )
  })
}

export function withChainExplorer(
  settings: ChainEndpointSettings,
  chainId: string,
  explorer?: CustomChainExplorer
): ChainEndpointSettings {
  const existing = findChainEndpointOverride(settings, chainId)
  if (explorer === undefined && existing?.rpc === undefined) {
    return withoutChainEndpointOverride(settings, chainId)
  }
  return withChainEndpointOverride(settings, {
    chainId,
    ...(existing?.rpc === undefined ? {} : { rpc: existing.rpc }),
    ...(explorer === undefined ? {} : { explorer })
  })
}

export function withActiveEvmChainId(
  settings: ChainEndpointSettings,
  chainId: string
): ChainEndpointSettings {
  return parseChainEndpointSettings({
    ...settings,
    activeEvmChainId: parseEvmChainId(chainId).chainId
  })
}

export function withCustomEvmNetwork(
  settings: ChainEndpointSettings,
  network: CustomEvmNetwork
): ChainEndpointSettings {
  const parsed = parseCustomEvmNetwork(network)
  return parseChainEndpointSettings({
    ...settings,
    customEvmNetworks: [
      ...settings.customEvmNetworks.filter(item => item.chainId !== parsed.chainId),
      parsed
    ]
  })
}

export function withoutCustomEvmNetwork(
  settings: ChainEndpointSettings,
  chainId: string
): ChainEndpointSettings {
  const normalized = parseEvmChainId(chainId).chainId
  return parseChainEndpointSettings({
    ...settings,
    ...(settings.activeEvmChainId === normalized ? { activeEvmChainId: undefined } : {}),
    customEvmNetworks: settings.customEvmNetworks.filter(item => item.chainId !== normalized),
    overrides: settings.overrides.filter(item => item.chainId !== normalized),
    ...(settings.savedRpcEndpoints === undefined
      ? {}
      : {
          savedRpcEndpoints: settings.savedRpcEndpoints.filter(item => item.chainId !== normalized)
        })
  })
}
