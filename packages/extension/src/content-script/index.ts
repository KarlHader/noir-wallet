/**
 * Content Script - Message bridge between page and background
 * Forwards messages from inject-provider to background service worker
 */

import {
  DAPP_RUNTIME_METHODS,
  getOwnExtensionSenderContext,
  parseDAppRuntimeRequestMessage,
  parseNoirRuntimeEventMessage,
  type DAppRuntimeRequestMessage,
  type NoirRuntimeEventMessage
} from '@/lib/runtime-message-security'

const RATE_LIMIT = { maxPerSecond: 10, burstCapacity: 20 }
let tokenBucket = RATE_LIMIT.burstCapacity
let lastRefill = Date.now()
const EVM_CONNECTION_READ_LIMIT = { maxPerSecond: 30, burstCapacity: 60 }
const EVM_CONNECTION_READ_METHODS = new Set([
  'eth_accounts',
  'eth_chainId',
  'net_version',
  'wallet_getPermissions'
])
let evmConnectionReadTokens = EVM_CONNECTION_READ_LIMIT.burstCapacity
let lastEvmConnectionReadRefill = Date.now()

function consumeToken(chainId: string, method: string): boolean {
  const now = Date.now()
  if (chainId === 'evm' && EVM_CONNECTION_READ_METHODS.has(method)) {
    const elapsed = (now - lastEvmConnectionReadRefill) / 1000
    evmConnectionReadTokens = Math.min(
      EVM_CONNECTION_READ_LIMIT.burstCapacity,
      evmConnectionReadTokens + elapsed * EVM_CONNECTION_READ_LIMIT.maxPerSecond
    )
    lastEvmConnectionReadRefill = now
    if (evmConnectionReadTokens < 1) return false
    evmConnectionReadTokens -= 1
    return true
  }
  const elapsed = (now - lastRefill) / 1000
  tokenBucket = Math.min(RATE_LIMIT.burstCapacity, tokenBucket + elapsed * RATE_LIMIT.maxPerSecond)
  lastRefill = now
  if (tokenBucket < 1) return false
  tokenBucket -= 1
  return true
}

const ALLOWED_METHODS = new Set<string>(DAPP_RUNTIME_METHODS)
const EVM_PROVIDER_ENABLED = __ENABLED_CHAIN_FEATURE_FLAGS__.includes('chain.evm')
const BITCOIN_PROVIDER_ENABLED = __ENABLED_CHAIN_FEATURE_FLAGS__.includes('chain.bitcoin')
const SOLANA_PROVIDER_ENABLED = __ENABLED_CHAIN_FEATURE_FLAGS__.includes('chain.solana')
const NEAR_PROVIDER_ENABLED = __ENABLED_CHAIN_FEATURE_FLAGS__.includes('chain.near')

const BACKGROUND_RESPONSE_ERROR =
  'No response from Noir Wallet background. Reload the page and try again.'
const CONNECTION_METHODS = new Set([
  'zcash_requestAccounts',
  'eth_requestAccounts',
  'wallet_requestPermissions',
  'connect',
  'requestAccounts',
  'wallet_createSession'
])

interface DAppRuntimeResponse {
  requestId: string
  result?: unknown
  error?: string | { readonly code: number; readonly message: string }
}

function parseProviderError(
  value: unknown
): string | { readonly code: number; readonly message: string } | null {
  if (typeof value === 'string' && value.length > 0 && value.length <= 4_096) return value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).length !== 2 ||
    !Number.isSafeInteger(record.code) ||
    typeof record.message !== 'string' ||
    record.message.length === 0 ||
    record.message.length > 4_096
  ) {
    return null
  }
  return Object.freeze({ code: record.code as number, message: record.message })
}

function parseDAppRuntimeResponse(
  response: unknown,
  expectedRequestId: string
): DAppRuntimeResponse | null {
  if (!response || typeof response !== 'object') return null

  const record = response as Record<string, unknown>
  if (record.requestId !== expectedRequestId) return null

  const error = parseProviderError(record.error)
  if (error) {
    return { requestId: expectedRequestId, error }
  }

  if (Object.prototype.hasOwnProperty.call(record, 'result')) {
    return { requestId: expectedRequestId, result: record.result }
  }

  return null
}

function getErrorMessage(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message
  }
  return String(error)
}

function resolveDocumentFaviconUrl(): string | undefined {
  if (typeof document === 'undefined') return undefined
  const favicon = document.querySelector<HTMLLinkElement>('link[rel~="icon"][href]')?.href
  if (!favicon) return undefined
  if (favicon.startsWith('data:image/')) {
    return favicon.length <= 128 * 1024 ? favicon : undefined
  }
  try {
    const parsed = new URL(favicon)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined
    return parsed.href.length <= 4_096 ? parsed.href : undefined
  } catch {
    return undefined
  }
}

async function sendDAppRequestToBackground(
  message: DAppRuntimeRequestMessage,
  requestId: string,
  method: string
): Promise<DAppRuntimeResponse> {
  const response = parseDAppRuntimeResponse(await chrome.runtime.sendMessage(message), requestId)
  if (response) return response

  console.warn('[Content Script] Empty or invalid dApp response:', { method, requestId })
  throw new Error(BACKGROUND_RESPONSE_ERROR)
}

