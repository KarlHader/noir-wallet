import type { SwapStatusType } from '@/core/services/intents-api'
import { WALLET_CONFIG } from '@/config/wallet'
import {
  NOIR_MOVE_REFERRAL,
  NOIR_RECEIVE_REFERRAL,
  NOIR_SEND_REFERRAL,
  NOIR_SWAP_REFERRAL
} from '@/config/intents'
import type { TransactionType } from '@/types'

export const INTENTS_PROGRESS_STALE_MS = 60 * 60 * 1000

export function getIntentsExplorerUrl(depositAddress: string, type: TransactionType): string {
  const referral =
    type === 'swap'
      ? NOIR_SWAP_REFERRAL
      : type === 'send'
        ? NOIR_SEND_REFERRAL
        : type === 'receive'
          ? NOIR_RECEIVE_REFERRAL
          : type === 'shield' || type === 'unshield'
            ? NOIR_MOVE_REFERRAL
            : undefined
  const url = new URL(
    `https://explorer.near-intents.org/transactions/${encodeURIComponent(depositAddress)}`
  )
  if (referral) url.searchParams.set('referral', referral)
  return url.toString()
}

export function getZcashDestinationCatchUpThreshold(confirmations: number): number {
  if (!Number.isSafeInteger(confirmations) || confirmations <= 0) return 0
  if (confirmations >= WALLET_CONFIG.SPENDABILITY_CONFIRMATIONS) {
    return WALLET_CONFIG.SPENDABILITY_CONFIRMATIONS
  }
  if (confirmations >= WALLET_CONFIG.MIN_CONFIRMATIONS) return WALLET_CONFIG.MIN_CONFIRMATIONS
  return 1
}

export interface IntentsProgressEntry {
  depositAddress: string
  tokenInSymbol: string
  tokenOutSymbol: string
  amountIn: string
  amountOut: string
  actionName: string
  accountKey: string
  transactionId?: string
  originChain?: string
  destinationChain?: string
  status: SwapStatusType
  createdAt: number
  lastStatusChangeAt: number
}

export type IntentsProgressInput = Omit<
  IntentsProgressEntry,
  'actionName' | 'status' | 'createdAt' | 'lastStatusChangeAt'
> & { actionName?: string }

const STATUSES = new Set<SwapStatusType>([
  'KNOWN_DEPOSIT_TX',
  'PENDING_DEPOSIT',
  'INCOMPLETE_DEPOSIT',
  'PROCESSING',
  'SUCCESS',
  'REFUNDED',
  'FAILED'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function normalizeIntentsProgressEntry(
  value: unknown,
  now = Date.now()
): IntentsProgressEntry | null {
  if (!isRecord(value)) return null

  const depositAddress = optionalString(value.depositAddress)
  const tokenInSymbol = optionalString(value.tokenInSymbol)
  const tokenOutSymbol = optionalString(value.tokenOutSymbol)
  const amountIn = optionalString(value.amountIn)
  const amountOut = optionalString(value.amountOut)
  const accountKey = optionalString(value.accountKey)
  if (
    !depositAddress ||
    !tokenInSymbol ||
    !tokenOutSymbol ||
    !amountIn ||
    !amountOut ||
    !accountKey
  ) {
    return null
  }

  const status =
    typeof value.status === 'string' && STATUSES.has(value.status as SwapStatusType)
      ? (value.status as SwapStatusType)
      : 'PENDING_DEPOSIT'
  const createdAt =
    typeof value.createdAt === 'number' && value.createdAt > 0 ? value.createdAt : now
  const lastStatusChangeAt =
    typeof value.lastStatusChangeAt === 'number' && value.lastStatusChangeAt > 0
      ? value.lastStatusChangeAt
      : createdAt

  return {
    depositAddress,
    tokenInSymbol,
    tokenOutSymbol,
    amountIn,
    amountOut,
    actionName: optionalString(value.actionName) || 'Transaction',
    accountKey,
    transactionId: optionalString(value.transactionId),
    originChain: optionalString(value.originChain),
    destinationChain: optionalString(value.destinationChain),
    status,
    createdAt,
    lastStatusChangeAt
  }
}

export function registerIntentsProgress(
  input: IntentsProgressInput,
  existing?: IntentsProgressEntry,
  now = Date.now()
): IntentsProgressEntry {
  return {
    ...existing,
    ...input,
    actionName: input.actionName || existing?.actionName || 'Transaction',
    transactionId: input.transactionId || existing?.transactionId,
    status: existing?.status || 'PENDING_DEPOSIT',
    createdAt: existing?.createdAt || now,
    lastStatusChangeAt: existing?.lastStatusChangeAt || now
  }
}

export function updateIntentsProgressStatus(
  entry: IntentsProgressEntry,
  status: SwapStatusType,
  now = Date.now()
): IntentsProgressEntry {
  return status === entry.status ? entry : { ...entry, status, lastStatusChangeAt: now }
}

export function isIntentsProgressStale(entry: IntentsProgressEntry, now = Date.now()): boolean {
  return now - entry.lastStatusChangeAt >= INTENTS_PROGRESS_STALE_MS
}
