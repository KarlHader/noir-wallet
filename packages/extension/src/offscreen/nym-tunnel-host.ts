import { NYM_PRIVATE_BROADCAST } from '@/config/nym-private-broadcast'
import {
  NYM_TUNNEL_PORT_MESSAGE,
  planNymTunnelClient,
  type NymFetchRequest,
  type NymFetchResponse,
  type NymTunnelCommand,
  type NymTunnelReply
} from '@/core/nym/private-broadcast-protocol'
import { createNymPrewarmTrigger } from '@/core/nym/prewarm'
import type { NymTextRequest, NymTextResponse } from '@/core/nym/private-fetch-relay'
import { NymTunnelSupervisor, type NymTunnelLink } from '@/core/nym/tunnel-supervisor'
import { readNymPrewarmOriginsFromBackground } from '@/infrastructure/chains/nym-private-broadcast-preferences'
import { withTimeout } from '@/lib/async-utils'

const TUNNEL_PAGE_PATH = 'src/offscreen/nym-tunnel.html'
const RESET_MESSAGE = 'Private broadcast network was reset'

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never

function debug(message: string): void {
  if (__DEBUG_LOGS__) console.info(`[NymTunnel] ${message}`)
}

/**
 * Debug builds ask a public IP echo through each new tunnel: the address it reports is the
 * exit that destinations see, so per-exit refusals (such as HTTP 403) can be told apart.
 */
const EXIT_ADDRESS_REQUEST: NymFetchRequest = {
  url: 'https://api.ipify.org/',
  method: 'GET',
  headers: [['accept', 'text/plain']],
  body: null
}
const EXIT_ADDRESS_TIMEOUT_MS = 30_000

function readExitAddress(response: NymFetchResponse | undefined): string {
  if (!response) return 'unknown (no answer)'
  if (response.status !== 200) return `unknown (HTTP ${response.status})`
  const text = new TextDecoder().decode(response.body).trim()
  return /^[0-9a-fA-F:.]{3,45}$/.test(text) ? text : 'unknown (unexpected answer)'
}

/** The client the next tunnel uses; null until the first tunnel of this document. */
let tunnelClientId: string | null = null

/** Picks the next tunnel's client and deletes the stored state of replaced clients. */
async function prepareTunnelClient(): Promise<string> {
  let names: (string | undefined)[] = []
  try {
    names = (await indexedDB.databases()).map(database => database.name)
  } catch {
    debug('could not list tunnel clients')
  }
  const plan = planNymTunnelClient(tunnelClientId, names, () => crypto.randomUUID())
  tunnelClientId = plan.clientId
  for (const name of plan.staleDatabases) {
    // Completes once the discarded tunnel's Worker has released the database.
    indexedDB.deleteDatabase(name).onerror = () =>
      debug('could not delete a replaced tunnel client')
  }
  return plan.clientId
}

/**
 * A client always reconnects to its stored entry gateway, so a gateway that stopped working
 * would fail every later setup. After a failed setup the next tunnel registers a new client.
 */
function replaceTunnelClient(failedClientId: string): void {
  if (tunnelClientId !== failedClientId) return
  tunnelClientId = crypto.randomUUID()
  debug('tunnel setup failed: the next tunnel registers a new client and entry gateway')
}

