import { parseSigningSummary } from '@/core/keyring/domain'
import { SCHEMA_EXPECTATIONS } from '@/core/keyring/domain/signing-summary-validation'
import { parseChainId } from '@/core/chains/registry'
import type { LedgerEvmSigningRequest, LedgerEvmSigningResponse } from '@/lib/ledger/evm'
import type {
  LedgerBitcoinSigningRequest,
  LedgerBitcoinSigningResponse
} from '@/lib/ledger/bitcoin'
import type { LedgerSolanaSigningRequest, LedgerSolanaSigningResponse } from '@/lib/ledger/solana'
import type { LedgerNearSigningRequest, LedgerNearSigningResponse } from '@/lib/ledger/near'
import type {
  LedgerDeviceSigningRequest,
  LedgerDeviceSigningResponse,
  LedgerPendingSigning
} from '@/core/keyring/protocol/ledger-signing'

export interface LedgerSigningBinding {
  readonly scope: LedgerPendingSigning['scope']
  readonly payloadFingerprint: LedgerPendingSigning['payloadFingerprint']
  readonly expiresAt: number
  readonly origin?: string
  readonly summary: LedgerPendingSigning['summary']
  readonly validate: () => Promise<void>
  readonly signal?: AbortSignal
}
interface WaitingRequest {
  record: LedgerPendingSigning
  submitting: boolean
  readonly binding: LedgerSigningBinding
  readonly resolve: (response: LedgerDeviceSigningResponse) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly abort: () => void
}
const waiting = new Map<string, WaitingRequest>()
const storageKey = (id: string) => `ledger_signing_${id}`
let validateScope: (scope: LedgerSigningBinding['scope']) => Promise<void> = async () => {
  throw new Error('Ledger signing runtime is not ready')
}

export function configureLedgerSigningCoordinator(guard: typeof validateScope): void {
  validateScope = guard
}

async function digest(value: unknown): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))
    )
  ]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}
