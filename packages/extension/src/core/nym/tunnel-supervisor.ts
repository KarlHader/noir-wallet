import {
  isReachableResponse,
  isRefusedExitResponse,
  NYM_UNAVAILABLE_ERROR,
  nymDestinationHost,
  nymRequestLabel,
  reachabilityCheckRequest,
  type NymFetchRequest,
  type NymFetchResponse
} from './private-broadcast-protocol'

/** One Nym tunnel instance. mix-tunnel cannot restart in place, so a failed one is replaced. */
export interface NymTunnelLink {
  setup(timeoutMs: number): Promise<void>
  fetch(request: NymFetchRequest, timeoutMs: number): Promise<NymFetchResponse>
  /** False once the page hosting the tunnel is gone. */
  isAlive(): boolean
  /** Ends the tunnel and rejects its unanswered requests. */
  close(): void
}

export interface NymTunnelSupervisorOptions {
  openLink(): Promise<NymTunnelLink>
  now(): number
  setupTimeoutMs: number
  /** Bound on the first destination check of a tunnel, which includes DNS and TLS setup. */
  healthCheckTimeoutMs: number
  /** Bound on re-checking a destination this tunnel already reached. */
  recheckTimeoutMs: number
  /** How long a destination stays proven after its last answer. */
  healthFreshMs: number
  fetchTimeoutMs: number
  maxBuildAttempts: number
  log?(message: string): void
}

const RESET_MESSAGE = 'Private broadcast network was reset'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Private broadcast network failed'
}

/** HTTP status plus any gRPC status the destination put in the headers. */
function describeAnswer(response: NymFetchResponse): string {
  const header = (name: string) => response.headers.find(([key]) => key.toLowerCase() === name)?.[1]
  const grpcStatus = header('grpc-status')
  const grpcMessage = header('grpc-message')
  return [
    `HTTP ${response.status}`,
    grpcStatus === undefined ? null : `grpc-status ${grpcStatus}`,
    grpcMessage ? `grpc-message "${grpcMessage.slice(0, 200)}"` : null
  ]
    .filter(Boolean)
    .join(', ')
}

/**
 * Keeps one usable Nym tunnel. A tunnel carries a request only after it recently reached the
 * request's destination: unusable exits are replaced before the request is sent, and a tunnel
 * that went quiet is re-checked briefly instead of holding the request until it times out.
 */
export class NymTunnelSupervisor {
  private link: NymTunnelLink | null = null
  private readonly verifiedAt = new Map<string, number>()
  /** The one build in flight and the destination it is proving. */
  private building: { origin: string; done: Promise<void> } | null = null
  /** Requests waiting for an answer on the current tunnel. */
  private requestsInTunnel = 0
  /** Numbers requests in the log. */
  private requestCount = 0
  /** Advanced by close(), so work that started earlier stops instead of rebuilding. */
  private epoch = 0

  constructor(private readonly options: NymTunnelSupervisorOptions) {}

  /**
   * Sends `request` through a tunnel that recently reached its destination. `withdrawn` lets
   * the caller take the request back while the tunnel is still being prepared.
   */
  async fetch(request: NymFetchRequest, withdrawn?: AbortSignal): Promise<NymFetchResponse> {
    const label = `#${++this.requestCount} ${nymRequestLabel(request)}`
    const log = (message: string) => this.options.log?.(`${label}: ${message}`)
    const queuedAt = this.options.now()
    const since = (from: number) => Math.round(this.options.now() - from)
    let sentAt: number | null = null
    // The caller gives up on its own clock; this records whether the request had left by then.
    const onWithdrawn = () => {
      log(
        sentAt === null
          ? `caller stopped waiting after ${since(queuedAt)} ms, before the tunnel was ready: NOT SENT`
          : `caller stopped waiting after ${since(queuedAt)} ms, ${since(sentAt)} ms after it was SENT: outcome unknown to the caller`
      )
    }
    withdrawn?.addEventListener('abort', onWithdrawn, { once: true })
    log('waiting for the tunnel')
    try {
      let origin: string
      let link: NymTunnelLink
      try {
        origin = new URL(request.url).origin
        link = await this.ensureHealthy(origin)
        if (withdrawn?.aborted) throw new Error('request was withdrawn')
      } catch (error) {
        // Nothing was sent: callers rely on this prefix to say so.
        const message = errorMessage(error)
        log(`NOT SENT after ${since(queuedAt)} ms: ${message}`)
        throw new Error(
          message.startsWith(NYM_UNAVAILABLE_ERROR)
            ? message
            : `${NYM_UNAVAILABLE_ERROR}: ${message}`
        )
      }
      const startedAt = this.options.now()
      sentAt = startedAt
      log(`SENT after waiting ${since(queuedAt)} ms for the tunnel`)
      this.requestsInTunnel += 1
      try {
        const response = await link.fetch(request, this.options.fetchTimeoutMs)
        const refused = isRefusedExitResponse(response)
        if (this.link === link) {
          this.requestsInTunnel -= 1
          // The next request checks the destination again, which replaces a refused exit.
          if (refused) this.verifiedAt.delete(origin)
          else this.verifiedAt.set(origin, this.options.now())
        }
        log(
          `answered ${describeAnswer(response)} ${since(startedAt)} ms after sending` +
            (refused ? ' (the destination refused this exit)' : '') +
            (withdrawn?.aborted ? ' (too late: the caller had stopped waiting)' : '')
        )
        return response
      } catch (error) {
        // A failed request usually means the exit stopped forwarding; rebuild before the next
        // one. The request is not repeated: it may have reached the destination.
        log(`failed ${since(startedAt)} ms after sending: ${errorMessage(error)}`)
        if (this.link === link) {
          this.requestsInTunnel -= 1
          // Other requests are still waiting on this tunnel; their outcome decides its fate.
          if (this.requestsInTunnel > 0) this.verifiedAt.delete(origin)
          else this.discard()
        }
        throw error
      }
    } finally {
      withdrawn?.removeEventListener('abort', onWithdrawn)
    }
  }

