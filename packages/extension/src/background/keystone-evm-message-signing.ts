import {
  hashMessage,
  keccak256,
  parseTransaction,
  recoverAddress,
  serializeTransaction,
  type Hex
} from 'viem'
import { parseChainId } from '@/core/chains/registry/caip2'
import type {
  LedgerEvmSigningRequest,
  LedgerEvmSigningResponse
} from '@/core/keyring/protocol/ledger-signing'
import {
  createKeystoneEthereumPersonalSignRequest,
  createKeystoneEthereumLegacySignRequest,
  createKeystoneEthereumSignRequest,
  parseKeystoneEthereumSignatureCborBase64
} from '@/lib/keystone/ethereum-ur'
import type { LedgerSigningBinding } from './ledger-signing-coordinator'

type KeystoneEvmRequest<Kind extends 'personal-sign' | 'transaction'> = Omit<
  Extract<LedgerEvmSigningRequest, { kind: Kind }>,
  'expectedAddress'
> & {
  readonly address: string
  readonly masterFingerprintHex: string
}

type SigningRequest = KeystoneEvmRequest<'personal-sign'> | KeystoneEvmRequest<'transaction'>

export interface KeystoneEvmSigningView {
  readonly kind: SigningRequest['kind']
  readonly chainId: string
  readonly expiresAt: number
  readonly payloadFingerprint: string
  readonly request: { readonly encoding: 'base64'; readonly value: string }
}

interface PendingSignature {
  readonly view: KeystoneEvmSigningView
  readonly address: string
  readonly hash: Hex
  readonly legacyRecoveryBase?: bigint
  readonly binding: LedgerSigningBinding
  readonly resolve: (response: LedgerEvmSigningResponse) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly abort: () => void
  tabId?: number
  submitting: boolean
}

const pending = new Map<string, PendingSignature>()
const expiredMessage = 'Keystone signing request expired. Review this action again.'
const interruptedMessage = 'Keystone signing was interrupted. Review this action again.'

function takeSignature(requestId: string): PendingSignature | undefined {
  const item = pending.get(requestId)
  if (!item) return undefined
  pending.delete(requestId)
  clearTimeout(item.timer)
  item.binding.signal?.removeEventListener('abort', item.abort)
  return item
}

function cancelSignature(requestId: string, reason: string, notifyTab = false): void {
  const item = takeSignature(requestId)
  item?.reject(new Error(reason))
  if (notifyTab && item?.tabId !== undefined) {
    void chrome.runtime
      .sendMessage({ type: 'KEYSTONE_EVM_SIGNING_CANCELLED', requestId })
      .catch(() => {})
  }
}

export function cancelAllKeystoneEvmSigning(reason: string): void {
  for (const requestId of pending.keys()) cancelSignature(requestId, reason, true)
}

export function registerKeystoneEvmSigningTabLifecycle(): void {
  chrome.tabs.onRemoved.addListener(tabId => {
    for (const [requestId, item] of pending) {
      if (item.tabId === tabId) cancelSignature(requestId, 'Keystone signing tab was closed')
    }
  })
}

function assertLive(item: PendingSignature, requestId: string): void {
  if (pending.get(requestId) !== item) throw new Error(interruptedMessage)
  item.binding.signal?.throwIfAborted()
  if (Date.now() >= item.view.expiresAt) throw new Error(expiredMessage)
}

function getBoundSignature(requestId: string, tabId: number): PendingSignature {
  const item = pending.get(requestId)
  if (!item) throw new Error(interruptedMessage)
  if (item.tabId === undefined || item.tabId !== tabId) {
    throw new Error('Keystone signing tab does not match request')
  }
  return item
}

async function openSigningTab(requestId: string, item: PendingSignature): Promise<void> {
  const tab = await chrome.tabs.create({ url: 'about:blank' })
  if (tab.id === undefined) throw new Error('Unable to open Keystone signing tab')
  item.tabId = tab.id
  try {
    assertLive(item, requestId)
    await chrome.tabs.update(tab.id, {
      url: chrome.runtime.getURL(`index.html#/hardware/evm-sign?requestId=${requestId}`)
    })
  } catch (error) {
    void chrome.tabs.remove(tab.id).catch(() => {})
    throw error
  }
}

function encodeRequest(request: SigningRequest, chainId: number, requestId: string) {
  const input = { ...request, requestId, chainId }
  if (input.kind === 'personal-sign') {
    const { cborBase64 } = createKeystoneEthereumPersonalSignRequest(input)
    return { cborBase64, hash: hashMessage({ raw: input.messageHex as Hex }) }
  }
  const legacy = !input.unsignedTransactionHex.startsWith('0x02')
  const { cborBase64 } = legacy
    ? createKeystoneEthereumLegacySignRequest(input)
    : createKeystoneEthereumSignRequest(input)
  const serialized = input.unsignedTransactionHex as Hex
  const transaction = parseTransaction(serialized)
  if (
    transaction.chainId !== chainId ||
    transaction.type !== (legacy ? 'legacy' : 'eip1559') ||
    transaction.r !== undefined ||
    transaction.s !== undefined ||
    transaction.yParity !== undefined ||
    serializeTransaction(transaction) !== serialized
  ) {
    throw new Error('Keystone signing requires the approved unsigned EVM transaction')
  }
  return {
    cborBase64,
    hash: keccak256(serialized),
    ...(legacy ? { legacyRecoveryBase: BigInt(chainId) * 2n + 35n } : {})
  }
}

