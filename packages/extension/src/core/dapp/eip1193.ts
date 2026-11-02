import type { EvmContractCallIntent, EvmTransferIntent } from '@/infrastructure/chains/evm'
import type { ChainId } from '@/core/chains/domain'

export const EVM_DAPP_RUNTIME_METHODS = Object.freeze([
  'eth_chainId',
  'net_version',
  'eth_accounts',
  'eth_coinbase',
  'eth_requestAccounts',
  'wallet_getPermissions',
  'wallet_requestPermissions',
  'wallet_revokePermissions',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
  'eth_blockNumber',
  'eth_gasPrice',
  'eth_getBalance',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getTransactionCount',
  'eth_getBlockByHash',
  'eth_getBlockByNumber',
  'eth_getBlockTransactionCountByHash',
  'eth_getBlockTransactionCountByNumber',
  'eth_getTransactionByHash',
  'eth_getTransactionByBlockHashAndIndex',
  'eth_getTransactionByBlockNumberAndIndex',
  'eth_getTransactionReceipt',
  'eth_call',
  'eth_estimateGas',
  'eth_feeHistory',
  'eth_maxPriorityFeePerGas',
  'eth_getLogs',
  'eth_getProof',
  'eth_syncing',
  'eth_sendTransaction',
  'personal_sign',
  'eth_signTypedData_v4'
] as const)

export const EVM_DAPP_READ_METHODS = Object.freeze([
  'eth_blockNumber',
  'eth_gasPrice',
  'eth_getBalance',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getTransactionCount',
  'eth_getBlockByHash',
  'eth_getBlockByNumber',
  'eth_getBlockTransactionCountByHash',
  'eth_getBlockTransactionCountByNumber',
  'eth_getTransactionByHash',
  'eth_getTransactionByBlockHashAndIndex',
  'eth_getTransactionByBlockNumberAndIndex',
  'eth_getTransactionReceipt',
  'eth_call',
  'eth_estimateGas',
  'eth_feeHistory',
  'eth_maxPriorityFeePerGas',
  'eth_getLogs',
  'eth_getProof',
  'eth_syncing'
] as const)

export type EvmDAppReadMethod = (typeof EVM_DAPP_READ_METHODS)[number]

export type EvmDAppRuntimeMethod = (typeof EVM_DAPP_RUNTIME_METHODS)[number]

export type Eip1193ErrorCode = number

export interface Eip1193ErrorShape {
  readonly code: Eip1193ErrorCode
  readonly message: string
}

export class Eip1193ProviderError extends Error {
  readonly code: Eip1193ErrorCode

  constructor(code: Eip1193ErrorCode, message: string) {
    super(message)
    this.name = 'Eip1193ProviderError'
    this.code = code
  }
}

export function toEip1193ErrorShape(error: unknown): Eip1193ErrorShape {
  if (error instanceof Eip1193ProviderError) {
    return Object.freeze({ code: error.code, message: error.message })
  }
  return Object.freeze({ code: -32603, message: 'Noir Wallet could not complete the request.' })
}

function invalidParams(message: string): never {
  throw new Eip1193ProviderError(-32602, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed)
  return Object.keys(value).every(key => allowedSet.has(key))
}

export function parseEvmAddress(value: unknown, label = 'EVM address'): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    invalidParams(`${label} is invalid.`)
  }
  return value.toLowerCase()
}

export function toEip1193ChainId(numericChainId: number): `0x${string}` {
  if (!Number.isSafeInteger(numericChainId) || numericChainId <= 0) {
    throw new Error('Invalid EVM numeric chain ID')
  }
  return `0x${numericChainId.toString(16)}`
}

export interface ParsedEip1193ChainRequest {
  readonly chainId: `0x${string}`
  readonly numericChainId: number
  readonly metadata?: Readonly<{
    readonly chainName: string
    readonly nativeCurrency: Readonly<{
      readonly name: string
      readonly symbol: string
      readonly decimals: number
    }>
    readonly rpcUrls: readonly string[]
    readonly blockExplorerUrls: readonly string[]
  }>
}

function parseBoundedText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length === 0 ||
    [...value].length > maximum ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  ) {
    invalidParams(`${label} is invalid.`)
  }
  return value
}

