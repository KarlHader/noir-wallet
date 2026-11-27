import type { OneClickOrder, OneClickViewer } from './one-click-order'
import { DedupPromise } from '@/lib/async-utils'
import { FetchHttpError, FetchTimeoutError, fetchJsonWithTimeout } from '@/lib/fetch-utils'
import type { Network } from '@/types/wallet'

export interface OneClickAccount {
  readonly network: Network
  readonly walletId: string
  readonly accountId: string
}

export interface OneClickTokenScope extends OneClickAccount {
  readonly endpoint: string
  readonly viewer: OneClickViewer
}

export interface OneClickTokenStore {
  read(scope: OneClickTokenScope): Promise<string | null>
  write(scope: OneClickTokenScope, token: string): Promise<void>
  invalidate(scope: OneClickTokenScope, rejectedToken: string): Promise<void>
}

export interface OneClickChallenge {
  readonly id: string
  readonly message: string
  readonly expiresAt: number
  readonly near?: { readonly recipient: string; readonly nonce: Uint8Array<ArrayBuffer> }
}

interface Options {
  readonly tokens: OneClickTokenStore
  readonly resolveSigner: (
    scope: OneClickTokenScope
  ) => Promise<((challenge: OneClickChallenge) => Promise<Record<string, string> | null>) | null>
  readonly now?: () => number
  readonly request?: typeof fetchJsonWithTimeout
}

const STATEMENT = 'Rhea 1Click Order Status Read Authorization v1'
const SIGNING_METHODS = {
  evm: ['personal_sign'],
  solana: ['signMessage', 'solana_signMessage'],
  near: ['NEP-413'],
  btc: ['signMessage', 'bip322-simple', 'btc_signMessage'],
  zcash: ['signmessage', 'signMessage', 'zcash_signMessage']
} as const satisfies Record<OneClickViewer['chainFamily'], readonly string[]>

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid 1Click authorization response')
  }
  return value as Record<string, unknown>
}

export function oneClickTokenKey(scope: OneClickTokenScope): string {
  return JSON.stringify([
    scope.endpoint,
    scope.network,
    scope.walletId,
    scope.accountId,
    scope.viewer.chainFamily,
    scope.viewer.chainFamily === 'evm'
      ? scope.viewer.walletAddress.toLowerCase()
      : scope.viewer.walletAddress
  ])
}

export function parseOneClickChallenge(
  value: unknown,
  family: OneClickViewer['chainFamily'],
  now: number
): OneClickChallenge {
  const data = record(record(value).data)
  const input = record(data.signingInput)
  const methods: readonly string[] = SIGNING_METHODS[family]
  const expiresAt = typeof data.expiresAt === 'string' ? Date.parse(data.expiresAt) : NaN
  if (
    typeof data.challengeId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,160}$/.test(data.challengeId) ||
    typeof data.signingMethod !== 'string' ||
    !methods.includes(data.signingMethod) ||
    typeof input.message !== 'string' ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now
  ) {
    throw new Error('Invalid 1Click signing challenge')
  }
  if (family === 'near') {
    if (
      input.message !== STATEMENT ||
      typeof input.recipient !== 'string' ||
      !/^[a-z0-9._-]{2,64}$/.test(input.recipient) ||
      typeof input.nonce !== 'string' ||
      !/^[A-Za-z0-9+/]{43}=$/.test(input.nonce)
    ) {
      throw new Error('Invalid 1Click NEAR signing input')
    }
    const nonce = Uint8Array.from(atob(input.nonce), character => character.charCodeAt(0))
    return {
      id: data.challengeId,
      message: input.message,
      expiresAt,
      near: { recipient: input.recipient, nonce }
    }
  }
  const prefix = `${STATEMENT}\nNonce: `
  const nonce = input.message.slice(prefix.length)
  if (!input.message.startsWith(prefix) || !/^[a-zA-Z0-9_+/=-]{16,256}$/.test(nonce)) {
    throw new Error('Invalid 1Click order status message')
  }
  return { id: data.challengeId, message: input.message, expiresAt }
}

export class OneClickStatusClient {
  private readonly auth = new Map<string, DedupPromise<string | null>>()
  private readonly backoff = new Map<string, { until: number; interval: number }>()
  private readonly request: typeof fetchJsonWithTimeout
  private readonly now: () => number

