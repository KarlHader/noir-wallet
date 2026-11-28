import type { ShieldWinCampaign } from './api'

/** The most prizes shown as boxes, one row of them. Bigger or uncapped campaigns keep the coin view. */
export const MAX_PRIZE_BOXES = 10

export interface PrizeBoard {
  readonly total: number
  readonly taken: number
  readonly left: number
  /** Which boxes are open, by position: won prizes fill the row from the left. */
  readonly opened: readonly boolean[]
  /** The box in the draw right now (the next prize) while the campaign is live, else null. */
  readonly current: number | null
}

/**
 * One box per prize. Won prizes open the boxes from the left; the next one is in the draw while
 * the campaign is live, and the rest stay sealed. A campaign that sold out has every box open.
 */
export function prizeBoard(campaign: ShieldWinCampaign): PrizeBoard | null {
  const total = campaign.max_winners
  if (!Number.isInteger(total) || total < 1 || total > MAX_PRIZE_BOXES) return null
  const won = Number.isInteger(campaign.winner_count) ? Math.max(campaign.winner_count, 0) : 0
  const taken = campaign.status === 'SOLD_OUT' ? total : Math.min(won, total)
  const opened = Array.from({ length: total }, (_, index) => index < taken)
  const current = campaign.status === 'ACTIVE' && taken < total ? taken : null
  return { total, taken, left: total - taken, opened, current }
}