async function validate(item: WaitingRequest): Promise<void> {
  if (Date.now() >= item.record.expiresAt)
    throw new Error('Ledger request expired. Review this action again.')
  item.binding.signal?.throwIfAborted()
  await validateScope(item.record.scope)
  await item.binding.validate()
  item.binding.signal?.throwIfAborted()
  if (Date.now() >= item.record.expiresAt)
    throw new Error('Ledger request expired. Review this action again.')
  if ((await digest(item.record.request)) !== item.record.requestDigest)
    throw new Error('Ledger signing payload changed')
}
function cleanup(id: string): WaitingRequest | undefined {
  const item = waiting.get(id)
  if (!item) return undefined
  waiting.delete(id)
  clearTimeout(item.timer)
  item.binding.signal?.removeEventListener('abort', item.abort)
  return item
}
export async function cancelLedgerSigning(
  id: string,
  reason = 'Ledger request was cancelled'
): Promise<void> {
  const item = cleanup(id)
  item?.reject(new Error(reason))
  await chrome.storage.session.remove(storageKey(id)).catch(() => {})
  if (item?.record.tabId !== undefined) {
    void chrome.runtime
      .sendMessage({ type: 'LEDGER_SIGNING_CANCELLED', requestId: id })
      .catch(() => {})
  }
}
export async function cancelAllLedgerSigning(reason: string): Promise<void> {
  await Promise.all([...waiting.keys()].map(id => cancelLedgerSigning(id, reason)))
  // Native EVM/Bitcoin tabs resume durable transfer records without an in-memory request.
  await chrome.runtime.sendMessage({ type: 'LEDGER_SIGNING_CANCELLED' }).catch(() => {})
}
export function requestLedgerSignature(
  request: LedgerEvmSigningRequest,
  binding: LedgerSigningBinding
): Promise<LedgerEvmSigningResponse>
export function requestLedgerSignature(
  request: LedgerBitcoinSigningRequest,
  binding: LedgerSigningBinding
): Promise<LedgerBitcoinSigningResponse>
export function requestLedgerSignature(
  request: LedgerSolanaSigningRequest,
  binding: LedgerSigningBinding
): Promise<LedgerSolanaSigningResponse>
export function requestLedgerSignature(
  request: LedgerNearSigningRequest,
  binding: LedgerSigningBinding
): Promise<LedgerNearSigningResponse>
export async function requestLedgerSignature(
  request: LedgerDeviceSigningRequest,
  binding: LedgerSigningBinding
): Promise<LedgerDeviceSigningResponse> {
  if (
    !Number.isSafeInteger(binding.expiresAt) ||
    binding.expiresAt <= Date.now() ||
    binding.expiresAt > Date.now() + 10 * 60_000
  )
    throw new Error('Invalid Ledger request expiry')
  await validateScope(binding.scope)
  await binding.validate()
  binding.signal?.throwIfAborted()
  const requestId = crypto.randomUUID()
  const record: LedgerPendingSigning = Object.freeze({
    requestId,
    request,
    scope: binding.scope,
    payloadFingerprint: binding.payloadFingerprint,
    expiresAt: binding.expiresAt,
    ...(binding.origin ? { origin: binding.origin } : {}),
    summary: parseSigningSummary(binding.summary, {
      ...SCHEMA_EXPECTATIONS[binding.summary.schema],
      chainId: parseChainId(binding.scope.chainId).id
    }),
    requestDigest: await digest(request)
  })
  binding.signal?.throwIfAborted()
  let resolve!: (response: LedgerDeviceSigningResponse) => void
  let reject!: (error: Error) => void
  const result = new Promise<LedgerDeviceSigningResponse>((done, fail) => {
    resolve = done
    reject = fail
  })
  // Attach a handler before asynchronous tab creation can fail or cancellation can fire.
  void result.catch(() => {})
  const abort = () => {
    void cancelLedgerSigning(requestId)
  }
  const timer = setTimeout(() => {
    void cancelLedgerSigning(requestId, 'Ledger request expired. Review this action again.')
  }, binding.expiresAt - Date.now())
  const item: WaitingRequest = { record, submitting: false, binding, resolve, reject, timer, abort }
  waiting.set(requestId, item)
  binding.signal?.addEventListener('abort', abort, { once: true })
  if (binding.signal?.aborted) abort()
  try {
    await chrome.storage.session.set({ [storageKey(requestId)]: record })
    if (!waiting.has(requestId)) {
      await chrome.storage.session.remove(storageKey(requestId)).catch(() => {})
      return result
    }
    const tab = await chrome.tabs.create({
      url: chrome.runtime.getURL(
        `index.html#/hardware/ledger-sign?requestId=${encodeURIComponent(requestId)}`
      )
    })
    if (tab.id === undefined) throw new Error('Unable to open Ledger signing tab')
    if (!waiting.has(requestId)) {
      await chrome.tabs.remove(tab.id)
      return result
    }
    item.record = Object.freeze({ ...record, tabId: tab.id })
    await chrome.storage.session.set({ [storageKey(requestId)]: item.record })
  } catch (error) {
    await cancelLedgerSigning(
      requestId,
      error instanceof Error ? error.message : 'Unable to open Ledger signing tab'
    )
  }
  return result
}
export async function getLedgerSigningRequest(
  requestId: unknown,
  tabId: number | undefined
): Promise<LedgerPendingSigning> {
  if (typeof requestId !== 'string') throw new Error('Invalid Ledger request')
  const item = waiting.get(requestId)
  if (!item) {
    await chrome.storage.session.remove(storageKey(requestId))
    throw new Error('Ledger signing was interrupted. Review this action again.')
  }
  if (tabId === undefined || item.record.tabId === undefined || item.record.tabId !== tabId)
    throw new Error('Ledger signing tab does not match request')
  if (item.submitting) throw new Error('Ledger signing is already being submitted')
  await validate(item)
  if (waiting.get(requestId) !== item)
    throw new Error('Ledger signing was interrupted. Review this action again.')
  if (item.submitting) throw new Error('Ledger signing is already being submitted')
  return item.record
}
export async function submitLedgerSigningResponse(
  requestId: unknown,
  response: unknown,
  tabId: number | undefined
): Promise<void> {
  const record = await getLedgerSigningRequest(requestId, tabId)
  const item = waiting.get(record.requestId)
  if (
    !item ||
    !response ||
    typeof response !== 'object' ||
    Array.isArray(response) ||
    JSON.stringify(response).length > 1_048_576
  )
    throw new Error('Invalid Ledger response')
  await validate(item)
  if (waiting.get(record.requestId) !== item)
    throw new Error('Ledger signing was interrupted. Review this action again.')
  if (item.submitting) throw new Error('Ledger signing is already being submitted')
  item.submitting = true
  try {
    await chrome.storage.session.remove(storageKey(record.requestId))
  } catch {
    cleanup(record.requestId)?.reject(new Error('Ledger signing state could not be cleared'))
    throw new Error('Ledger signing state could not be cleared')
  }
  try {
    await validate(item)
  } catch (error) {
    const failure = error instanceof Error ? error : new Error('Ledger signing was interrupted')
    cleanup(record.requestId)?.reject(failure)
    throw failure
  }
  const active = cleanup(record.requestId)
  if (!active) throw new Error('Ledger signing was interrupted. Review this action again.')
  // Chain clients verify the returned signature against the exact approved payload.
  active.resolve(response as LedgerDeviceSigningResponse)
}
export function registerLedgerSigningTabLifecycle(): void {
  chrome.tabs.onRemoved.addListener(tabId => {
    for (const [id, item] of waiting)
      if (item.record.tabId === tabId) void cancelLedgerSigning(id, 'Ledger signing tab was closed')
  })
}
