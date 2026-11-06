import { MARGINAL_FEE_ZATS, isValidMarginalFeeZats, type FeeTier } from '../../config/fee.ts'

/** Typical logical action count for a 1-in/1-out shielded transfer. */
const TYPICAL_ACTIONS = 3

export function marginalFeeForTier(
  tier: FeeTier,
  standardMarginalFeeZats = MARGINAL_FEE_ZATS.standard
): number {
  if (!isValidMarginalFeeZats(standardMarginalFeeZats)) {
    throw new Error('Invalid recommended network fee')
  }
  if (tier !== 'standard' && tier !== 'fast') throw new Error('Invalid network fee tier')
  return standardMarginalFeeZats * (tier === 'fast' ? 4 : 1)
}

/** Coarse fee estimate (zatoshis) used before live estimation resolves. */
export function staticFeeFallbackZats(tier: FeeTier): number {
  return marginalFeeForTier(tier) * TYPICAL_ACTIONS
}