function parseUrlArray(
  value: unknown,
  label: string,
  required: boolean,
  allowSecureWebSocket = false
): readonly string[] {
  if (
    !Array.isArray(value) ||
    (required && value.length === 0) ||
    value.length > (allowSecureWebSocket ? 128 : 8)
  ) {
    invalidParams(`${label} is invalid.`)
  }
  const urls = value
    .map(candidate => {
      if (typeof candidate !== 'string' || candidate.length > 2_048) {
        invalidParams(`${label} is invalid.`)
      }
      let url: URL
      try {
        url = new URL(candidate)
      } catch {
        invalidParams(`${label} is invalid.`)
      }
      const localDevelopmentHost =
        url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
      if (
        (url.protocol !== 'https:' &&
          !(url.protocol === 'http:' && localDevelopmentHost) &&
          !(allowSecureWebSocket && url.protocol === 'wss:')) ||
        url.username.length > 0 ||
        url.password.length > 0 ||
        url.search.length > 0 ||
        url.hash.length > 0
      ) {
        invalidParams(`${label} must use HTTPS.`)
      }
      // The wallet uses HTTP JSON-RPC; Chainlist also includes secure WebSocket alternatives.
      return url.protocol === 'wss:' ? null : url.toString()
    })
    .filter((url): url is string => url !== null)
  if (required && urls.length === 0) invalidParams(`${label} must include an HTTPS endpoint.`)
  return Object.freeze(urls)
}

export function parseEip1193ChainRequest(
  params: readonly unknown[] | undefined,
  options: { readonly allowAddChainMetadata?: boolean } = {}
): ParsedEip1193ChainRequest {
  if (
    !Array.isArray(params) ||
    (params.length !== 1 && !(options.allowAddChainMetadata && params.length === 2)) ||
    !isRecord(params[0])
  ) {
    invalidParams('A single chain parameter is required.')
  }
  // Chainlist passes an optional account hint after the network. It grants no permissions.
  if (params.length === 2 && params[1] != null) {
    parseEvmAddress(params[1], 'Optional account')
  }
  const value = params[0]
  const allowedKeys = options.allowAddChainMetadata
    ? ['chainId', 'chainName', 'nativeCurrency', 'rpcUrls', 'blockExplorerUrls', 'iconUrls']
    : ['chainId']
  if (!hasOnlyKeys(value, allowedKeys) || typeof value.chainId !== 'string') {
    invalidParams('The requested chain ID is invalid.')
  }
  if (!/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value.chainId)) {
    invalidParams('The requested chain ID is invalid.')
  }
  const numeric = BigInt(value.chainId)
  if (numeric <= 0n || numeric > BigInt(Number.MAX_SAFE_INTEGER)) {
    invalidParams('The requested chain ID is outside the supported range.')
  }
  const chainId = `0x${numeric.toString(16)}` as const
  if (!options.allowAddChainMetadata) {
    return Object.freeze({ chainId, numericChainId: Number(numeric) })
  }
  if (!isRecord(value.nativeCurrency)) invalidParams('Native currency metadata is invalid.')
  if (
    !hasOnlyKeys(value.nativeCurrency, ['name', 'symbol', 'decimals']) ||
    !Number.isSafeInteger(value.nativeCurrency.decimals) ||
    (value.nativeCurrency.decimals as number) < 0 ||
    (value.nativeCurrency.decimals as number) > 255
  ) {
    invalidParams('Native currency decimals must be between 0 and 255.')
  }
  return Object.freeze({
    chainId,
    numericChainId: Number(numeric),
    metadata: Object.freeze({
      chainName: parseBoundedText(value.chainName, 'Chain name', 64),
      nativeCurrency: Object.freeze({
        name: parseBoundedText(value.nativeCurrency.name, 'Native currency name', 64),
        symbol: parseBoundedText(value.nativeCurrency.symbol, 'Native currency symbol', 16),
        decimals: value.nativeCurrency.decimals as number
      }),
      rpcUrls: parseUrlArray(value.rpcUrls, 'RPC URLs', true, true),
      blockExplorerUrls:
        value.blockExplorerUrls === undefined
          ? Object.freeze([])
          : parseUrlArray(value.blockExplorerUrls, 'Block explorer URLs', false)
    })
  })
}

