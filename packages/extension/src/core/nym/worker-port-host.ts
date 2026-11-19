import type {
  NymFetchRequest,
  NymFetchResponse,
  NymWorkerReply,
  NymWorkerRequest
} from './private-broadcast-protocol'

export interface NymWorkerPortHandlers {
  /** The user's current routing choice; a rejection blocks the Worker's broadcast. */
  isEnabled(): Promise<boolean>
  /** `signal` fires when the Worker withdraws the request; it must then not be sent. */
  fetch(request: NymFetchRequest, signal: AbortSignal): Promise<NymFetchResponse>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Private broadcast network failed'
}

/** Answers one Zcash Worker's routing questions and private requests on the tunnel side. */
export function serveNymWorkerPort(port: MessagePort, handlers: NymWorkerPortHandlers): void {
  const withdrawals = new Map<number, AbortController>()
  port.onmessage = (event: MessageEvent<NymWorkerRequest>) => {
    const message = event.data
    if (message.kind === 'cancel') {
      withdrawals.get(message.id)?.abort()
      return
    }
    const fail = (error: unknown) => {
      const reply: NymWorkerReply = { id: message.id, ok: false, error: errorMessage(error) }
      port.postMessage(reply)
    }
    if (message.kind === 'mode') {
      void handlers.isEnabled().then(enabled => {
        const reply: NymWorkerReply = { id: message.id, ok: true, kind: 'mode', enabled }
        port.postMessage(reply)
      }, fail)
      return
    }
    const withdrawal = new AbortController()
    withdrawals.set(message.id, withdrawal)
    void handlers
      .fetch(message.request, withdrawal.signal)
      .then(response => {
        const reply: NymWorkerReply = { id: message.id, ok: true, kind: 'fetch', response }
        port.postMessage(reply, [response.body.buffer])
      }, fail)
      .finally(() => withdrawals.delete(message.id))
  }
}
