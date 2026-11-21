import {
  NYM_TUNNEL_PORT_MESSAGE,
  type NymFetchRequest,
  type NymFetchResponse,
  type NymTunnelCommand,
  type NymTunnelReply
} from '@/core/nym/private-broadcast-protocol'
import { readBoundedResponseBytes } from '@/lib/fetch-utils'

type MixFetchModule = typeof import('@nymproject/mix-fetch')
const MAX_NYM_RESPONSE_BYTES = 32 * 1024 * 1024

let mixFetchModule: Promise<MixFetchModule> | null = null

// The WASM tunnel is several megabytes; load it only once the host asks for a tunnel.
function loadMixFetch(): Promise<MixFetchModule> {
  mixFetchModule ??= import('@nymproject/mix-fetch').catch(error => {
    mixFetchModule = null
    throw error
  })
  return mixFetchModule
}

async function forward(request: NymFetchRequest): Promise<NymFetchResponse> {
  const { mixFetch } = await loadMixFetch()
  // mixFetch structured-clones init into its Worker: plain headers, no AbortSignal.
  const response = await mixFetch(request.url, {
    method: request.method,
    headers: Object.fromEntries(request.headers),
    ...(request.body ? { body: request.body } : {})
  })
  return {
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers],
    body: await readBoundedResponseBytes(response, MAX_NYM_RESPONSE_BYTES)
  }
}

async function handle(port: MessagePort, command: NymTunnelCommand): Promise<void> {
  try {
    if (command.kind === 'setup') {
      const { setupMixTunnel } = await loadMixFetch()
      await setupMixTunnel({ clientId: command.clientId })
      const reply: NymTunnelReply = { id: command.id, ok: true }
      port.postMessage(reply)
      return
    }
    const response = await forward(command.request)
    const reply: NymTunnelReply = { id: command.id, ok: true, response }
    port.postMessage(reply, [response.body.buffer])
  } catch (error) {
    const reply: NymTunnelReply = {
      id: command.id,
      ok: false,
      error: error instanceof Error ? error.message : 'Nym tunnel request failed'
    }
    port.postMessage(reply)
  }
}

window.addEventListener('message', event => {
  if (
    event.source !== window.parent ||
    event.origin !== location.origin ||
    event.data?.type !== NYM_TUNNEL_PORT_MESSAGE
  ) {
    return
  }
  const port = event.ports[0]
  if (!port) return
  port.onmessage = (message: MessageEvent<NymTunnelCommand>) => void handle(port, message.data)
})
