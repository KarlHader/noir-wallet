import type { PortfolioReadModel } from './portfolio-types'

export interface TokenDisplayPolicy {
  readonly allowedAssetIds: ReadonlySet<string>
  readonly visibleAssetIds: ReadonlySet<string>
  readonly hiddenAssetIds: ReadonlySet<string>
}

export function isPortfolioTokenVisible(
  assetId: string,
  held: boolean,
  policy: TokenDisplayPolicy
): boolean {
  if (policy.hiddenAssetIds.has(assetId)) return false
  return policy.visibleAssetIds.has(assetId) || (policy.allowedAssetIds.has(assetId) && held)
}

export function applyTokenDisplayPolicy(
  model: PortfolioReadModel,
  policy: TokenDisplayPolicy,
  detailAssetId?: string
): PortfolioReadModel {
  const chains = Object.freeze(
    model.chains.map(chain =>
      Object.freeze({
        ...chain,
        assets: Object.freeze(
          chain.assets.filter(row =>
            row.asset.kind === 'native'
              ? !policy.hiddenAssetIds.has(row.asset.id)
              : isPortfolioTokenVisible(
                  row.asset.id,
                  row.asset.id === detailAssetId || BigInt(row.balance.totalRaw) > 0n,
                  policy
                )
          )
        )
      })
    )
  )
  return Object.freeze({
    ...model,
    chains,
    assets: Object.freeze(chains.flatMap(chain => chain.assets)),
    ...(model.confidential
      ? {
          confidential: Object.freeze({
            ...model.confidential,
            assets: Object.freeze(
              model.confidential.assets.filter(row => {
                if (!row.assetId) return false
                if (row.assetId.includes('/slip44:')) {
                  return !policy.hiddenAssetIds.has(row.assetId)
                }
                return isPortfolioTokenVisible(
                  row.assetId,
                  row.assetId === detailAssetId || BigInt(row.availableRaw) > 0n,
                  policy
                )
              })
            )
          })
        }
      : {})
  })
}

export function hidePortfolioAssets(
  model: PortfolioReadModel,
  hiddenAssetIds: readonly string[]
): PortfolioReadModel {
  if (hiddenAssetIds.length === 0) return model
  const hidden = new Set(hiddenAssetIds)
  const chains = Object.freeze(
    model.chains.map(chain =>
      Object.freeze({
        ...chain,
        assets: Object.freeze(chain.assets.filter(asset => !hidden.has(asset.asset.id)))
      })
    )
  )
  return Object.freeze({
    ...model,
    chains,
    assets: Object.freeze(chains.flatMap(chain => chain.assets)),
    ...(model.confidential
      ? {
          confidential: Object.freeze({
            ...model.confidential,
            assets: Object.freeze(
              model.confidential.assets.filter(
                asset => !asset.assetId || !hidden.has(asset.assetId)
              )
            )
          })
        }
      : {})
  })
}
