/**
 * Noir Wallet providers injected into the page. Page requests are forwarded
 * across the isolated content-script bridge; secrets never enter this realm.
 */

import {
  decodeBase58,
  decodeBase64,
  encodeBase64,
  normalizeSolanaTransactionOptions,
  registerSolanaWalletStandard,
  type SolanaTransactionOptions
} from './solana-wallet-standard'
import { registerNearConnectWallet } from './near-connect-wallet'
import { NOIR_WALLET_PROVIDER_ICON, NOIR_WALLET_PROVIDER_NAME } from './provider-brand'

interface ProviderRequestArguments {
  readonly method: string
  readonly params?: readonly unknown[] | Readonly<Record<string, unknown>>
}

type ProviderListener = (data: unknown) => void

interface ChainProvider {
  request: (args: ProviderRequestArguments) => Promise<unknown>
  on: (event: string, handler: ProviderListener) => ChainProvider
  removeListener: (event: string, handler: ProviderListener) => ChainProvider
  disconnect: () => Promise<void>
}

interface EthereumProvider {
  readonly isNoirWallet: true
  readonly selectedAddress: string | null
  readonly chainId: string | null
  request: (args: ProviderRequestArguments) => Promise<unknown>
  on: (event: string, handler: ProviderListener) => EthereumProvider
  removeListener: (event: string, handler: ProviderListener) => EthereumProvider
  isConnected: () => boolean
}

interface EarlyEthereumProviderRegistration {
  readonly provider: EthereumProvider
  readonly attach: (provider: EthereumProvider) => void
}

interface BitcoinProvider {
  request: (args: ProviderRequestArguments) => Promise<unknown>
  connect: () => Promise<{ readonly address: string; readonly publicKey: string }>
  requestAccounts: () => Promise<readonly string[]>
  getAccounts: () => Promise<readonly string[]>
  getNetwork: () => Promise<'livenet' | 'testnet'>
  getChain: () => Promise<Readonly<Record<string, unknown>>>
  getPublicKey: () => Promise<string>
  getBalance: () => Promise<{
    readonly confirmed: number
    readonly unconfirmed: number
    readonly total: number
  }>
  sendBitcoin: (
    recipient: string,
    satoshis: number,
    options?: { readonly feeRate?: number }
  ) => Promise<string>
  signMessage: (message: string, type?: 'bip322-simple') => Promise<string>
  signPsbt: (psbtHex: string, options?: { readonly autoFinalized?: boolean }) => Promise<string>
  signPsbts: (
    psbtHexes: readonly string[],
    options?: readonly ({ readonly autoFinalized?: boolean } | undefined)[]
  ) => Promise<readonly string[]>
  pushPsbt: (psbtHex: string) => Promise<string>
  pushTx: (options: { readonly rawtx: string }) => Promise<string>
  switchNetwork: (network: 'livenet' | 'testnet') => Promise<null>
  switchChain: (chain: { readonly enum: 'BITCOIN_MAINNET' | 'BITCOIN_TESTNET' }) => Promise<null>
  on: (event: string, handler: ProviderListener) => BitcoinProvider
  removeListener: (event: string, handler: ProviderListener) => BitcoinProvider
  disconnect: () => Promise<void>
}

interface SolanaPublicKey {
  readonly toBytes: () => Uint8Array
  readonly toBuffer: () => Uint8Array
  readonly toString: () => string
  readonly equals: (value: { readonly toString: () => string }) => boolean
}

interface SolanaProvider {
  readonly isNoirWallet: true
  readonly isConnected: boolean
  readonly publicKey: SolanaPublicKey | null
  connect: () => Promise<{ readonly publicKey: SolanaPublicKey }>
  getAccounts: () => Promise<readonly string[]>
  disconnect: () => Promise<void>
  signTransaction: (
    transaction: Uint8Array,
    options?: Pick<SolanaTransactionOptions, 'preflightCommitment' | 'minContextSlot'>
  ) => Promise<Uint8Array>
  signAllTransactions: (transactions: readonly Uint8Array[]) => Promise<readonly Uint8Array[]>
  signAndSendTransaction: (
    transaction: Uint8Array,
    options?: SolanaTransactionOptions
  ) => Promise<{ readonly signature: string }>
  signMessage: (
    message: Uint8Array
  ) => Promise<{ readonly signature: Uint8Array; readonly publicKey: Uint8Array }>
  on: (event: string, handler: ProviderListener) => SolanaProvider
  removeListener: (event: string, handler: ProviderListener) => SolanaProvider
}

