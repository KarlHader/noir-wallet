export type ChainFeatureFlagValue = `chain.${string}`

export const ZCASH_CHAIN_FEATURE_FLAG = 'chain.zcash' as const
export const EVM_CHAIN_FEATURE_FLAG = 'chain.evm' as const
export const BITCOIN_CHAIN_FEATURE_FLAG = 'chain.bitcoin' as const
export const SOLANA_CHAIN_FEATURE_FLAG = 'chain.solana' as const
export const NEAR_CHAIN_FEATURE_FLAG = 'chain.near' as const
export const ALL_CHAIN_FEATURE_FLAGS = Object.freeze([
  ZCASH_CHAIN_FEATURE_FLAG,
  EVM_CHAIN_FEATURE_FLAG,
  BITCOIN_CHAIN_FEATURE_FLAG,
  SOLANA_CHAIN_FEATURE_FLAG,
  NEAR_CHAIN_FEATURE_FLAG
] as const)

export const DEFAULT_ENABLED_CHAIN_FEATURE_FLAGS = Object.freeze([
  ZCASH_CHAIN_FEATURE_FLAG,
  EVM_CHAIN_FEATURE_FLAG
] as const)

const CHAIN_FEATURE_FLAG_PATTERN = /^chain\.[a-z0-9][a-z0-9.-]*$/

function isChainFeatureFlag(value: string): value is ChainFeatureFlagValue {
  return CHAIN_FEATURE_FLAG_PATTERN.test(value)
}

function validateAllowedFlags(
  allowedFlags: readonly ChainFeatureFlagValue[]
): ReadonlySet<ChainFeatureFlagValue> {
  const allowed = new Set<ChainFeatureFlagValue>()
  for (const flag of allowedFlags) {
    if (!isChainFeatureFlag(flag)) {
      throw new Error(`Invalid allowed chain feature flag: ${flag}`)
    }
    if (allowed.has(flag)) {
      throw new Error(`Duplicate allowed chain feature flag: ${flag}`)
    }
    allowed.add(flag)
  }
  if (!allowed.has(ZCASH_CHAIN_FEATURE_FLAG)) {
    throw new Error('The Zcash V1 feature flag must always be allowed')
  }
  return allowed
}

export function parseEnabledChainFeatureFlags(
  raw: string | undefined,
  allowedFlags: readonly ChainFeatureFlagValue[]
): readonly ChainFeatureFlagValue[] {
  const allowed = validateAllowedFlags(allowedFlags)
  const requested =
    raw === undefined
      ? DEFAULT_ENABLED_CHAIN_FEATURE_FLAGS.filter(
          flag => flag !== ZCASH_CHAIN_FEATURE_FLAG && allowed.has(flag)
        )
      : raw.trim().length === 0
        ? []
        : raw.split(',').map(value => value.trim())
  const requestedFlags = new Set<ChainFeatureFlagValue>()
  const enabled = new Set<ChainFeatureFlagValue>([ZCASH_CHAIN_FEATURE_FLAG])

  for (const flag of requested) {
    if (!isChainFeatureFlag(flag)) {
      throw new Error(`Invalid enabled chain feature flag: ${flag}`)
    }
    if (!allowed.has(flag)) {
      throw new Error(`Chain feature flag is not releaseable: ${flag}`)
    }
    if (requestedFlags.has(flag)) {
      throw new Error(`Duplicate enabled chain feature flag: ${flag}`)
    }
    requestedFlags.add(flag)
    enabled.add(flag)
  }

  return Object.freeze([...enabled])
}
