import {
  NYM_INCOMPLETE_ERROR,
  NYM_PRIVATE_BROADCAST_PORT_MESSAGE,
  NYM_UNAVAILABLE_ERROR,
  requiresNymRoute,
  type NymFetchResponse,
  type NymRouteSwitches,
  type NymWorkerReply,
  type NymWorkerRequest
} from './private-broadcast-protocol'

export interface PrivateBroadcastFetchScope {
  fetch: typeof globalThis.fetch
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
}

export interface PrivateBroadcastStats {
  /** Answered through the Nym tunnel. */
  routed: number
  /** Rejected without reaching the destination directly. */
  blocked: number
  /** Sent directly because the user has Nym routing turned off. */
  direct: number
}

export interface PrivateBroadcastFetchController {
  /**
   * The user's current routing choice, for callers that size a timeout or label a trace
   * before a routed request. Null when it cannot be learned; such a request is blocked.
   */
  readRoutingChoice(): Promise<boolean | null>
  /**
   * Runs one wallet sync step. While a step runs and no send does, the transaction,
   * transparent history and UTXO reads go direct (unless `routeWalletSync` is set).
   */
  duringWalletSync<T>(operation: () => Promise<T>): Promise<T>
  /** Marks a send as queued or running until the returned call; meanwhile nothing goes direct. */
  beginSend(): () => void
  readonly stats: Readonly<PrivateBroadcastStats>
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never
type NymWorkerSuccess = Extract<NymWorkerReply, { ok: true }>
type NymWorkerQuestion = Exclude<NymWorkerRequest, { kind: 'cancel' }>

interface PendingReply {
  resolve(reply: NymWorkerSuccess): void
  reject(error: unknown): void
}

function requestUrl(input: RequestInfo | URL, base: string): URL | null {
  try {
    if (input instanceof Request) return new URL(input.url)
    return new URL(input instanceof URL ? input.href : String(input), base)
  } catch {
    return null
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

/**
 * Replaces the Worker's global fetch so broadcast requests (and the requests `routes` switches
 * on, except wallet sync's own reads) follow the user's Nym routing choice, asked from the
 * offscreen document before every such request. With routing on, the request uses the Nym
 * tunnel and never the original fetch. When the choice cannot be learned or the tunnel fails,
 * the request rejects with one of two fixed messages (never sent, or outcome unknown); tunnel
 * details stay in the offscreen document.
 */
export function installNymPrivateBroadcastFetch(
  scope: PrivateBroadcastFetchScope,
  options: {
    requestTimeoutMs: number
    modeTimeoutMs: number
    base: string
    routes: NymRouteSwitches
    /** Route wallet sync's own requests too, instead of sending them direct. */
    routeWalletSync: boolean
  }
): PrivateBroadcastFetchController {
  const directFetch = scope.fetch.bind(scope)
  const pending = new Map<number, PendingReply>()
  const stats: PrivateBroadcastStats = { routed: 0, blocked: 0, direct: 0 }
  let port: MessagePort | null = null
  let nextId = 1
  let walletSyncSteps = 0
  let sends = 0

  // The WASM's requests carry no caller, so a sync overlapping a send (of another wallet, or
  // after the scheduler's wait for sync to stop ran out) keeps every request routed.
  const walletSyncDirect = () => !options.routeWalletSync && walletSyncSteps > 0 && sends === 0

  scope.addEventListener('message', event => {
    if (event.data?.type !== NYM_PRIVATE_BROADCAST_PORT_MESSAGE) return
    // Keep the transport handoff away from the Worker RPC dispatcher.
    event.stopImmediatePropagation()
    const nextPort = event.ports[0]
    if (!nextPort) return
    for (const reply of pending.values()) {
      reply.reject(new TypeError('Private broadcast network was replaced'))
    }
    pending.clear()
    port?.close()
    port = nextPort
    port.onmessage = (message: MessageEvent<NymWorkerReply>) => {
      const reply = pending.get(message.data.id)
      if (!reply) return
      if (message.data.ok) reply.resolve(message.data)
      else reply.reject(new TypeError(message.data.error))
    }
  })

  function exchange(
    activePort: MessagePort,
    command: DistributiveOmit<NymWorkerQuestion, 'id'>,
    signal: AbortSignal,
    timeoutMs: number,
    transfer: Transferable[] = []
  ): Promise<NymWorkerSuccess> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(abortReason(signal))
        return
      }
      const id = nextId++
      const settle = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        pending.delete(id)
      }
      // Once the Worker stops waiting, the host must not send the request later on its own.
      const withdraw = () => {
        if (command.kind !== 'fetch') return
        const cancel: NymWorkerRequest = { id, kind: 'cancel' }
        activePort.postMessage(cancel)
      }
      const onAbort = () => {
        settle()
        withdraw()
        reject(abortReason(signal))
      }
      const timer = setTimeout(() => {
        settle()
        withdraw()
        reject(new TypeError('Private broadcast timed out'))
      }, timeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })
      pending.set(id, {
        resolve: value => {
          settle()
          resolve(value)
        },
        reject: error => {
          settle()
          reject(error)
        }
      })
      activePort.postMessage({ ...command, id } as NymWorkerQuestion, transfer)
    })
  }

  async function tunnelFetch(activePort: MessagePort, request: Request): Promise<NymFetchResponse> {
    const signal = request.signal
    const body =
      request.method === 'GET' || request.method === 'HEAD'
        ? null
        : new Uint8Array(await request.arrayBuffer())
    // The signal may have fired while the body was read.
    if (signal.aborted) throw abortReason(signal)
    const reply = await exchange(
      activePort,
      {
        kind: 'fetch',
        request: { url: request.url, method: request.method, headers: [...request.headers], body }
      },
      signal,
      options.requestTimeoutMs,
      body ? [body.buffer] : []
    )
    if (reply.kind !== 'fetch') throw new TypeError(NYM_INCOMPLETE_ERROR)
    return reply.response
  }

  async function guardedFetch(request: Request): Promise<Response> {
    let enabled: boolean
    let activePort: MessagePort
    try {
      if (!port) throw new TypeError(NYM_UNAVAILABLE_ERROR)
      activePort = port
      const mode = await exchange(
        activePort,
        { kind: 'mode' },
        request.signal,
        options.modeTimeoutMs
      )
      // Only a definite "off" may release the request to the direct path.
      if (mode.kind !== 'mode' || typeof mode.enabled !== 'boolean') {
        throw new TypeError(NYM_UNAVAILABLE_ERROR)
      }
      enabled = mode.enabled
    } catch {
      stats.blocked += 1
      if (request.signal.aborted) throw abortReason(request.signal)
      throw new TypeError(NYM_UNAVAILABLE_ERROR)
    }
    if (!enabled) {
      stats.direct += 1
      return directFetch(request)
    }
    try {
      const response = await tunnelFetch(activePort, request)
      stats.routed += 1
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      })
    } catch (error) {
      stats.blocked += 1
      if (request.signal.aborted) throw abortReason(request.signal)
      // The tunnel host names the one failure that precedes sending; any other is uncertain.
      const neverSent = error instanceof Error && error.message.startsWith(NYM_UNAVAILABLE_ERROR)
      throw new TypeError(neverSent ? NYM_UNAVAILABLE_ERROR : NYM_INCOMPLETE_ERROR)
    }
  }

  scope.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input, options.base)
    if (!url || !requiresNymRoute(url, options.routes, walletSyncDirect())) {
      return directFetch(input, init)
    }
    let request: Request
    try {
      request = new Request(input, init)
    } catch (error) {
      stats.blocked += 1
      return Promise.reject(error)
    }
    return guardedFetch(request)
  }

  return {
    async readRoutingChoice() {
      if (!port) return null
      try {
        const mode = await exchange(
          port,
          { kind: 'mode' },
          new AbortController().signal,
          options.modeTimeoutMs
        )
        return mode.kind === 'mode' && typeof mode.enabled === 'boolean' ? mode.enabled : null
      } catch {
        return null
      }
    },
    async duringWalletSync(operation) {
      walletSyncSteps += 1
      try {
        return await operation()
      } finally {
        walletSyncSteps -= 1
      }
    },
    beginSend() {
      sends += 1
      let ended = false
      return () => {
        if (ended) return
        ended = true
        sends -= 1
      }
    },
    stats
  }
}