  constructor(private readonly options: Options) {
    this.request = options.request ?? fetchJsonWithTimeout
    this.now = options.now ?? Date.now
  }

  private async requestJson(url: URL, init: RequestInit): Promise<unknown> {
    try {
      return await this.request(url, {
        ...init,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        maxBytes: 1024 * 1024,
        timeoutMs: 15_000
      })
    } catch (error) {
      if (error instanceof FetchHttpError) throw new FetchHttpError(error.status, '')
      throw error
    }
  }

  private async getToken(
    scope: OneClickTokenScope,
    resolveSigner = this.options.resolveSigner
  ): Promise<string | null> {
    const key = oneClickTokenKey(scope)
    const pending = this.auth.get(key)
    if (pending) return pending.run(() => this.authorize(scope, resolveSigner))
    const task = new DedupPromise<string | null>()
    this.auth.set(key, task)
    try {
      return await task.run(() => this.authorize(scope, resolveSigner))
    } finally {
      this.auth.delete(key)
    }
  }

  async authorizeOwner(
    scope: OneClickTokenScope,
    sign: NonNullable<Awaited<ReturnType<Options['resolveSigner']>>>
  ): Promise<boolean> {
    const resolveSigner = async () => sign
    return Boolean(
      (await this.getToken(scope, resolveSigner)) ?? (await this.getToken(scope, resolveSigner))
    )
  }

  private async authorize(
    scope: OneClickTokenScope,
    resolveSigner: Options['resolveSigner']
  ): Promise<string | null> {
    const cached = await this.options.tokens.read(scope)
    if (cached) return cached
    const sign = await resolveSigner(scope)
    if (!sign) return null
    const authUrl = new URL('/api/1click/status/auth/', scope.endpoint)
    const post = (path: string, body: unknown) =>
      this.requestJson(new URL(path, authUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
    const challenge = parseOneClickChallenge(
      await post('challenge', {
        chainFamily: scope.viewer.chainFamily,
        walletAddress: scope.viewer.walletAddress
      }),
      scope.viewer.chainFamily,
      this.now()
    )
    const proof = await sign(challenge)
    if (!proof) return null
    if (this.now() >= challenge.expiresAt) throw new Error('1Click signing challenge expired')
    const token = record(
      record(await post('verify', { challengeId: challenge.id, proof })).data
    ).token
    if (typeof token !== 'string' || !/^[a-zA-Z0-9._~+\/=-]{1,8192}$/.test(token)) {
      throw new Error('Invalid 1Click status token')
    }
    await this.options.tokens.write(scope, token)
    return token
  }

  async query(
    scope: OneClickTokenScope,
    order: OneClickOrder,
    signal?: AbortSignal
  ): Promise<unknown | null> {
    signal?.throwIfAborted()
    if ((this.backoff.get(scope.endpoint)?.until ?? 0) > this.now()) return null
    const query = new URL(`${scope.endpoint}/status/owner`)
    query.searchParams.set('depositAddress', order.depositAddress)
    if (order.depositMemo !== undefined) query.searchParams.set('depositMemo', order.depositMemo)

    try {
      for (const attempt of [0, 1]) {
        const token = await this.getToken(scope)
        signal?.throwIfAborted()
        if (!token) return null
        try {
          const status = await this.requestJson(query, {
            headers: { Authorization: `Bearer ${token}` },
            signal
          })
          this.backoff.delete(scope.endpoint)
          return status
        } catch (error) {
          if (!(error instanceof FetchHttpError) || error.status !== 401) throw error
          await this.options.tokens.invalidate(scope, token)
          if (attempt === 1) return null
        }
      }
    } catch (error) {
      signal?.throwIfAborted()
      if (
        error instanceof FetchTimeoutError ||
        (error instanceof FetchHttpError && [502, 503].includes(error.status))
      ) {
        const last = this.backoff.get(scope.endpoint)?.interval ?? 15_000
        const interval = Math.min(last * 2, 5 * 60_000)
        this.backoff.set(scope.endpoint, { until: this.now() + interval, interval })
        return null
      }
      if (error instanceof FetchHttpError && [401, 404].includes(error.status)) return null
      throw error
    }
    return null
  }
}