export function parseEthAccountsPermissionRequest(params: readonly unknown[] | undefined): void {
  if (!Array.isArray(params) || params.length !== 1 || !isRecord(params[0])) {
    invalidParams('A permissions object is required.')
  }
  const permissions = params[0]
  if (!hasOnlyKeys(permissions, ['eth_accounts']) || !isRecord(permissions.eth_accounts)) {
    invalidParams('Only the eth_accounts permission is supported.')
  }
  if (Object.keys(permissions.eth_accounts).length !== 0) {
    invalidParams('The eth_accounts permission does not accept caveats.')
  }
}

function parseQuantity(value: unknown, label: string): bigint {
  if (value === undefined) return 0n
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    invalidParams(`${label} must be a canonical hexadecimal quantity.`)
  }
  const parsed = BigInt(value)
  if (parsed >= 1n << 256n) invalidParams(`${label} exceeds uint256.`)
  return parsed
}

function parseHexData(value: unknown, label: string, maximumBytes: number): string {
  if (
    typeof value !== 'string' ||
    !/^0x(?:[0-9a-fA-F]{2})*$/.test(value) ||
    value.length > maximumBytes * 2 + 2
  ) {
    invalidParams(`${label} must be bounded hexadecimal data.`)
  }
  return value.toLowerCase()
}

function assertOptionalChainId(value: unknown, expectedChainId: string): void {
  if (value === undefined) return
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    invalidParams('Transaction chainId is invalid.')
  }
  if (`eip155:${BigInt(value).toString()}` !== expectedChainId) {
    throw new Eip1193ProviderError(4901, 'The requested chain is not active in this wallet build.')
  }
}

export interface ParsedEip1193Transfer {
  readonly from: string
  readonly kind: 'native-transfer' | 'erc20-transfer' | 'erc20-transfer-from' | 'contract-call'
  readonly intent: EvmTransferIntent | EvmContractCallIntent
  readonly tokenContract?: string
  readonly transferFromOwner?: string
}

export type Eip1193ReadBlockTag = 'latest' | 'pending'

export interface ParsedEip1193ReadCall {
  readonly from?: string
  readonly to: string
  readonly valueRaw: string
  readonly data: string
  readonly blockTag: Eip1193ReadBlockTag
}

function parseReadBlockTag(value: unknown, label: string): Eip1193ReadBlockTag {
  if (value !== 'latest' && value !== 'pending') {
    invalidParams(`${label} supports the latest or pending block tag only.`)
  }
  return value
}

function parseReadCallObject(
  value: unknown,
  expectedChainId: ChainId
): Omit<ParsedEip1193ReadCall, 'blockTag'> {
  if (!isRecord(value)) invalidParams('An EVM call object is required.')
  if (!hasOnlyKeys(value, ['from', 'to', 'value', 'data', 'chainId'])) {
    throw new Eip1193ProviderError(
      4200,
      'This release supports bounded EVM contract reads and gas estimates only.'
    )
  }
  assertOptionalChainId(value.chainId, expectedChainId)
  return Object.freeze({
    ...(value.from === undefined ? {} : { from: parseEvmAddress(value.from, 'Call sender') }),
    to: parseEvmAddress(value.to, 'Call recipient'),
    valueRaw: parseQuantity(value.value, 'Call value').toString(),
    data: value.data === undefined ? '0x' : parseHexData(value.data, 'Call data', 128 * 1024)
  })
}

export function parseEip1193Call(
  params: readonly unknown[] | undefined,
  expectedChainId: ChainId
): ParsedEip1193ReadCall {
  if (!Array.isArray(params) || params.length < 1 || params.length > 2) {
    invalidParams('eth_call requires a call object and optional block tag.')
  }
  return Object.freeze({
    ...parseReadCallObject(params[0], expectedChainId),
    blockTag: parseReadBlockTag(params[1] ?? 'latest', 'eth_call')
  })
}

export function parseEip1193EstimateGas(
  params: readonly unknown[] | undefined,
  expectedChainId: ChainId
): Omit<ParsedEip1193ReadCall, 'blockTag'> {
  if (!Array.isArray(params) || params.length !== 1) {
    invalidParams('eth_estimateGas requires a single call object.')
  }
  return parseReadCallObject(params[0], expectedChainId)
}