interface NearProvider {
  requestSignIn: (params?: {
    readonly contractId?: string
    readonly methodNames?: readonly string[]
  }) => Promise<{ readonly accountId: string; readonly accessKey: { readonly publicKey: string } }>
  getAccounts: () => Promise<readonly string[]>
  signOut: () => Promise<void>
  isSignedIn: () => boolean
  getAccountId: () => string | null
  signTransaction: (params: unknown) => Promise<string>
  requestSignTransactions: (
    params: unknown
  ) => Promise<{ readonly txs: readonly { readonly signedTx: string }[] }>
  signAndSendTransaction: (params: unknown) => Promise<Readonly<Record<string, unknown>>>
  signAndSendTransactions: (
    params: unknown
  ) => Promise<readonly Readonly<Record<string, unknown>>[]>
  signMessage: (params: unknown) => Promise<{
    readonly accountId: string
    readonly publicKey: string
    readonly signature: string
    readonly state?: string
  }>
  on: (event: string, handler: ProviderListener) => NearProvider
  removeListener: (event: string, handler: ProviderListener) => NearProvider
}

interface MultichainProvider {
  request: (args: ProviderRequestArguments) => Promise<unknown>
  createSession: (params: Readonly<Record<string, unknown>>) => Promise<unknown>
  getSession: () => Promise<unknown>
  invokeMethod: (params: Readonly<Record<string, unknown>>) => Promise<unknown>
  revokeSession: () => Promise<null>
  on: (event: 'wallet_sessionChanged', handler: ProviderListener) => MultichainProvider
  removeListener: (event: 'wallet_sessionChanged', handler: ProviderListener) => MultichainProvider
}

interface NoirWalletProvider {
  readonly isNoirWallet: true
  readonly version: string
  readonly request: (args: ProviderRequestArguments) => Promise<unknown>
  readonly multichain: MultichainProvider
  readonly zcash: ChainProvider
  readonly ethereum?: EthereumProvider
  readonly bitcoin?: BitcoinProvider
  readonly solana?: SolanaProvider
  readonly near?: NearProvider
}

interface ProviderErrorValue {
  readonly code: number
  readonly message: string
}

class ProviderRpcError extends Error {
  readonly code: number

  constructor(error: ProviderErrorValue) {
    super(error.message)
    this.name = 'ProviderRpcError'
    this.code = error.code
  }
}

const eventListeners = new Map<string, Set<ProviderListener>>()
let lastEvmChainChangedEvent: string | null = null
const appVersion = import.meta.env.NOIR_APP_VERSION
const networkMode = import.meta.env.NOIR_NETWORK_MODE
const enabledChainFeatureFlags = import.meta.env.NOIR_ENABLED_CHAIN_FEATURE_FLAGS
const evmProviderEnabled = enabledChainFeatureFlags.includes('chain.evm')
const bitcoinProviderEnabled = enabledChainFeatureFlags.includes('chain.bitcoin')
const solanaProviderEnabled = enabledChainFeatureFlags.includes('chain.solana')
const nearProviderEnabled = enabledChainFeatureFlags.includes('chain.near')
const REQUEST_TIMEOUT_MS = 300_000
const bridgeReady = new Promise<void>(resolve => {
  window.addEventListener('noirwallet#bridgeReady', () => resolve(), { once: true })
  window.dispatchEvent(new Event('noirwallet#requestBridgeReady'))
})

function generateRequestId(): string {
  return `noir_${crypto.randomUUID()}`
}

