import type { PortfolioAssetView, PortfolioReadModel } from '@/core/portfolio'

export interface ConfidentialPortfolioBalance {
  readonly tokenId: string
  readonly available: string
}

export interface ConfidentialPortfolioAssetMapping {
  readonly assetId: string
  readonly protocolAssetId: string
}

// Mainnet uses this shared treasury namespace; arbitrary IMT suffix matches are not equivalent assets.
// https://docs.near-intents.org/integration/market-makers/confidential-intents
export const CONFIDENTIAL_PRIVATE_TREASURY_ACCOUNT_ID =
  '51e8f94d77b5e90dc9852ca6113771e11e8382ce69473a75e313e41665de7cbe'

export function confidentialPrivateTokenId(protocolAssetId: string): string {
  return `imt:${CONFIDENTIAL_PRIVATE_TREASURY_ACCOUNT_ID}:${protocolAssetId}`
}

export function getConfidentialAvailableForAsset(
  balances: readonly ConfidentialPortfolioBalance[],
  protocolAssetId: string
): string | null {
  const row =
    balances.find(balance => balance.tokenId === confidentialPrivateTokenId(protocolAssetId)) ??
    balances.find(balance => balance.tokenId === protocolAssetId)
  return row && /^(0|[1-9][0-9]*)$/.test(row.available) ? row.available : null
}

function mergeAsset(
  asset: PortfolioAssetView,
  mappings: readonly ConfidentialPortfolioAssetMapping[],
  balances: readonly ConfidentialPortfolioBalance[]
): PortfolioAssetView {
  const mapping = mappings.find(candidate => candidate.assetId === asset.asset.id)
  if (!mapping || asset.balance.mainRaw === undefined || asset.balance.privateRaw === undefined) {
    return asset
  }
  const confidentialRaw = getConfidentialAvailableForAsset(balances, mapping.protocolAssetId) ?? '0'
  if (!/^\d+$/.test(confidentialRaw)) return asset
  const previousConfidential = BigInt(asset.balance.confidentialRaw ?? '0')
  const privateOnchain = BigInt(
    asset.balance.privateOnchainRaw ??
      (BigInt(asset.balance.privateRaw) - previousConfidential).toString()
  )
  const nextConfidential = BigInt(confidentialRaw)
  const delta = nextConfidential - previousConfidential
  const addDelta = (raw: string) => (BigInt(raw) + delta).toString()
  return Object.freeze({
    ...asset,
    balance: Object.freeze({
      ...asset.balance,
      totalRaw: addDelta(asset.balance.totalRaw),
      privateRaw: (privateOnchain + nextConfidential).toString(),
      privateOnchainRaw: privateOnchain.toString(),
      confidentialRaw: nextConfidential.toString()
    })
  })
}

export function mergeConfidentialBalancesIntoPortfolio(
  model: PortfolioReadModel,
  mappings: readonly ConfidentialPortfolioAssetMapping[],
  balances: readonly ConfidentialPortfolioBalance[]
): PortfolioReadModel {
  const assets = model.assets.map(asset => mergeAsset(asset, mappings, balances))
  const byId = new Map(assets.map(asset => [asset.asset.id, asset]))
  const chains = model.chains.map(chain =>
    Object.freeze({
      ...chain,
      assets: Object.freeze(chain.assets.map(asset => byId.get(asset.asset.id) ?? asset))
    })
  )
  return Object.freeze({ ...model, assets: Object.freeze(assets), chains: Object.freeze(chains) })
}
