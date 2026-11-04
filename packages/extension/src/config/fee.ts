/**
 * Dynamic fee tiers for Zcash sends/shields.
 *
 * Standard follows the wallet RPC's recommended ZIP-317 marginal fee; Fast
 * uses four times that recommendation. Fixed rates are only the fallback
 * when the RPC cannot provide a valid recommendation.
 */
export type FeeTier = 'standard' | 'fast'

export interface FeeQuote {
  id: string
  standardMarginalFeeZats: number
  expiresAt: number
}

export interface QuotedFeeEstimate {
  feeZats: string
  marginalFeeZats: string
  feeQuote: FeeQuote
}

export const FEE_QUOTE_TTL_MS = 5 * 60_000
export const MAX_MARGINAL_FEE_ZATS = Math.floor(2_100_000_000_000_000 / 4)

export function isValidMarginalFeeZats(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_MARGINAL_FEE_ZATS
  )
}

/** ZIP-317 marginal fee per logical action, in zatoshis, keyed by tier. */
export const MARGINAL_FEE_ZATS: Record<FeeTier, number> = {
  standard: 5_000,
  fast: 20_000
}

export const DEFAULT_FEE_TIER: FeeTier = 'standard'

/** Leave enough blocks for NU7 transaction proving and broadcast. */
export const DEFAULT_EXPIRY_DELTA_BLOCKS = 40

/** Typical logical action count for a 1-in/1-out shielded transfer. */
const TYPICAL_ACTIONS = 3

export interface FeeTierMeta {
  id: FeeTier
  label: string
  /** Marginal-fee multiple of the ZIP-317 baseline. */
  multiplier: number
  /** Short delivery hint shown under the tier label. */
  etaHint: string
  /** Iconify name used as the tier's leading glyph. */
  icon: string
}

export const FEE_TIERS: readonly FeeTierMeta[] = [
  { id: 'standard', label: 'Standard', multiplier: 1, etaHint: '~2 min', icon: 'lucide:clock' },
  { id: 'fast', label: 'Fast', multiplier: 4, etaHint: 'Priority', icon: 'lucide:zap' }
]

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

/** Human-readable tier name (e.g. "Standard", "Fast"). */
export function getFeeTierLabel(tier: FeeTier): string {
  return (FEE_TIERS.find(t => t.id === tier) ?? FEE_TIERS[0]).label
}

/** Coarse fee estimate (zatoshis) used before live estimation resolves. */
export function staticFeeFallbackZats(tier: FeeTier): number {
  return marginalFeeForTier(tier) * TYPICAL_ACTIONS
}
