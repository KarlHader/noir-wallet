import {
  DASH_CHAIN_IDS,
  DASH_UNSUPPORTED_SIGN_MESSAGE,
  type DashChainId,
  type DashProvider,
  type DashProviderError,
  type DashUnsupportedSignMessageError,
  type DetectDashProviderOptions
} from './types'

type NoirWalletWindow = Window & {
  noirwallet?: {
    dash?: unknown
  }
}

const DASH_PROVIDER_ERROR_CODES = new Set<number>([
  4001,
  4100,
  DASH_UNSUPPORTED_SIGN_MESSAGE,
  4900,
  4901,
  -32602,
  -32603
])

const CANONICAL_DUFF_STRING = /^(?:0|[1-9][0-9]*)$/
const MAX_DASH_DUFFS = 21_000_000n * 100_000_000n

function isDashProvider(value: unknown): value is DashProvider {
  if (!value || typeof value !== 'object') return false
  const provider = value as Partial<DashProvider>
  return (
    typeof provider.request === 'function' &&
    typeof provider.connect === 'function' &&
    typeof provider.getAccounts === 'function' &&
    typeof provider.getNetwork === 'function' &&
    typeof provider.sendDash === 'function' &&
    typeof provider.signMessage === 'function' &&
    typeof provider.signPsbt === 'function' &&
    typeof provider.signPsbts === 'function' &&
    typeof provider.pushPsbt === 'function' &&
    typeof provider.pushTx === 'function' &&
    typeof provider.disconnect === 'function'
  )
}

function abortError(): Error {
  const error = new Error('Noir Wallet Dash provider discovery was aborted.')
  error.name = 'AbortError'
  return error
}

export function isDashChainId(chainId: string): chainId is DashChainId {
  return chainId === DASH_CHAIN_IDS.mainnet || chainId === DASH_CHAIN_IDS.testnet
}

export function isDashProviderError(error: unknown): error is DashProviderError {
  if (!(error instanceof Error)) return false
  const code = (error as { readonly code?: unknown }).code
  return typeof code === 'number' && DASH_PROVIDER_ERROR_CODES.has(code)
}

export function isUnsupportedDashSignMessageError(
  error: unknown
): error is DashUnsupportedSignMessageError {
  return isDashProviderError(error) && error.code === DASH_UNSUPPORTED_SIGN_MESSAGE
}

/** Accepts a canonical base-10 duff string. */
export function parseDashDuffs(value: unknown): bigint {
  if (typeof value !== 'string' || value.includes('.') || !CANONICAL_DUFF_STRING.test(value)) {
    invalidDashAmount()
  }
  const parsed = BigInt(value)
  if (parsed > MAX_DASH_DUFFS) invalidDashAmount()
  return parsed
}

function invalidDashAmount(): never {
  throw new TypeError('Dash amount must be a canonical base-10 string of integer duffs.')
}

export function getDashProvider(): DashProvider | null {
  if (typeof window === 'undefined') return null
  const candidate = (window as NoirWalletWindow).noirwallet?.dash
  return isDashProvider(candidate) ? candidate : null
}

export async function detectDashProvider(
  options: DetectDashProviderOptions = {}
): Promise<DashProvider> {
  if (typeof window === 'undefined') throw new Error('window is undefined')
  if (options.signal?.aborted) throw abortError()

  const direct = getDashProvider()
  if (direct) return direct

  const timeoutMs = options.timeoutMs ?? 3000
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError('timeoutMs must be a non-negative finite number.')
  }

  return new Promise<DashProvider>((resolve, reject) => {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    let settled = false

    const cleanup = () => {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
      window.removeEventListener('noirwallet#initialized', onInitialized)
      options.signal?.removeEventListener('abort', onAbort)
    }
    const succeed = (provider: DashProvider) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(provider)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onInitialized = () => {
      const provider = getDashProvider()
      if (provider) succeed(provider)
    }
    const onAbort = () => fail(abortError())

    window.addEventListener('noirwallet#initialized', onInitialized)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    timeoutHandle = setTimeout(
      () => fail(new Error('Noir Wallet Dash provider was not found.')),
      timeoutMs
    )
  })
}