async function requestSignature(
  request: SigningRequest,
  binding: LedgerSigningBinding
): Promise<LedgerEvmSigningResponse> {
  const { expiresAt } = binding
  const now = Date.now()
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 10 * 60_000) {
    throw new Error('Invalid Keystone signing request expiry')
  }
  const chain = parseChainId(binding.scope.chainId)
  if (chain.namespace !== 'eip155' || !/^[1-9][0-9]*$/.test(chain.reference)) {
    throw new Error('Keystone signing requires an EVM account')
  }
  const requestId = crypto.randomUUID()
  const { cborBase64, hash, legacyRecoveryBase } = encodeRequest(
    request,
    Number(chain.reference),
    requestId
  )
  const address = request.address.toLowerCase()
  const view = Object.freeze({
    kind: request.kind,
    chainId: chain.id,
    expiresAt,
    payloadFingerprint: binding.payloadFingerprint.digestHex,
    request: Object.freeze({ encoding: 'base64' as const, value: cborBase64 })
  })
  binding.signal?.throwIfAborted()
  await binding.validate()
  binding.signal?.throwIfAborted()
  if (Date.now() >= expiresAt) throw new Error(expiredMessage)

  return new Promise((resolve, reject) => {
    const abort = () => cancelSignature(requestId, 'Keystone signing was cancelled', true)
    const timer = setTimeout(
      () => cancelSignature(requestId, expiredMessage),
      expiresAt - Date.now()
    )
    const item: PendingSignature = {
      view,
      address,
      hash,
      legacyRecoveryBase,
      binding,
      resolve,
      reject,
      timer,
      abort,
      submitting: false
    }
    pending.set(requestId, item)
    binding.signal?.addEventListener('abort', abort, { once: true })
    void openSigningTab(requestId, item).catch(() =>
      cancelSignature(requestId, 'Unable to open Keystone signing tab')
    )
  })
}

export function requestKeystoneEvmPersonalSignature(
  request: KeystoneEvmRequest<'personal-sign'>,
  binding: LedgerSigningBinding
): Promise<LedgerEvmSigningResponse> {
  return requestSignature(request, binding)
}

export function requestKeystoneEvmTransactionSignature(
  request: KeystoneEvmRequest<'transaction'>,
  binding: LedgerSigningBinding
): Promise<LedgerEvmSigningResponse> {
  return requestSignature(request, binding)
}

export async function getKeystoneEvmSigningRequest(
  requestId: string,
  tabId: number
): Promise<KeystoneEvmSigningView> {
  const item = getBoundSignature(requestId, tabId)
  assertLive(item, requestId)
  if (item.submitting) throw new Error('Keystone signature is already being verified')
  await item.binding.validate()
  assertLive(item, requestId)
  if (item.submitting) throw new Error('Keystone signature is already being verified')
  return item.view
}

export async function cancelKeystoneEvmSigning(requestId: string, tabId: number): Promise<void> {
  getBoundSignature(requestId, tabId)
  cancelSignature(requestId, 'Keystone signing was cancelled')
}

export async function submitKeystoneEvmSigningResponse(
  requestId: string,
  tabId: number,
  signatureCborBase64: string
): Promise<void> {
  const item = getBoundSignature(requestId, tabId)
  if (item.submitting) throw new Error('Keystone signature is already being verified')
  item.submitting = true
  try {
    assertLive(item, requestId)
    const { requestId: signedRequestId, signatureHex } = parseKeystoneEthereumSignatureCborBase64(
      signatureCborBase64,
      item.legacyRecoveryBase === undefined ? item.view.kind : 'legacy-transaction'
    )
    if (signedRequestId !== requestId)
      throw new Error('Keystone signature request ID does not match')
    const signatureBody = signatureHex.slice(0, 130)
    const recovery = BigInt(`0x${signatureHex.slice(130)}`)
    const parity =
      item.legacyRecoveryBase !== undefined
        ? recovery - item.legacyRecoveryBase
        : recovery >= 27n
          ? recovery - 27n
          : recovery
    if (parity !== 0n && parity !== 1n)
      throw new Error('Keystone signature recovery ID does not match')
    const personalSignature = `${signatureBody}${parity === 0n ? '1b' : '1c'}` as Hex
    const signer = await recoverAddress({ hash: item.hash, signature: personalSignature })
    if (signer.toLowerCase() !== item.address) {
      throw new Error('Keystone signature does not match the approved payload and account')
    }
    await item.binding.validate()
    assertLive(item, requestId)
    const normalized =
      item.view.kind === 'personal-sign' ? personalSignature : `${signatureBody}0${parity}`
    takeSignature(requestId)?.resolve(Object.freeze({ signatureHex: normalized }))
  } catch (error) {
    const failure = new Error(
      error instanceof Error && error.message.startsWith('Keystone')
        ? error.message
        : 'Unable to verify the Keystone signature'
    )
    takeSignature(requestId)?.reject(failure)
    throw failure
  }
}