function parseProviderError(value: unknown): ProviderErrorValue {
  if (typeof value === 'string' && value.length > 0) {
    return Object.freeze({ code: -32603, message: value })
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    if (
      Number.isSafeInteger(record.code) &&
      typeof record.message === 'string' &&
      record.message.length > 0
    ) {
      return Object.freeze({ code: record.code as number, message: record.message })
    }
  }
  return Object.freeze({ code: -32603, message: 'Noir Wallet returned an invalid error.' })
}

function emitProviderEvent(chainId: string, eventName: string, data: unknown): void {
  if (chainId === 'evm' && eventName === 'chainChanged' && typeof data === 'string') {
    if (lastEvmChainChangedEvent === data) return
    lastEvmChainChangedEvent = data
  }
  const handlers = eventListeners.get(`${chainId}:${eventName}`)
  if (!handlers) return
  for (const handler of [...handlers]) {
    try {
      handler(data)
    } catch (error) {
      console.error(`[Noir Wallet Provider - ${chainId}] event handler failed:`, error)
    }
  }
}

function addProviderListener(chainId: string, event: string, handler: ProviderListener): void {
  if (typeof event !== 'string' || event.length === 0 || typeof handler !== 'function') {
    throw new TypeError('Provider event and handler are required.')
  }
  const key = `${chainId}:${event}`
  const handlers = eventListeners.get(key) ?? new Set<ProviderListener>()
  handlers.add(handler)
  eventListeners.set(key, handlers)
}

function removeProviderListener(chainId: string, event: string, handler: ProviderListener): void {
  const key = `${chainId}:${event}`
  const handlers = eventListeners.get(key)
  handlers?.delete(handler)
  if (handlers?.size === 0) eventListeners.delete(key)
}

async function requestProvider(
  chainId: 'zcash' | 'evm' | 'bitcoin' | 'solana' | 'near' | 'multichain',
  args: ProviderRequestArguments
) {
  if (
    !args ||
    typeof args !== 'object' ||
    typeof args.method !== 'string' ||
    args.method.length === 0 ||
    args.method.length > 128 ||
    (args.params !== undefined &&
      !Array.isArray(args.params) &&
      (typeof args.params !== 'object' || args.params === null))
  ) {
    throw new ProviderRpcError({ code: -32602, message: 'Invalid provider request.' })
  }

  return new Promise<unknown>((resolve, reject) => {
    const requestId = generateRequestId()
    let settled = false
    const timeoutHandle = window.setTimeout(() => {
      settled = true
      window.removeEventListener('message', responseHandler)
      reject(new ProviderRpcError({ code: 4900, message: 'Noir Wallet request timed out.' }))
    }, REQUEST_TIMEOUT_MS)

    const responseHandler = (event: MessageEvent) => {
      if (event.source !== window) return
      if (event.data?.target !== 'noir-provider') return
      if (event.data?.requestId !== requestId) return

      settled = true
      window.clearTimeout(timeoutHandle)
      window.removeEventListener('message', responseHandler)
      if (event.data.error !== undefined) {
        reject(new ProviderRpcError(parseProviderError(event.data.error)))
      } else {
        resolve(event.data.result)
      }
    }

    window.addEventListener('message', responseHandler)
    void bridgeReady.then(() => {
      if (settled) return
      window.postMessage(
        {
          target: 'noir-content-script',
          type: 'NOIR_REQUEST',
          requestId,
          chainId,
          payload: {
            method: args.method,
            ...(args.params === undefined ? {} : { params: args.params })
          }
        },
        window.location.origin
      )
    })
  })
}

function createMultichainProvider(): MultichainProvider {
  const provider: MultichainProvider = {
    request: args => requestProvider('multichain', args),
    createSession: params =>
      requestProvider('multichain', { method: 'wallet_createSession', params }),
    getSession: () => requestProvider('multichain', { method: 'wallet_getSession' }),
    invokeMethod: params =>
      requestProvider('multichain', { method: 'wallet_invokeMethod', params }),
    revokeSession: () =>
      requestProvider('multichain', { method: 'wallet_revokeSession' }) as Promise<null>,
    on(event, handler) {
      addProviderListener('multichain', event, handler)
      return provider
    },
    removeListener(event, handler) {
      removeProviderListener('multichain', event, handler)
      return provider
    }
  }
  return Object.freeze(provider)
}

