import type { ChainRegistry } from '@/core/chains/registry'
import {
  createDetectedEvmAssetRecord,
  type DetectedEvmAssetRecord
} from '@/core/chains/user-assets'
import { readErc20Metadata } from './evm-erc20-metadata-reader'
import type { EvmContractRpc } from './evm-rpc-client'
import type { ChromeDetectedEvmAssetCatalogRepository } from './chrome-detected-evm-asset-catalog'
import type { EvmTokenDiscoveryClient } from './evm-token-discovery-client'

const DISCOVERY_COOLDOWN_MS = 5 * 60_000
const METADATA_CONCURRENCY = 3

export interface EvmTokenDiscoveryTarget {
  readonly address: string
  readonly chainIds: readonly string[]
}

export class DetectedEvmAssetCoordinator {
  private readonly now: () => number
  private readonly lastAttemptByAddress = new Map<string, number>()

  constructor(
    private readonly options: {
      readonly chains: ChainRegistry
      readonly repository: ChromeDetectedEvmAssetCatalogRepository
      readonly discovery: EvmTokenDiscoveryClient
      readonly resolveRpc: (chainId: string) => EvmContractRpc
      readonly resolveIconUrl?: (assetId: string) => Promise<string | undefined>
      readonly isExcluded?: (assetId: string) => boolean
      readonly now?: () => number
    }
  ) {
    this.now = options.now ?? Date.now
  }

  async list(): Promise<readonly DetectedEvmAssetRecord[]> {
    return this.options.repository.list()
  }

  async refresh(
    targets: readonly EvmTokenDiscoveryTarget[],
    options: { readonly force?: boolean } = {}
  ): Promise<boolean> {
    if (!this.options.discovery.available || targets.length === 0) return false
    const now = this.now()
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid Token discovery clock')
    const dueTargets = targets.filter(target => {
      const key = target.address.toLowerCase()
      const lastAttempt = this.lastAttemptByAddress.get(key) ?? 0
      return options.force === true || now - lastAttempt >= DISCOVERY_COOLDOWN_MS
    })
    if (dueTargets.length === 0) return false
    dueTargets.forEach(target => this.lastAttemptByAddress.set(target.address.toLowerCase(), now))

    const existing = new Map(
      (await this.options.repository.list()).map(asset => [asset.assetId, asset])
    )
    const candidates = (
      await Promise.all(
        dueTargets.map(target =>
          this.options.discovery.discover(target.address, target.chainIds).catch(() => [])
        )
      )
    ).flat()
    const uniqueCandidates = [
      ...new Map(candidates.map(item => [item.assetId, item])).values()
    ].filter(candidate => !this.options.isExcluded?.(candidate.assetId))
    const records: DetectedEvmAssetRecord[] = []
    let nextIndex = 0
    const worker = async () => {
      while (nextIndex < uniqueCandidates.length) {
        const candidate = uniqueCandidates[nextIndex++]
        const previous = existing.get(candidate.assetId)
        if (previous) {
          const iconUrl =
            candidate.iconUrl ??
            previous.metadata.iconUrl ??
            (await this.options.resolveIconUrl?.(candidate.assetId).catch(() => undefined))
          records.push(
            createDetectedEvmAssetRecord(this.options.chains, {
              ...previous,
              metadata:
                iconUrl && iconUrl !== previous.metadata.iconUrl
                  ? { ...previous.metadata, iconUrl }
                  : previous.metadata,
              lastSeenAt: now
            })
          )
          continue
        }
        try {
          const metadata = await readErc20Metadata(
            this.options.resolveRpc(candidate.chainId),
            candidate.contractAddress
          )
          const iconUrl =
            candidate.iconUrl ??
            (await this.options.resolveIconUrl?.(candidate.assetId).catch(() => undefined))
          records.push(
            createDetectedEvmAssetRecord(this.options.chains, {
              ...candidate,
              metadata: {
                ...metadata,
                ...(iconUrl ? { iconUrl } : {})
              },
              detectedAt: now,
              lastSeenAt: now
            })
          )
        } catch {
          // Invalid or non-standard contracts remain outside the spendable wallet registry.
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(METADATA_CONCURRENCY, uniqueCandidates.length) }, () =>
        worker()
      )
    )
    return records.length > 0 ? this.options.repository.upsert(records) : false
  }
}
