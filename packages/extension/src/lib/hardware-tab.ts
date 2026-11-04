/**
 * Hardware wallet flows run outside the transient toolbar popup:
 * QR camera access and USB/Bluetooth permission prompts can close or outlive
 * popups, and long signing flows must survive focus changes. Sign requests are
 * handed off via chrome.storage.session so the tab can rebuild state after an
 * unlock redirect.
 */

import type { FundingSource, QuoteBinding } from '@/types'
import { useWalletStore } from '@/store/wallet-store'
import { launchHardwareSignSurface } from './hardware-sign-launcher'
import { waitForHardwareSignResult, type HardwareSignResult } from './hardware-sign-result'

export type HardwareSignKind = 'send' | 'shield' | 'swap'

export interface SwapMonitorParams {
  kind: 'swap'
  direction: 'from_zcash'
  depositAddress: string
  tokenInSymbol: string
  tokenOutSymbol: string
  amountOut: string
  usdAmount?: string
  actionName: string
  originChain?: string
  destinationChain?: string
  originAsset?: string
  destinationAsset?: string
  quoteExpiresAt?: number
}

export interface HardwareSignRequest {
  kind: HardwareSignKind
  walletId: string
  accountId: string
  /** Recipient address (send: target, swap: deposit address) */
  to?: string
  /** Display amount in ZEC */
  amount: string
  /** Recalculate the exact send maximum after transaction preflight. */
  maxTransfer?: boolean
  /** Private memo attached to the shielded recipient output. */
  memo?: string
  /** Balance pool selected for sends. Older requests default to shielded. */
  fundingSource?: FundingSource
  /** Address shown in the transaction record instead of `to` (swap recipient) */
  displayTo?: string
  /** Single-receiver address reconstructed and shown by the Ledger app. */
  ledgerDisplayAddress?: string
  /** Cross-chain quote binding recorded with the transaction (swap) */
  quoteBinding?: QuoteBinding
  /** Cross-chain monitor params (swap) */
  monitorParams?: SwapMonitorParams
  /** When set, the sign tab reports the outcome via a HW_SIGN_RESULT message */
  dappRequestId?: string
  /** Report a correlated result to the extension surface that opened this request. */
  reportToOrigin?: boolean
  /** dApp origin, shown in the sign tab for context */
  origin?: string
  /** ZIP-317 marginal fee (zatoshis) for the selected fee tier; defaults to Standard. */
  marginalFeeZats?: number
  feeQuoteId?: string
  feeTier?: import('@/config/fee').FeeTier
  createdAt: number
}

const SIGN_REQUEST_PREFIX = 'hw_sign_'

interface HardwareSignSession {
  requestId: string
  tab: chrome.tabs.Tab
}

export function openHardwareConnectTab(): void {
  chrome.tabs
    .create({ url: chrome.runtime.getURL('index.html#/hardware/connect') })
    .catch(console.error)
}

async function openHardwareSignSession(
  request: Omit<HardwareSignRequest, 'createdAt'>
): Promise<HardwareSignSession> {
  const id = crypto.randomUUID()
  await chrome.storage.session.set({
    [SIGN_REQUEST_PREFIX + id]: { ...request, createdAt: Date.now() } satisfies HardwareSignRequest
  })
  const keySource = useWalletStore.getState().getWallet(request.walletId)?.keySource
  const signPath = keySource === 'ledger' ? 'ledger/sign' : 'keystone/sign'
  try {
    const tab = await launchHardwareSignSurface(
      chrome.runtime.getURL(`index.html#/hardware/${signPath}?req=${id}`)
    )
    return { requestId: id, tab }
  } catch (cause) {
    await clearHardwareSignRequest(id).catch(() => {})
    throw cause
  }
}

export async function openHardwareSignTab(
  request: Omit<HardwareSignRequest, 'createdAt'>
): Promise<chrome.tabs.Tab> {
  return (await openHardwareSignSession(request)).tab
}

export async function openHardwareSignAndWait(
  request: Omit<HardwareSignRequest, 'createdAt' | 'reportToOrigin'>
): Promise<HardwareSignResult> {
  const session = await openHardwareSignSession({ ...request, reportToOrigin: true })
  return waitForHardwareSignResult({ requestId: session.requestId, tabId: session.tab.id })
}

/**
 * Read a pending sign request. Kept in storage until explicitly cleared so
 * the flow survives unlock redirects within the tab.
 */
export async function readHardwareSignRequest(id: string): Promise<HardwareSignRequest | null> {
  const key = SIGN_REQUEST_PREFIX + id
  const data = await chrome.storage.session.get(key)
  return (data[key] as HardwareSignRequest) ?? null
}

export async function clearHardwareSignRequest(id: string): Promise<void> {
  await chrome.storage.session.remove(SIGN_REQUEST_PREFIX + id)
}