function createZcashProvider(): ChainProvider {
  const provider: ChainProvider = {
    request: args => requestProvider('zcash', args),
    on(event, handler) {
      addProviderListener('zcash', event, handler)
      return provider
    },
    removeListener(event, handler) {
      removeProviderListener('zcash', event, handler)
      return provider
    },
    async disconnect() {
      await requestProvider('zcash', { method: 'zcash_disconnect', params: [] })
    }
  }
  return Object.freeze(provider)
}

function createEthereumProvider(): EthereumProvider {
  let selectedAddress: string | null = null
  let chainId: string | null = null
  let chainRevision = 0
  let connected = false

  const markConnected = (nextChainId: string) => {
    const shouldEmit = !connected
    if (chainId !== nextChainId) {
      chainId = nextChainId
      chainRevision += 1
    }
    connected = true
    if (shouldEmit) {
      emitProviderEvent('evm', 'connect', Object.freeze({ chainId: nextChainId }))
    }
  }

  const provider: EthereumProvider = {
    isNoirWallet: true,
    get selectedAddress() {
      return selectedAddress
    },
    get chainId() {
      return chainId
    },
    async request(args) {
      const requestChainRevision = chainRevision
      const result = await requestProvider('evm', args)
      if (
        args.method === 'eth_chainId' &&
        typeof result === 'string' &&
        requestChainRevision === chainRevision
      ) {
        markConnected(result)
      }
      if (args.method === 'wallet_switchEthereumChain' && Array.isArray(args.params)) {
        const requested = args.params[0]
        if (
          requested &&
          typeof requested === 'object' &&
          'chainId' in requested &&
          typeof requested.chainId === 'string' &&
          chainId !== requested.chainId.toLowerCase()
        ) {
          chainId = requested.chainId.toLowerCase()
          chainRevision += 1
          emitProviderEvent('evm', 'chainChanged', chainId)
        }
      }
      if (
        (args.method === 'eth_accounts' || args.method === 'eth_requestAccounts') &&
        Array.isArray(result)
      ) {
        const previousAddress = selectedAddress
        selectedAddress = typeof result[0] === 'string' ? result[0] : null
        if (selectedAddress !== previousAddress) {
          emitProviderEvent('evm', 'accountsChanged', result)
        }
      }
      if (args.method === 'wallet_revokePermissions') selectedAddress = null
      return result
    },
    on(event, handler) {
      addProviderListener('evm', event, handler)
      return provider
    },
    removeListener(event, handler) {
      removeProviderListener('evm', event, handler)
      return provider
    },
    isConnected: () => connected
  }

  addProviderListener('evm', 'accountsChanged', value => {
    selectedAddress = Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null
  })
  addProviderListener('evm', 'chainChanged', value => {
    if (typeof value === 'string' && value !== chainId) {
      chainId = value
      chainRevision += 1
    }
  })
  addProviderListener('evm', 'connect', value => {
    connected = true
    if (
      value &&
      typeof value === 'object' &&
      'chainId' in value &&
      typeof value.chainId === 'string'
    ) {
      chainId = value.chainId
    }
  })
  addProviderListener('evm', 'disconnect', () => {
    connected = false
    selectedAddress = null
  })

  queueMicrotask(() => {
    void provider.request({ method: 'eth_chainId' }).catch(() => {})
    void provider.request({ method: 'eth_accounts' }).catch(() => {})
  })

  return Object.freeze(provider)
}