function createFrameLink(
  element: HTMLIFrameElement,
  port: MessagePort,
  clientId: string
): NymTunnelLink {
  const pending = new Map<number, (reply: NymTunnelReply) => void>()
  let nextId = 1
  let closed = false
  port.onmessage = (event: MessageEvent<NymTunnelReply>) => {
    pending.get(event.data.id)?.(event.data)
  }

  async function command(
    body: DistributiveOmit<NymTunnelCommand, 'id'>,
    timeoutMs: number
  ): Promise<NymFetchResponse | undefined> {
    if (closed) throw new Error(RESET_MESSAGE)
    const id = nextId++
    const reply = await withTimeout(
      new Promise<NymTunnelReply>(resolve => {
        pending.set(id, resolve)
        port.postMessage({ ...body, id } as NymTunnelCommand)
      }),
      timeoutMs,
      `Nym tunnel ${body.kind}`
    ).finally(() => pending.delete(id))
    if (!reply.ok) throw new Error(reply.error)
    return reply.response
  }

  return {
    async setup(timeoutMs) {
      try {
        await command({ kind: 'setup', clientId }, timeoutMs)
      } catch (error) {
        // A reset (Nym routing turned off) says nothing about the gateway.
        if (!closed) replaceTunnelClient(clientId)
        throw error
      }
      if (__DEBUG_LOGS__) {
        // Runs beside the build; requests logged after this line leave from the same exit
        // until the next "tunnel ready".
        void command(
          { kind: 'fetch', request: EXIT_ADDRESS_REQUEST },
          EXIT_ADDRESS_TIMEOUT_MS
        ).then(
          response => debug(`tunnel exit IP: ${readExitAddress(response)}`),
          error =>
            debug(
              `tunnel exit IP: unknown (${error instanceof Error ? error.message : 'lookup failed'})`
            )
        )
      }
    },
    async fetch(request, timeoutMs) {
      const response = await command({ kind: 'fetch', request }, timeoutMs)
      if (!response) throw new Error('Nym tunnel returned no response')
      return response
    },
    isAlive: () => !closed && element.isConnected,
    close() {
      if (closed) return
      closed = true
      for (const resolve of pending.values()) {
        resolve({ id: -1, ok: false, error: RESET_MESSAGE })
      }
      pending.clear()
      port.close()
      // Removing the document terminates its tunnel Worker and the gateway connection.
      element.remove()
    }
  }
}

/**
 * Loads the tunnel page in an iframe, so a tunnel that connected to an unusable exit can be
 * discarded and rebuilt without touching the Zcash Worker.
 */
async function openTunnelFrame(): Promise<NymTunnelLink> {
  const clientId = await prepareTunnelClient()
  const element = document.createElement('iframe')
  element.hidden = true
  element.src = chrome.runtime.getURL(TUNNEL_PAGE_PATH)
  return withTimeout(
    new Promise<NymTunnelLink>((resolve, reject) => {
      element.addEventListener('error', () => reject(new Error('Tunnel page failed to load')))
      element.addEventListener('load', () => {
        const channel = new MessageChannel()
        element.contentWindow?.postMessage({ type: NYM_TUNNEL_PORT_MESSAGE }, location.origin, [
          channel.port2
        ])
        resolve(createFrameLink(element, channel.port1, clientId))
      })
      document.body.append(element)
    }),
    NYM_PRIVATE_BROADCAST.tunnelSetupTimeoutMs,
    'Nym tunnel page'
  ).catch(error => {
    element.remove()
    throw error
  })
}

/** The Nym tunnel owned by the offscreen document. */
export const nymTunnelHost = new NymTunnelSupervisor({
  openLink: openTunnelFrame,
  now: () => performance.now(),
  setupTimeoutMs: NYM_PRIVATE_BROADCAST.tunnelSetupTimeoutMs,
  healthCheckTimeoutMs: NYM_PRIVATE_BROADCAST.healthCheckTimeoutMs,
  recheckTimeoutMs: NYM_PRIVATE_BROADCAST.recheckTimeoutMs,
  healthFreshMs: NYM_PRIVATE_BROADCAST.healthFreshMs,
  fetchTimeoutMs: NYM_PRIVATE_BROADCAST.fetchTimeoutMs,
  maxBuildAttempts: NYM_PRIVATE_BROADCAST.maxTunnelBuildAttempts,
  log: debug
})

/** Readies the tunnel while a send is being prepared; a no-op while Nym routing is off. */
export const prewarmNymTunnelForSend = createNymPrewarmTrigger({
  now: () => performance.now(),
  minIntervalMs: NYM_PRIVATE_BROADCAST.prewarmIntervalMs,
  loadOrigins: readNymPrewarmOriginsFromBackground,
  prewarm: origins => nymTunnelHost.prewarm(origins)
})

export async function nymTunnelFetchText(request: NymTextRequest): Promise<NymTextResponse> {
  const response = await nymTunnelHost.fetch({
    url: request.url,
    method: request.method,
    headers: request.headers,
    body: request.bodyText === null ? null : new TextEncoder().encode(request.bodyText)
  })
  return {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    bodyText: new TextDecoder().decode(response.body)
  }
}