export function parseEip1193AddressBlockRequest(
  params: readonly unknown[] | undefined,
  input: {
    readonly method: 'eth_getCode' | 'eth_getTransactionCount'
    readonly addressLabel: string
    readonly allowPending: boolean
  }
): Readonly<{ address: string; blockTag: Eip1193ReadBlockTag }> {
  if (!Array.isArray(params) || params.length !== 2) {
    invalidParams(`${input.method} requires an address and block tag.`)
  }
  const blockTag = parseReadBlockTag(params[1], input.method)
  if (!input.allowPending && blockTag !== 'latest') {
    invalidParams(`${input.method} supports the latest block tag only.`)
  }
  return Object.freeze({
    address: parseEvmAddress(params[0], input.addressLabel),
    blockTag
  })
}

export function parseEip1193Transfer(
  params: readonly unknown[] | undefined,
  input: {
    readonly chainId: ChainId
    readonly nativeAssetId: string
    readonly trustedErc20Contract?: string
    readonly trustedErc20AssetId?: string
  }
): ParsedEip1193Transfer {
  if (!Array.isArray(params) || params.length !== 1 || !isRecord(params[0])) {
    invalidParams('A single transaction object is required.')
  }
  const transaction = params[0]
  const supportedKeys: readonly string[] = [
    'from',
    'to',
    'value',
    'data',
    'chainId',
    'gas',
    'gasLimit',
    'gasPrice',
    'maxFeePerGas',
    'maxPriorityFeePerGas',
    'type'
  ]
  const unsupportedKey = Object.keys(transaction).find(key => !supportedKeys.includes(key))
  if (unsupportedKey !== undefined) {
    throw new Eip1193ProviderError(
      4200,
      `Transaction field "${unsupportedKey}" is not supported. Noir Wallet prepares its own nonce and fees.`
    )
  }
  for (const [key, label] of [
    ['gas', 'Transaction gas limit'],
    ['gasLimit', 'Transaction gas limit'],
    ['gasPrice', 'Transaction gas price'],
    ['maxFeePerGas', 'Transaction maximum fee per gas'],
    ['maxPriorityFeePerGas', 'Transaction maximum priority fee per gas']
  ] as const) {
    if (transaction[key] !== undefined) parseQuantity(transaction[key], label)
  }
  if (transaction.type !== undefined) {
    const transactionType = parseQuantity(transaction.type, 'Transaction type')
    if (transactionType > 2n) invalidParams('Transaction type is not supported.')
  }
  const from = parseEvmAddress(transaction.from, 'Transaction sender')
  const to = parseEvmAddress(transaction.to, 'Transaction recipient')
  if (/^0x0{40}$/.test(to)) invalidParams('Transaction recipient cannot be the zero address.')
  assertOptionalChainId(transaction.chainId, input.chainId)
  const value = parseQuantity(transaction.value, 'Transaction value')
  const data =
    transaction.data === undefined ? '0x' : parseHexData(transaction.data, 'data', 128 * 1024)

  if (data === '0x') {
    if (value === 0n) invalidParams('Native transfers must send a non-zero amount.')
    return Object.freeze({
      from,
      kind: 'native-transfer' as const,
      intent: Object.freeze({
        assetId: input.nativeAssetId,
        recipient: to,
        amountRaw: value.toString()
      })
    })
  }

  const transferMatch = /^0xa9059cbb0{24}([0-9a-f]{40})([0-9a-f]{64})$/.exec(data)
  if (value === 0n && transferMatch) {
    const amount = BigInt(`0x${transferMatch[2]}`)
    if (amount === 0n) invalidParams('Token transfers must send a non-zero amount.')
    const assetId =
      input.trustedErc20Contract !== undefined &&
      input.trustedErc20AssetId !== undefined &&
      to === input.trustedErc20Contract.toLowerCase()
        ? input.trustedErc20AssetId
        : `${input.chainId}/erc20:${to}`
    return Object.freeze({
      from,
      kind: 'erc20-transfer' as const,
      tokenContract: to,
      intent: Object.freeze({
        assetId,
        recipient: `0x${transferMatch[1]}`,
        amountRaw: amount.toString()
      })
    })
  }
  if (data.startsWith('0xa9059cbb')) {
    invalidParams('ERC-20 transfer calldata is malformed or includes an unsupported value.')
  }

  const transferFromMatch = /^0x23b872dd0{24}([0-9a-f]{40})0{24}([0-9a-f]{40})([0-9a-f]{64})$/.exec(
    data
  )
  if (value === 0n && transferFromMatch) {
    const amount = BigInt(`0x${transferFromMatch[3]}`)
    if (amount === 0n) invalidParams('Token transfers must send a non-zero amount.')
    const owner = `0x${transferFromMatch[1]}`
    if (owner !== from) {
      invalidParams('ERC-20 transferFrom must spend from the connected account.')
    }
    return Object.freeze({
      from,
      kind: 'erc20-transfer-from' as const,
      tokenContract: to,
      transferFromOwner: owner,
      intent: Object.freeze({
        assetId: `${input.chainId}/erc20:${to}`,
        recipient: `0x${transferFromMatch[2]}`,
        amountRaw: amount.toString()
      })
    })
  }
  if (data.startsWith('0x23b872dd')) {
    invalidParams('ERC-20 transferFrom calldata is malformed or includes an unsupported value.')
  }
  return Object.freeze({
    from,
    kind: 'contract-call' as const,
    intent: Object.freeze({
      chainId: input.chainId,
      contractAddress: to,
      valueRaw: value.toString(),
      calldata: data
    })
  })
}

