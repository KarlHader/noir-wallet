import { Eip1193ProviderError } from '@/core/dapp/eip1193'
import type { BackgroundEvmDAppHandler, EvmDAppRequest, EvmDAppTabInfo } from './evm-dapp-handler'

interface OriginRuntimeOptions {
  readonly readChainId: (origin: string) => Promise<string>
  readonly createHandler: (chainId: string) => BackgroundEvmDAppHandler
}

interface RuntimeEntry {
  readonly handler: BackgroundEvmDAppHandler
  readonly cancelled: Promise<never>
  readonly cancel: () => void
}

/** A site's chain change invalidates only that site's in-flight requests. */
export class EvmDAppOriginRuntime {
  private readonly handlers = new Map<string, RuntimeEntry>()
  private readonly revisions = new Map<string, number>()
  private active = true

  constructor(private readonly options: OriginRuntimeOptions) {}

  async get(origin: string): Promise<BackgroundEvmDAppHandler> {
    const revision = this.revisions.get(origin)
    const chainId = await this.options.readChainId(origin)
    if (!this.active) throw this.changed()
    if (revision !== this.revisions.get(origin)) return this.get(origin)
    const current = this.handlers.get(origin)
    if (current?.handler.getCaip2ChainId() === chainId) return current.handler
    current?.handler.deactivate()
    current?.cancel()
    const handler = this.options.createHandler(chainId)
    let cancel!: () => void
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(this.changed())
    })
    void cancelled.catch(() => {})
    this.handlers.set(origin, { handler, cancelled, cancel })
    return handler
  }

  async request(
    request: EvmDAppRequest,
    origin: string,
    tabInfo: EvmDAppTabInfo,
    validate?: (chainId: string) => Promise<void>
  ): Promise<unknown> {
    const handler = await this.get(origin)
    const entry = this.handlers.get(origin)
    await validate?.(handler.getCaip2ChainId())
    if (!this.active || !entry || entry.handler !== handler || this.handlers.get(origin) !== entry)
      throw this.changed()
    const changesRuntime =
      request.method === 'wallet_switchEthereumChain' ||
      request.method === 'wallet_addEthereumChain' ||
      request.method === 'wallet_revokePermissions'
    const operation = handler.request(request, origin, tabInfo)
    const result = changesRuntime
      ? await operation
      : await Promise.race([operation, entry.cancelled])
    // These operations intentionally replace a runtime or reload the network catalog.
    if (!changesRuntime) {
      if (!this.active || (await this.get(origin)) !== handler) throw this.changed()
    }
    return result
  }

  invalidate(origin: string): void {
    this.handlers.get(origin)?.handler.deactivate()
    this.handlers.get(origin)?.cancel()
    this.handlers.delete(origin)
    this.revisions.set(origin, (this.revisions.get(origin) ?? 0) + 1)
  }

  deactivate(): void {
    this.active = false
    for (const entry of this.handlers.values()) {
      entry.handler.deactivate()
      entry.cancel()
    }
    this.handlers.clear()
    this.revisions.clear()
  }

  private changed(): Eip1193ProviderError {
    return new Eip1193ProviderError(4901, 'The site network changed. Review the request again.')
  }
}