  /**
   * Builds the tunnel and proves each destination ahead of a request. Failures are left for
   * the request itself to report.
   */
  async prewarm(origins: readonly string[]): Promise<void> {
    const epoch = this.epoch
    for (const value of origins) {
      if (this.epoch !== epoch) return
      try {
        await this.ensureHealthy(new URL(value).origin)
      } catch (error) {
        this.options.log?.(`prewarm failed: ${errorMessage(error)}`)
      }
    }
  }

  /** Drops the tunnel, for example when the user turns Nym routing off. */
  close(): void {
    this.epoch += 1
    // The build in flight stops on its own; later requests must not wait on it.
    this.building = null
    this.discard()
  }

  private isFresh(origin: string): boolean {
    const verifiedAt = this.verifiedAt.get(origin)
    return verifiedAt !== undefined && this.options.now() - verifiedAt <= this.options.healthFreshMs
  }

  /**
   * The tunnel is carrying a request or just answered for another destination, so a failed
   * check points at this destination and must not take the tunnel down with it.
   */
  private isUsedElsewhere(origin: string): boolean {
    if (!this.link?.isAlive()) return false
    if (this.requestsInTunnel > 0) return true
    for (const other of this.verifiedAt.keys()) {
      if (other !== origin && this.isFresh(other)) return true
    }
    return false
  }

  private async ensureHealthy(origin: string): Promise<NymTunnelLink> {
    const epoch = this.epoch
    for (;;) {
      if (this.link && !this.link.isAlive()) this.discard()
      if (this.link && this.isFresh(origin)) return this.link
      if (this.epoch !== epoch) throw new Error(RESET_MESSAGE)
      const building = this.building
      if (building && building.origin !== origin) {
        // Builds run one at a time. Another destination's failure says nothing about this one.
        await building.done.catch(() => undefined)
        continue
      }
      await (building?.done ?? this.startBuild(origin))
    }
  }

  private startBuild(origin: string): Promise<void> {
    const done = this.buildFor(origin).finally(() => {
      if (this.building?.done === done) this.building = null
    })
    this.building = { origin, done }
    return done
  }

  /** Builds a tunnel (replacing unusable exits) and proves it reaches `origin`. */
  private async buildFor(origin: string): Promise<void> {
    const host = nymDestinationHost(origin)
    const epoch = this.epoch
    const assertNotClosed = () => {
      if (this.epoch !== epoch) throw new Error(RESET_MESSAGE)
    }
    let lastError: unknown
    // Checking the tunnel already in place is not a build: an idle tunnel that stopped
    // forwarding must not use up one of the attempts to build its replacement.
    const attempts = this.options.maxBuildAttempts + (this.link ? 1 : 0)
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const startedAt = this.options.now()
      const elapsed = () => Math.round(this.options.now() - startedAt)
      try {
        let link = this.link
        if (!link) {
          link = await this.options.openLink()
          if (this.epoch !== epoch) {
            link.close()
            throw new Error(RESET_MESSAGE)
          }
          this.link = link
          await link.setup(this.options.setupTimeoutMs)
          assertNotClosed()
          this.options.log?.(`attempt ${attempt}: tunnel ready in ${elapsed()} ms`)
        }
        const probe = await link.fetch(
          reachabilityCheckRequest(origin),
          this.verifiedAt.has(origin)
            ? this.options.recheckTimeoutMs
            : this.options.healthCheckTimeoutMs
        )
        if (!isReachableResponse(probe)) {
          throw new Error(
            isRefusedExitResponse(probe)
              ? 'Private broadcast destination refused this exit'
              : 'Private broadcast destination check failed'
          )
        }
        if (this.link !== link) throw new Error(RESET_MESSAGE)
        this.verifiedAt.set(origin, this.options.now())
        this.options.log?.(
          `attempt ${attempt}: ${host} reachable (${describeAnswer(probe)}) after ${elapsed()} ms`
        )
        return
      } catch (error) {
        assertNotClosed()
        lastError = error
        this.options.log?.(
          `attempt ${attempt} for ${host} failed after ${elapsed()} ms: ${errorMessage(error)}`
        )
        if (this.isUsedElsewhere(origin)) {
          this.verifiedAt.delete(origin)
          break
        }
        this.discard()
      }
    }
    throw new Error(`${NYM_UNAVAILABLE_ERROR}: ${errorMessage(lastError)}`)
  }

  private discard(): void {
    const link = this.link
    this.link = null
    this.verifiedAt.clear()
    this.requestsInTunnel = 0
    link?.close()
  }
}
