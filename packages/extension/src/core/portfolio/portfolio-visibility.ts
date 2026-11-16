import type { PortfolioReadModel } from './portfolio-types'

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
    assets: Object.freeze(chains.flatMap(chain => chain.assets))
  })
}
