/**
 * Content Script - Message bridge between page and background
 * Forwards messages from inject-provider to background service worker
 */

const RATE_LIMIT = { maxPerSecond: 10, burstCapacity: 20 }
let tokenBucket = RATE_LIMIT.burstCapacity
let lastRefill = Date.now()

function consumeToken(): boolean {
  const now = Date.now()
  const elapsed = (now - lastRefill) / 1000
  tokenBucket = Math.min(RATE_LIMIT.burstCapacity, tokenBucket + elapsed * RATE_LIMIT.maxPerSecond)
  lastRefill = now
  if (tokenBucket < 1) return false
  tokenBucket -= 1
  return true
}

const ALLOWED_METHODS = new Set([
  'zcash_getAccounts',
  'zcash_requestAccounts',
  'zcash_getBalance',
  'zcash_getMaxTransfer',
  'zcash_getPublicKey',
  'zcash_getAddresses',
  'zcash_sendTransaction',
  'zcash_signMessage',
  'zcash_shieldFunds',
  'zcash_switchNetwork',
  'zcash_checkLendingMcaAccount',
  'zcash_disconnect'
])

const BACKGROUND_RESPONSE_ERROR =
  'No response from Noir Wallet background. Reload the page and try again.'

interface DAppRuntimeResponse {
  requestId: string
  result?: unknown
  error?: string
}

function parseDAppRuntimeResponse(
  response: unknown,
  expectedRequestId: string
): DAppRuntimeResponse | null {
  if (!response || typeof response !== 'object') return null

  const record = response as Record<string, unknown>
  if (record.requestId !== expectedRequestId) return null

  if (typeof record.error === 'string' && record.error.length > 0) {
    return { requestId: expectedRequestId, error: record.error }
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

async function sendDAppRequestToBackground(
  message: Record<string, unknown>,
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
    if (event.data?.type !== 'NOIR_REQUEST') return

    const { requestId, chainId, payload } = event.data

    if (typeof requestId !== 'string' || requestId.length === 0) return

    if (chainId !== 'zcash') {
      window.postMessage({ target: 'noir-provider', requestId, error: 'Unsupported chain' }, '*')
      return
    }

    if (!payload || typeof payload.method !== 'string' || !ALLOWED_METHODS.has(payload.method)) {
      window.postMessage(
        { target: 'noir-provider', requestId, error: 'Invalid or unsupported method' },
        '*'
      )
      return
    }

    if (!consumeToken()) {
      window.postMessage({ target: 'noir-provider', requestId, error: 'Rate limit exceeded' }, '*')
      return
    }

    try {
      const response = await sendDAppRequestToBackground(
        {
          type: 'DAPP_REQUEST',
          requestId,
          chainId,
          origin: window.location.origin,
          request: payload
        },
        requestId,
        payload.method
      )

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
        '*'
      )
    } catch (error: unknown) {
      window.postMessage(
        {
          target: 'noir-provider',
          requestId,
          error: getErrorMessage(error)
        },
        '*'
      )
    }
  })
}

chrome.runtime.onMessage.addListener(message => {
  if (message.type === 'NOIR_EVENT') {
    const { chainId, eventName, data } = message

    window.postMessage(
      {
        target: 'noir-provider',
        type: 'NOIR_EVENT',
        chainId,
        eventName,
        data
      },
      '*'
    )
  }
})

setupMessageBridge()
console.log('[Content Script] Noir Wallet Content Script Loaded')
