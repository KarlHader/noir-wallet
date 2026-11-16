import {
  DAPP_EXECUTION_MODES,
  type DAppExecutionMode,
  type DAppExecutionModeChangeImpact,
  type DAppExecutionModeState
} from '@/core/dapp/dapp-execution-mode'

export type DAppExecutionModeRuntimeMessenger = (
  message: Readonly<Record<string, unknown>>
) => Promise<unknown>

export class DAppExecutionModeClientError extends Error {
  constructor(
    readonly code:
      | 'invalid-response'
      | 'request-failed'
      | 'affected-operations-confirmation-required',
    message: string,
    readonly impact?: DAppExecutionModeChangeImpact
  ) {
    super(message)
    this.name = 'DAppExecutionModeClientError'
  }
}

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DAppExecutionModeClientError(
      'invalid-response',
      'Invalid dApp execution mode response'
    )
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new DAppExecutionModeClientError(
      'invalid-response',
      'Invalid dApp execution mode response'
    )
  }
  return value as Record<string, unknown>
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
  )
}

function parseResponse(value: unknown): DAppExecutionModeState {
  const response = readRecord(value)
  if (hasExactKeys(response, ['error']) && typeof response.error === 'string') {
    throw new DAppExecutionModeClientError('request-failed', response.error)
  }
  if (
    hasExactKeys(response, ['error', 'code', 'impact']) &&
    typeof response.error === 'string' &&
    response.code === 'affected-operations-confirmation-required'
  ) {
    const impact = readRecord(response.impact)
    if (
      hasExactKeys(impact, ['pendingApprovalCount']) &&
      Number.isSafeInteger(impact.pendingApprovalCount) &&
      Number(impact.pendingApprovalCount) > 0
    ) {
      throw new DAppExecutionModeClientError(response.code, response.error, {
        pendingApprovalCount: Number(impact.pendingApprovalCount)
      })
    }
  }
  if (!hasExactKeys(response, ['success', 'state']) || response.success !== true) {
    throw new DAppExecutionModeClientError(
      'invalid-response',
      'Invalid dApp execution mode response'
    )
  }
  const state = readRecord(response.state)
  if (
    !hasExactKeys(state, ['mode', 'privateAvailable', 'privateSetupCompleted']) ||
    !DAPP_EXECUTION_MODES.includes(state.mode as DAppExecutionMode) ||
    typeof state.privateAvailable !== 'boolean' ||
    typeof state.privateSetupCompleted !== 'boolean'
  ) {
    throw new DAppExecutionModeClientError('invalid-response', 'Invalid dApp execution mode state')
  }
  return Object.freeze({
    mode: state.mode as DAppExecutionMode,
    privateAvailable: state.privateAvailable,
    privateSetupCompleted: state.privateSetupCompleted
  })
}

export function createDAppExecutionModeClient(sendMessage: DAppExecutionModeRuntimeMessenger) {
  return Object.freeze({
    read: async (): Promise<DAppExecutionModeState> =>
      parseResponse(await sendMessage({ type: 'GET_DAPP_EXECUTION_MODE' })),
    set: async (
      mode: DAppExecutionMode,
      options: Readonly<{
        confirmPrivateSetup?: boolean
        confirmAffectedOperations?: boolean
      }> = {}
    ): Promise<DAppExecutionModeState> => {
      if (!DAPP_EXECUTION_MODES.includes(mode)) {
        throw new DAppExecutionModeClientError('request-failed', 'Invalid dApp execution mode')
      }
      return parseResponse(
        await sendMessage({
          type: 'SET_DAPP_EXECUTION_MODE',
          mode,
          ...(options.confirmPrivateSetup === true ? { confirmPrivateSetup: true } : {}),
          ...(options.confirmAffectedOperations === true ? { confirmAffectedOperations: true } : {})
        })
      )
    }
  })
}

export const dappExecutionModeClient = createDAppExecutionModeClient(message =>
  chrome.runtime.sendMessage(message)
)
