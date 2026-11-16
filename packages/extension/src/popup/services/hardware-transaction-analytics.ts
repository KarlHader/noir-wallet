import { sendAnalyticsEvent, ANALYTICS_EVENTS, PAGE_IDS } from '@/lib/analytics'
import {
  projectZcashOperationEvent,
  resolveZcashAnalyticsOperation,
  zcashOperationCollector
} from '@/lib/analytics/operations'
import type { HardwareSignRequest } from '@/lib/hardware-tab'

export function recordHardwareOperationOutcome(
  request: HardwareSignRequest,
  requestId: string | null,
  outcome: 'broadcast' | 'failed',
  transactionId?: string,
  broadcastAmount?: string
): void {
  if (request.dappRequestId) return
  const operation = resolveZcashAnalyticsOperation(request.kind, request.quoteBinding?.userAction)
  const event = projectZcashOperationEvent(
    operation,
    outcome,
    {
      pageId: PAGE_IDS.HARDWARE_SIGN,
      fundingSource: request.fundingSource,
      outputSymbol: request.monitorParams?.tokenOutSymbol,
      hardware: true
    },
    `zcash-hardware-${outcome}:${transactionId ?? requestId ?? request.createdAt}`,
    outcome === 'broadcast'
      ? zcashOperationCollector(operation, request.fundingSource, broadcastAmount, request.to)
      : undefined
  )
  sendAnalyticsEvent(event.name, event.options)
}

export function recordHardwareSignFailure(
  kind: HardwareSignRequest['kind'],
  phase: 'build' | 'sign' | 'broadcast'
): void {
  sendAnalyticsEvent(ANALYTICS_EVENTS.HW_SIGN_FAILED, {
    pageId: PAGE_IDS.HARDWARE_SIGN,
    chain: 'zcash',
    extra: { kind, phase }
  })
}