function createBitcoinProvider(): BitcoinProvider {
  const request = (method: string, params: readonly unknown[] = []) =>
    requestProvider('bitcoin', { method, params })
  const provider: BitcoinProvider = {
    request: args => requestProvider('bitcoin', args),
    connect: () =>
      request('connect') as Promise<{ readonly address: string; readonly publicKey: string }>,
    requestAccounts: () => request('requestAccounts') as Promise<readonly string[]>,
    getAccounts: () => request('getAccounts') as Promise<readonly string[]>,
    getNetwork: () => request('getNetwork') as Promise<'livenet' | 'testnet'>,
    getChain: () => request('getChain') as Promise<Readonly<Record<string, unknown>>>,
    getPublicKey: () => request('getPublicKey') as Promise<string>,
    getBalance: () =>
      request('getBalance') as Promise<{
        readonly confirmed: number
        readonly unconfirmed: number
        readonly total: number
      }>,
    sendBitcoin: (recipient, satoshis, options) =>
      request('sendBitcoin', [
        recipient,
        satoshis,
        ...(options === undefined ? [] : [options])
      ]) as Promise<string>,
    signMessage: (message, type) =>
      request('signMessage', [message, ...(type === undefined ? [] : [type])]) as Promise<string>,
    signPsbt: (psbtHex, options) =>
      request('signPsbt', [
        psbtHex,
        ...(options === undefined ? [] : [options])
      ]) as Promise<string>,
    signPsbts: (psbtHexes, options) =>
      request('signPsbts', [psbtHexes, ...(options === undefined ? [] : [options])]) as Promise<
        readonly string[]
      >,
    pushPsbt: psbtHex => request('pushPsbt', [psbtHex]) as Promise<string>,
    pushTx: options => request('pushTx', [options]) as Promise<string>,
    switchNetwork: network => request('switchNetwork', [network]) as Promise<null>,
    switchChain: chain => request('switchChain', [chain]) as Promise<null>,
    on(event, handler) {
      addProviderListener('bitcoin', event, handler)
      return provider
    },
    removeListener(event, handler) {
      removeProviderListener('bitcoin', event, handler)
      return provider
    },
    async disconnect() {
      await request('disconnect')
    }
  }
  return Object.freeze(provider)
}

function createSolanaPublicKey(address: string): SolanaPublicKey {
  const bytes = decodeBase58(address, 32)
  return Object.freeze({
    toBytes: () => new Uint8Array(bytes),
    toBuffer: () => new Uint8Array(bytes),
    toString: () => address,
    equals: (value: { readonly toString: () => string }) => value?.toString() === address
  })
}