export interface ParsedPersonalSignRequest {
  readonly address: string
  readonly message: Uint8Array
  readonly displayMessage: string
}

export function parsePersonalSignRequest(
  params: readonly unknown[] | undefined
): ParsedPersonalSignRequest {
  if (!Array.isArray(params) || params.length !== 2) {
    invalidParams('personal_sign requires [hexMessage, address].')
  }
  const messageHex = parseHexData(params[0], 'personal_sign message', 64 * 1024)
  const address = parseEvmAddress(params[1], 'personal_sign account')
  const bytes = Uint8Array.from(
    messageHex
      .slice(2)
      .match(/.{2}/g)
      ?.map(byte => Number.parseInt(byte, 16)) ?? []
  )
  let displayMessage = messageHex
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (!/\p{C}/u.test(decoded)) displayMessage = decoded
  } catch {
    // Non-UTF-8 payloads remain visible as canonical hex.
  }
  return Object.freeze({ address, message: bytes, displayMessage })
}

export interface ParsedTypedDataRequest {
  readonly address: string
  readonly typedDataJson: string
  readonly primaryType: string
}

export function parseTypedDataV4Request(
  params: readonly unknown[] | undefined,
  expectedNumericChainId: number
): ParsedTypedDataRequest {
  if (!Array.isArray(params) || params.length !== 2) {
    invalidParams('eth_signTypedData_v4 requires [address, typedDataJson].')
  }
  const address = parseEvmAddress(params[0], 'typed-data account')
  if (typeof params[1] !== 'string' || params[1].length === 0 || params[1].length > 256 * 1024) {
    invalidParams('Typed data must be a bounded JSON string.')
  }
  let typedData: unknown
  try {
    typedData = JSON.parse(params[1])
  } catch {
    invalidParams('Typed data is not valid JSON.')
  }
  if (!isRecord(typedData) || !isRecord(typedData.domain)) {
    invalidParams('Typed data must include a domain object.')
  }
  const domainChainId = typedData.domain.chainId
  const parsedDomainChainId =
    typeof domainChainId === 'number' && Number.isSafeInteger(domainChainId)
      ? BigInt(domainChainId)
      : typeof domainChainId === 'string' && /^(?:[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(domainChainId)
        ? BigInt(domainChainId)
        : null
  if (parsedDomainChainId !== BigInt(expectedNumericChainId)) {
    throw new Eip1193ProviderError(4901, 'The typed-data domain does not match the active chain.')
  }
  if (typeof typedData.primaryType !== 'string' || typedData.primaryType.length === 0) {
    invalidParams('Typed data primaryType is invalid.')
  }
  return Object.freeze({
    address,
    typedDataJson: params[1],
    primaryType: typedData.primaryType
  })
}
