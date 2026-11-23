import type { ChainFeatureFlagValue } from './multichain-feature-flags'

const CHAIN_FEATURE_FLAG_PATTERN = /^chain\.[a-z0-9][a-z0-9.-]*$/

function isChainFeatureFlag(value: string): value is ChainFeatureFlagValue {
  return CHAIN_FEATURE_FLAG_PATTERN.test(value)
}

// Vite replaces the compile-time flag list. Node tests leave the identifier
// unbound, so a missing list stays empty instead of changing the defaults.
export function readEnabledChainFeatureFlags(): readonly ChainFeatureFlagValue[] {
  let compiled: readonly string[] | undefined
  try {
    compiled = __ENABLED_CHAIN_FEATURE_FLAGS__
  } catch {
    compiled = undefined
  }
  const override = (globalThis as { __ENABLED_CHAIN_FEATURE_FLAGS__?: unknown })
    .__ENABLED_CHAIN_FEATURE_FLAGS__
  const source = Array.isArray(compiled) ? compiled : override
  if (!Array.isArray(source)) return []
  return Object.freeze(
    source.filter(
      (flag): flag is ChainFeatureFlagValue => typeof flag === 'string' && isChainFeatureFlag(flag)
    )
  )
}