function readNativeConnectResult(value: unknown, provider: 'Solana'): { readonly address: string }
function readNativeConnectResult(
  value: unknown,
  provider: 'NEAR'
): { readonly address: string; readonly publicKey: string }
function readNativeConnectResult(
  value: unknown,
  provider: 'Solana' | 'NEAR'
): { readonly address: string; readonly publicKey?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Noir Wallet returned an invalid ${provider} connection.`)
  }
  const keys = Object.keys(value).sort()
  const expectedKeys = provider === 'Solana' ? ['address'] : ['address', 'publicKey']
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error(`Noir Wallet returned an invalid ${provider} connection.`)
  }
  const address = Reflect.get(value, 'address')
  if (typeof address !== 'string' || address.length === 0 || address.length > 128) {
    throw new Error(`Noir Wallet returned an invalid ${provider} account.`)
  }
  const publicKey = Reflect.get(value, 'publicKey')
  if (provider === 'Solana') {
    decodeBase58(address, 32)
    return Object.freeze({ address })
  }
  if (
    typeof publicKey !== 'string' ||
    !publicKey.startsWith('ed25519:') ||
    publicKey.length > 128
  ) {
    throw new Error('Noir Wallet returned an invalid NEAR access key.')
  }
  decodeBase58(publicKey.slice('ed25519:'.length), 32)
  return Object.freeze({ address, publicKey })
}

function readNativeAccounts(value: unknown, provider: 'Solana' | 'NEAR'): readonly string[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error(`Noir Wallet returned invalid ${provider} accounts.`)
  }
  const accounts = value.map(item => {
    if (typeof item !== 'string' || item.length === 0 || item.length > 128) {
      throw new Error(`Noir Wallet returned an invalid ${provider} account.`)
    }
    if (provider === 'Solana') decodeBase58(item, 32)
    return item
  })
  if (new Set(accounts).size !== accounts.length) {
    throw new Error(`Noir Wallet returned duplicate ${provider} accounts.`)
  }
  return Object.freeze(accounts)
}

function readNearSignedMessage(value: unknown): {
  readonly accountId: string
  readonly publicKey: string
  readonly signature: string
  readonly state?: string
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Noir Wallet returned an invalid NEAR message signature.')
  }
  const accountId = Reflect.get(value, 'accountId')
  const publicKey = Reflect.get(value, 'publicKey')
  const signature = Reflect.get(value, 'signature')
  const state = Reflect.get(value, 'state')
  if (
    typeof accountId !== 'string' ||
    accountId.length === 0 ||
    accountId.length > 128 ||
    typeof publicKey !== 'string' ||
    !publicKey.startsWith('ed25519:') ||
    publicKey.length > 128 ||
    typeof signature !== 'string' ||
    signature.length === 0 ||
    signature.length > 256 ||
    (state !== undefined && (typeof state !== 'string' || state.length > 2048))
  ) {
    throw new Error('Noir Wallet returned an invalid NEAR message signature.')
  }
  return Object.freeze({
    accountId,
    publicKey,
    signature,
    ...(state === undefined ? {} : { state })
  })
}

function createSolanaProvider(): SolanaProvider {
  const request = (method: string, params: readonly unknown[] = []) =>
    requestProvider('solana', { method, params })
  let publicKey: SolanaPublicKey | null = null
  const updateAccount = (value: unknown) => {
    const address = Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null
    const previousAddress = publicKey?.toString() ?? null
    publicKey = address ? createSolanaPublicKey(address) : null
    if (address !== previousAddress) emitProviderEvent('solana', 'accountChanged', publicKey)
  }
  const provider: SolanaProvider = {
    isNoirWallet: true,
    get isConnected() {
      return publicKey !== null
    },
    get publicKey() {
      return publicKey
    },
    async connect() {
      const connection = readNativeConnectResult(await request('connect'), 'Solana')
      updateAccount([connection.address])
      if (!publicKey) throw new Error('No Solana account was authorized.')
      emitProviderEvent('solana', 'connect', publicKey)
      return Object.freeze({ publicKey })
    },
    async getAccounts() {
      return readNativeAccounts(await request('getAccounts'), 'Solana')
    },
    async disconnect() {
      await request('disconnect')
      updateAccount([])
      emitProviderEvent('solana', 'disconnect', undefined)
    },
    async signTransaction(transaction, options) {
      if (!(transaction instanceof Uint8Array))
        throw new TypeError('Transaction bytes are required.')
      const normalized = normalizeSolanaTransactionOptions(options, false)
      return decodeBase64(
        (await request('signTransaction', [
          encodeBase64(transaction),
          ...(normalized === undefined ? [] : [normalized])
        ])) as string
      )
    },
    async signAllTransactions(transactions) {
      if (
        !Array.isArray(transactions) ||
        !transactions.every(value => value instanceof Uint8Array)
      ) {
        throw new TypeError('Transaction byte arrays are required.')
      }
      const result = (await request('signAllTransactions', [
        transactions.map(encodeBase64)
      ])) as readonly string[]
      return Object.freeze(result.map(decodeBase64))
    },
    async signAndSendTransaction(transaction, options) {
      if (!(transaction instanceof Uint8Array))
        throw new TypeError('Transaction bytes are required.')
      const normalized = normalizeSolanaTransactionOptions(options, true)
      const signature = (await request('signAndSendTransaction', [
        encodeBase64(transaction),
        ...(normalized === undefined ? [] : [normalized])
      ])) as string
      return Object.freeze({ signature })
    },
    async signMessage(message) {
      if (!(message instanceof Uint8Array)) throw new TypeError('Message bytes are required.')
      const result = (await request('signMessage', [encodeBase64(message)])) as {
        readonly signature: string
        readonly publicKey: string
      }
      return Object.freeze({
        signature: decodeBase58(result.signature, 64),
        publicKey: decodeBase58(result.publicKey, 32)
      })
    },
    on(event, handler) {
      addProviderListener('solana', event, handler)
      return provider
    },
    removeListener(event, handler) {
      removeProviderListener('solana', event, handler)
      return provider
    }
  }
  addProviderListener('solana', 'accountsChanged', updateAccount)
  queueMicrotask(() =>
    provider
      .getAccounts()
      .then(updateAccount)
      .catch(() => {})
  )
  return Object.freeze(provider)
}

function createNearProvider(): NearProvider {
  const request = (method: string, params: readonly unknown[] = []) =>
    requestProvider('near', { method, params })
  let accountId: string | null = null
  const updateAccount = (value: unknown) => {
    const next = Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null
    const changed = next !== accountId
    accountId = next
    if (changed) emitProviderEvent('near', 'accountChanged', next ?? '')
  }
  const provider: NearProvider = {
    async requestSignIn() {
      const connection = readNativeConnectResult(await request('connect'), 'NEAR')
      updateAccount([connection.address])
      if (!accountId) throw new Error('No NEAR account was authorized.')
      emitProviderEvent('near', 'signIn', undefined)
      return Object.freeze({
        accountId,
        accessKey: Object.freeze({ publicKey: connection.publicKey })
      })
    },
    async getAccounts() {
      return readNativeAccounts(await request('getAccounts'), 'NEAR')
    },
    async signOut() {
      await request('disconnect')
      updateAccount([])
      emitProviderEvent('near', 'signOut', undefined)
    },
    isSignedIn: () => accountId !== null,
    getAccountId: () => accountId,
    signTransaction: params => request('signTransaction', [params]) as Promise<string>,
    requestSignTransactions: params =>
      request('requestSignTransactions', [params]) as Promise<{
        readonly txs: readonly { readonly signedTx: string }[]
      }>,
    signAndSendTransaction: params =>
      request('signAndSendTransaction', [params]) as Promise<Readonly<Record<string, unknown>>>,
    signAndSendTransactions: params =>
      request('signAndSendTransactions', [params]) as Promise<
        readonly Readonly<Record<string, unknown>>[]
      >,
    async signMessage(params) {
      if (!params || typeof params !== 'object') {
        throw new TypeError('NEAR message parameters are required.')
      }
      const nonce = Reflect.get(params, 'nonce')
      const normalized = {
        message: Reflect.get(params, 'message'),
        recipient: Reflect.get(params, 'recipient'),
        nonce: nonce instanceof Uint8Array ? [...nonce] : nonce,
        callbackUrl: Reflect.get(params, 'callbackUrl') ?? null,
        state: Reflect.get(params, 'state') ?? null
      }
      return readNearSignedMessage(await request('signMessage', [normalized]))
    },
    on(event, handler) {
      addProviderListener('near', event, handler)
      return provider
    },
    removeListener(event, handler) {
      removeProviderListener('near', event, handler)
      return provider
    }
  }
  addProviderListener('near', 'accountsChanged', updateAccount)
  queueMicrotask(() =>
    provider
      .getAccounts()
      .then(updateAccount)
      .catch(() => {})
  )
  return Object.freeze(provider)
}

const earlyEthereumProvider = evmProviderEnabled
  ? (window as Window & { __noirEarlyEvmProvider?: EarlyEthereumProviderRegistration })
      .__noirEarlyEvmProvider
  : undefined
const underlyingEthereumProvider = evmProviderEnabled ? createEthereumProvider() : null
if (underlyingEthereumProvider) earlyEthereumProvider?.attach(underlyingEthereumProvider)
const ethereumProvider = underlyingEthereumProvider
  ? (earlyEthereumProvider?.provider ?? underlyingEthereumProvider)
  : null
const bitcoinProvider = bitcoinProviderEnabled ? createBitcoinProvider() : null
const solanaProvider = solanaProviderEnabled ? createSolanaProvider() : null
const nearProvider = nearProviderEnabled ? createNearProvider() : null
const multichainProvider = createMultichainProvider()
const noirWalletProvider: NoirWalletProvider = Object.freeze({
  isNoirWallet: true,
  version: appVersion,
  request: (args: ProviderRequestArguments) => multichainProvider.request(args),
  multichain: multichainProvider,
  zcash: createZcashProvider(),
  ...(ethereumProvider ? { ethereum: ethereumProvider } : {}),
  ...(bitcoinProvider ? { bitcoin: bitcoinProvider } : {}),
  ...(solanaProvider ? { solana: solanaProvider } : {}),
  ...(nearProvider ? { near: nearProvider } : {})
})

window.addEventListener('message', event => {
  if (event.source !== window) return
  if (event.data?.target !== 'noir-provider') return
  if (event.data?.type !== 'NOIR_EVENT') return
  if (
    event.data.chainId !== 'zcash' &&
    event.data.chainId !== 'evm' &&
    event.data.chainId !== 'bitcoin' &&
    event.data.chainId !== 'solana' &&
    event.data.chainId !== 'near' &&
    event.data.chainId !== 'multichain'
  ) {
    return
  }
  if (typeof event.data.eventName !== 'string') return
  emitProviderEvent(event.data.chainId, event.data.eventName, event.data.data)
})

Object.defineProperty(window, 'noirwallet', {
  value: noirWalletProvider,
  writable: false,
  configurable: false,
  enumerable: true
})

if (solanaProvider) {
  registerSolanaWalletStandard({
    chain: networkMode === 'testnet' ? 'solana:devnet' : 'solana:mainnet',
    request: (method, params = []) => requestProvider('solana', { method, params }),
    onAccountCapabilitiesChanged: listener => {
      addProviderListener('solana', 'accountCapabilitiesChanged', value => {
        if (!Array.isArray(value)) return
        listener(
          value.flatMap(item =>
            item &&
            typeof item === 'object' &&
            typeof item.address === 'string' &&
            typeof item.signMessage === 'boolean'
              ? [{ address: item.address, signMessage: item.signMessage }]
              : []
          )
        )
      })
    },
    onAccountsChanged: listener => {
      addProviderListener('solana', 'accountsChanged', value => {
        listener(Array.isArray(value) ? value.filter(item => typeof item === 'string') : [])
      })
    }
  })
}

if (nearProvider) {
  registerNearConnectWallet({
    network: networkMode,
    version: appVersion,
    connect: async () => {
      const connection = await nearProvider.requestSignIn()
      return Object.freeze({
        accountId: connection.accountId,
        publicKey: connection.accessKey.publicKey
      })
    },
    disconnect: () => nearProvider.signOut(),
    getAccounts: () => nearProvider.getAccounts(),
    signAndSendTransaction: input => nearProvider.signAndSendTransaction(input),
    signAndSendTransactions: input => nearProvider.signAndSendTransactions(input),
    signMessage: input => nearProvider.signMessage(input)
  })
}

if (
  ethereumProvider &&
  !earlyEthereumProvider &&
  (!('ethereum' in window) || window.ethereum === undefined)
) {
  Object.defineProperty(window, 'ethereum', {
    value: ethereumProvider,
    writable: true,
    configurable: true,
    enumerable: true
  })
}

if (ethereumProvider && !earlyEthereumProvider) {
  const providerInfo = Object.freeze({
    uuid: crypto.randomUUID(),
    name: NOIR_WALLET_PROVIDER_NAME,
    icon: NOIR_WALLET_PROVIDER_ICON,
    rdns: import.meta.env.NOIR_WALLET_RDNS
  })
  const providerDetail = Object.freeze({ info: providerInfo, provider: ethereumProvider })
  // MAIN-world script ordering can vary between extensions. Let a later bootstrap
  // reuse this provider and UUID rather than announcing a second Noir instance.
  Object.defineProperty(window, '__noirFallbackEvmProvider', {
    value: providerDetail,
    configurable: false
  })
  const announceProvider = () => {
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: providerDetail }))
  }
  window.addEventListener('eip6963:requestProvider', announceProvider)
  announceProvider()
}

window.dispatchEvent(new Event('noirwallet#initialized'))
