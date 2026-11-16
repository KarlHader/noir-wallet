import { classifyError } from '@/lib/errors'

export function canRetryPendingApprovalLoad(error: string): boolean {
  if (/not found|expired|invalid|unsupported|unauthorized|changed|no longer|locked/i.test(error))
    return false
  return classifyError(error).retryable
}

const SUPPORTED_APPROVAL_ACTIONS = [
  'connect',
  'multichainConnect',
  'sendTransaction',
  'signMessage',
  'shieldFunds',
  'evmConnect',
  'evmNetwork',
  'evmTransaction',
  'evmPrivateTransfer',
  'evmGasFunding',
  'evmMessage',
  'bitcoinConnect',
  'bitcoinTransaction',
  'bitcoinMessage',
  'solanaConnect',
  'solanaTransaction',
  'solanaMessage',
  'nearConnect',
  'nearTransaction',
  'nearMessage'
] as const

export type DAppApprovalAction = (typeof SUPPORTED_APPROVAL_ACTIONS)[number]

export interface DAppApprovalRequest {
  readonly id: string
  readonly origin: string
  readonly action: DAppApprovalAction
  readonly data: Record<string, unknown>
  readonly walletId?: string
  readonly accountId?: string
}

export type PendingApprovalResponse =
  | { readonly status: 'ready'; readonly request: DAppApprovalRequest }
  | { readonly status: 'error'; readonly error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSupportedApprovalAction(value: unknown): value is DAppApprovalAction {
  return (
    typeof value === 'string' && (SUPPORTED_APPROVAL_ACTIONS as readonly string[]).includes(value)
  )
}

function isWebOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false
  try {
    const parsed = new URL(value)
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.origin === value
  } catch {
    return false
  }
}

export function parsePendingApprovalResponse(
  value: unknown,
  expectedRequestId: string
): PendingApprovalResponse {
  if (!isRecord(value)) {
    return { status: 'error', error: 'Unable to load this approval request.' }
  }

  if (typeof value.error === 'string') {
    return {
      status: 'error',
      error: value.error.trim() || 'Unable to load this approval request.'
    }
  }

  const request = value.request
  if (
    !isRecord(request) ||
    request.id !== expectedRequestId ||
    !isWebOrigin(request.origin) ||
    !isSupportedApprovalAction(request.action) ||
    !isRecord(request.data)
  ) {
    return { status: 'error', error: 'Invalid or unsupported approval request.' }
  }

  return {
    status: 'ready',
    request: {
      id: request.id,
      origin: request.origin,
      action: request.action,
      data: request.data,
      ...(typeof request.walletId === 'string' ? { walletId: request.walletId } : {}),
      ...(typeof request.accountId === 'string' ? { accountId: request.accountId } : {})
    }
  }
}