function setupMessageBridge() {
  window.addEventListener('message', async event => {
    if (event.source !== window) return
    if (event.data?.target !== 'noir-content-script') return
    if (
      EVM_PROVIDER_ENABLED &&
      (event.data.type === 'NOIR_EVM_WALLET_CONFIG' || event.data.type === 'NOIR_EVM_WALLET_CHOICE')
    ) {
      const { requestId, type, wallets } = event.data
      if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 128) return
      if (!consumeToken('evm', 'wallet_choice')) return
      try {
        const response: unknown = await chrome.runtime.sendMessage(
          type === 'NOIR_EVM_WALLET_CONFIG'
            ? { type: 'GET_EVM_WALLET_PREFERENCE' }
            : { type: 'REQUEST_EVM_WALLET_CHOICE', wallets }
        )
        window.postMessage(
          { target: 'noir-evm-wallet-router', requestId, response },
          window.location.origin
        )
      } catch {
        window.postMessage(
          {
            target: 'noir-evm-wallet-router',
            requestId,
            response: {
              error: 'Wallet selection is unavailable. Reload the website and try again.'
            }
          },
          window.location.origin
        )
      }
      return
    }
    if (event.data?.type !== 'NOIR_REQUEST') return

    const { requestId, chainId, payload } = event.data

    if (chainId === 'evm' && !EVM_PROVIDER_ENABLED) {
      window.postMessage(
        {
          target: 'noir-provider',
          requestId,
          error: { code: 4200, message: 'The EVM provider is unavailable in this wallet build.' }
        },
        window.location.origin
      )
      return
    }

    if (chainId === 'bitcoin' && !BITCOIN_PROVIDER_ENABLED) {
      window.postMessage(
        {
          target: 'noir-provider',
          requestId,
          error: {
            code: 4200,
            message: 'The Bitcoin provider is unavailable in this wallet build.'
          }
        },
        window.location.origin
      )
      return
    }

    if (
      (chainId === 'solana' && !SOLANA_PROVIDER_ENABLED) ||
      (chainId === 'near' && !NEAR_PROVIDER_ENABLED)
    ) {
      const chainName = chainId === 'solana' ? 'Solana' : 'NEAR'
      window.postMessage(
        {
          target: 'noir-provider',
          requestId,
          error: {
            code: 4200,
            message: `The ${chainName} provider is unavailable in this wallet build.`
          }
        },
        window.location.origin
      )
      return
    }

    if (
      typeof requestId !== 'string' ||
      requestId.length === 0 ||
      requestId.length > 128 ||
      !payload ||
      typeof payload.method !== 'string' ||
      !ALLOWED_METHODS.has(payload.method)
    ) {
      window.postMessage(
        {
          target: 'noir-provider',
          requestId,
          error:
            (chainId === 'evm' ||
              chainId === 'bitcoin' ||
              chainId === 'solana' ||
              chainId === 'near') &&
            typeof payload?.method === 'string'
              ? {
                  code: 4200,
                  message: `The requested ${chainId === 'evm' ? 'EVM' : chainId === 'bitcoin' ? 'Bitcoin' : chainId === 'solana' ? 'Solana' : 'NEAR'} method is not supported.`
                }
              : 'Invalid or unsupported method'
        },
        window.location.origin
      )
      return
    }

    let requestMessage
    try {
      const faviconUrl = CONNECTION_METHODS.has(payload.method)
        ? resolveDocumentFaviconUrl()
        : undefined
      requestMessage = parseDAppRuntimeRequestMessage({
        type: 'DAPP_REQUEST',
        requestId,
        chainId,
        ...(faviconUrl === undefined ? {} : { siteMetadata: { faviconUrl } }),
        request: payload
      })
    } catch {
      window.postMessage(
        { target: 'noir-provider', requestId, error: 'Invalid request params' },
        window.location.origin
      )
      return
    }

    if (!consumeToken(chainId, payload.method)) {
      window.postMessage(
        { target: 'noir-provider', requestId, error: 'Rate limit exceeded' },
        window.location.origin
      )
      return
    }

    try {
      const response = await sendDAppRequestToBackground(requestMessage, requestId, payload.method)

      window.postMessage(
        response.error
          ? {
              target: 'noir-provider',
              requestId,
              error: response.error
            }
          : {
              target: 'noir-provider',
              requestId,
              result: response.result
            },
        window.location.origin
      )
    } catch (error: unknown) {
      window.postMessage(
        {
          target: 'noir-provider',
          requestId,
          error: getErrorMessage(error)
        },
        window.location.origin
      )
    }
  })
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (getOwnExtensionSenderContext(sender, chrome.runtime.id) !== 'service-worker') return
  if (message?.type === 'NOIR_EVENT') {
    let runtimeEvent: NoirRuntimeEventMessage
    try {
      runtimeEvent = parseNoirRuntimeEventMessage(message)
    } catch {
      return
    }
    const { chainId, eventName, data } = runtimeEvent

    window.postMessage(
      {
        target: 'noir-provider',
        type: 'NOIR_EVENT',
        chainId,
        eventName,
        data
      },
      window.location.origin
    )
  }
})

setupMessageBridge()
window.addEventListener('noirwallet#requestBridgeReady', () => {
  window.dispatchEvent(new Event('noirwallet#bridgeReady'))
})
window.dispatchEvent(new Event('noirwallet#bridgeReady'))
