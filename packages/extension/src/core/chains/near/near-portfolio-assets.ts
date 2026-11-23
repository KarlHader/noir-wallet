import {
  supportsNearPrivateExecution,
  type NearPrivateExecutionWalletSource
} from './execution-capability'

export const NEAR_PORTFOLIO_TOKEN_LIMIT = 64
export const NEAR_PORTFOLIO_INVENTORY_LIMIT = 2_048
export const NEAR_MAINNET_CHAIN_ID = 'near:mainnet'
export const NEAR_MAINNET_NATIVE_ASSET_ID = `${NEAR_MAINNET_CHAIN_ID}/slip44:397`

const NEAR_CONTRACT_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/

export function isNearBridgeFungibleContract(contractId: string): boolean {
  return contractId.includes('.omft.') || contractId.includes('.omdep.')
}

export function decodeNearContractId(reference: string): string {
  return reference.replace(/%5F/gi, '_')
}

export function encodeNearContractReference(contractId: string): string {
  return contractId.replace(/_/g, '%5F')
}

export function nearFungibleAssetId(chainId: string, contractId: string): string {
  return `${chainId}/nep141:${encodeNearContractReference(contractId)}`
}

export function isNearFungibleContractId(contractId: string): boolean {
  return (
    contractId.length >= 2 &&
    contractId.length <= 64 &&
    NEAR_CONTRACT_PATTERN.test(contractId) &&
    !isNearBridgeFungibleContract(contractId)
  )
}

/** Intents `nep141:` id for a NEAR chain asset. Bridge omft and omdep assets are not chain holdings. */
export function nearConfidentialPortfolioAssetId(protocolAssetId: string): string | null {
  if (!protocolAssetId.startsWith('nep141:')) return null
  const contractId = protocolAssetId.slice('nep141:'.length)
  if (contractId === 'wrap.near') return NEAR_MAINNET_NATIVE_ASSET_ID
  if (!isNearFungibleContractId(contractId)) return null
  return nearFungibleAssetId(NEAR_MAINNET_CHAIN_ID, contractId)
}

export interface NearPortfolioTokenCandidate {
  readonly contractId: string
  readonly assetId: string
  readonly symbol: string
  readonly decimals: number
  readonly name: string
  readonly discovered: boolean
}

export interface NearPortfolioPrivateExecution {
  readonly walletSource: NearPrivateExecutionWalletSource
  readonly accountIndex: number
  readonly address?: string | null
}

function privateExecutionSource(
  execution: NearPortfolioPrivateExecution
): NearPrivateExecutionWalletSource {
  return execution.walletSource.kind === 'private-key'
    ? {
        kind: 'private-key',
        chainFamily: execution.walletSource.chainFamily,
        accountIndex: execution.accountIndex
      }
    : execution.walletSource
}

/** Hardware and other accounts without a NEAR PEA do not contribute a private on-chain balance. */
export function nearPortfolioPrivateAccountId(
  execution: NearPortfolioPrivateExecution | undefined,
  mainAccountId: string
): string | null {
  const address = execution?.address
  if (!execution || !address || !/^[0-9a-f]{64}$/.test(address) || address === mainAccountId) {
    return null
  }
  return supportsNearPrivateExecution(privateExecutionSource(execution)) ? address : null
}

function acceptToken(
  selected: NearPortfolioTokenCandidate[],
  seen: Set<string>,
  token: NearPortfolioTokenCandidate,
  limit: number
): boolean {
  if (selected.length >= limit) return false
  if (seen.has(token.contractId) || isNearBridgeFungibleContract(token.contractId)) return true
  seen.add(token.contractId)
  selected.push(token)
  return true
}

/**
 * Token definitions passed to the balance reader.
 * Priority: user-enabled, FastNear non-zero holdings, bundled defaults, then other registered tokens.
 */
export function selectNearPortfolioTokens(input: {
  readonly userEnabled: readonly NearPortfolioTokenCandidate[]
  readonly holdings: readonly NearPortfolioTokenCandidate[]
  readonly bundled: readonly NearPortfolioTokenCandidate[]
  readonly registered: readonly NearPortfolioTokenCandidate[]
  readonly limit?: number
}): readonly NearPortfolioTokenCandidate[] {
  const limit = input.limit ?? NEAR_PORTFOLIO_TOKEN_LIMIT
  const selected: NearPortfolioTokenCandidate[] = []
  const seen = new Set<string>()
  for (const group of [input.userEnabled, input.holdings, input.bundled, input.registered]) {
    for (const token of group) {
      if (!acceptToken(selected, seen, token, limit)) {
        return Object.freeze(selected)
      }
    }
  }
  return Object.freeze(selected)
}
