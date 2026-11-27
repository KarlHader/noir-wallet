import type { ShieldWinCampaign } from './api'

/** The most prizes the board draws as balloons. Bigger or uncapped campaigns keep the coin view. */
export const MAX_BALLOONS = 20

/** Balloons per row on the board. */
export const BALLOON_COLUMNS = 5

export interface PrizeBoard {
  readonly total: number
  readonly taken: number
  readonly left: number
  /** Which balloons are popped, by position. */
  readonly popped: readonly boolean[]
}

/**
 * One balloon per prize. Each win pops one, in a fixed scattered order, so the board looks like
 * hits on a shooting gallery instead of filling up from the left. A campaign that sold out has
 * every balloon popped.
 */
export function prizeBoard(campaign: ShieldWinCampaign): PrizeBoard | null {
  const total = campaign.max_winners
  if (!Number.isInteger(total) || total < 1 || total > MAX_BALLOONS) return null
  const won = Number.isInteger(campaign.winner_count) ? Math.max(campaign.winner_count, 0) : 0
  const taken = campaign.status === 'SOLD_OUT' ? total : Math.min(won, total)
  const popped = Array.from({ length: total }, () => false)
  for (const index of popOrder(total, campaign.id).slice(0, taken)) popped[index] = true
  return { total, taken, left: total - taken, popped }
}

/**
 * The order balloons pop in. Each next pop is the balloon farthest from the ones already popped,
 * so hits spread over the board; the campaign id picks the first one and breaks ties, so the
 * order is the same on every visit.
 */
export function popOrder(total: number, seed: number): number[] {
  const columns = Math.min(BALLOON_COLUMNS, total)
  const spot = (index: number) => [index % columns, Math.floor(index / columns)] as const
  // In [0, 1): never outweighs a real difference in squared grid distance, which is a whole number
  const tieBreak = (index: number) =>
    mix(Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(index + 1, 0x85ebca6b)) / 2 ** 32
  const order: number[] = []
  const waiting = new Set(Array.from({ length: total }, (_, index) => index))
  while (waiting.size > 0) {
    let best = -1
    let bestScore = -Infinity
    for (const index of waiting) {
      const [x, y] = spot(index)
      let nearest = order.length === 0 ? 0 : Infinity
      for (const popped of order) {
        const [px, py] = spot(popped)
        nearest = Math.min(nearest, (x - px) ** 2 + (y - py) ** 2)
      }
      const score = nearest + tieBreak(index) * 0.9
      if (score > bestScore) {
        bestScore = score
        best = index
      }
    }
    order.push(best)
    waiting.delete(best)
  }
  return order
}

// A 32-bit integer hash (the "lowbias32" mixer)
function mix(value: number): number {
  let x = value | 0
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d)
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b)
  return (x ^ (x >>> 16)) >>> 0
}
