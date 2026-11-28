/**
 * Copy for the campaign entry on the home page (Campaign.tsx): the ticket's title and the sheet
 * it opens. Amounts and dates come from the campaign API, so they always match the campaign page.
 */
import type { ShieldWinCampaign } from '../shield-and-win/api'

/** Odds of a single draw, from the campaign team; the API does not report them. */
export const DRAW_ODDS = '1 in 444'

/** One prize, e.g. "0.1 ZEC" */
export function prizeOf(campaign: ShieldWinCampaign): string {
  return `${campaign.reward_amount} ${campaign.reward_asset}`.trim()
}

/**
 * The whole prize pool, e.g. 10 prizes of 0.1 ZEC make "1 ZEC". Decimal amounts are multiplied
 * as integers, so no rounding creeps in. Without a cap on winners it is one prize.
 */
export function poolOf(campaign: ShieldWinCampaign): string {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(campaign.reward_amount)
  if (!match || campaign.max_winners <= 0) return prizeOf(campaign)
  const fraction = match[2] ?? ''
  const units = BigInt(match[1] + fraction) * BigInt(campaign.max_winners)
  const digits = units.toString().padStart(fraction.length + 1, '0')
  const whole = digits.slice(0, digits.length - fraction.length)
  const decimals = digits.slice(digits.length - fraction.length).replace(/0+$/, '')
  return `${decimals ? `${whole}.${decimals}` : whole} ${campaign.reward_asset}`.trim()
}

function minimumUsd(campaign: ShieldWinCampaign): number | null {
  const amount = Number(campaign.min_usd_value)
  return Number.isFinite(amount) && amount > 0 ? amount : null
}

/** The minimum shield in dollars, e.g. "$10"; null when the campaign has none */
export function minimumOf(campaign: ShieldWinCampaign): string | null {
  return minimumUsd(campaign) === null ? null : `$${campaign.min_usd_value}`
}

/** What to send so the minimum still arrives after fees: 20% more, rounded up to whole dollars */
export function suggestedOf(campaign: ShieldWinCampaign): string | null {
  const amount = minimumUsd(campaign)
  return amount === null ? null : `$${Math.ceil(amount * 1.2)}`
}

/** "Dec 3, 16:00 UTC": the time is in UTC, so the day cannot be misread in other time zones */
export function shortDate(seconds: number): string {
  const text = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(new Date(seconds * 1000))
  return `${text} UTC`
}

export interface EntryStep {
  readonly title: string
  readonly body: string
}

export interface EntryCopy {
  /** The ticket's title, with the whole prize pool */
  readonly title: string
  /** The sheet's heading, with the whole prize pool too */
  readonly heading: string
  readonly lede: string
  readonly steps: readonly [EntryStep, EntryStep, EntryStep]
  /** Prizes, odds and end date; the sheet adds a link to the full rules */
  readonly facts: string
}

export function entryCopy(campaign: ShieldWinCampaign): EntryCopy {
  const minimum = minimumOf(campaign)
  const suggested = suggestedOf(campaign)
  const prize = prizeOf(campaign)
  const pool = poolOf(campaign)
  const prizes =
    campaign.max_winners === 1
      ? `1 prize of ${prize}`
      : campaign.max_winners > 1
        ? `${campaign.max_winners} prizes of ${prize}`
        : `Prizes of ${prize}`

  return {
    title: `Go Private, Win ${pool}`,
    heading: minimum ? `Shield ${minimum}. Win ${pool}.` : `Shield and win ${pool}.`,
    lede: minimum
      ? `Shield your EVM address with min ${minimum} to get an instant draw. Your ${minimum} stays in your own balance.`
      : 'Shield your EVM address to get an instant draw. Your funds stay in your own balance.',
    steps: [
      { title: 'Get Noir', body: 'Install the extension, then create or import a wallet.' },
      minimum
        ? {
            title: `Have ${minimum}+ in Public`,
            body: `Top up your Public account if it’s under ${minimum}. Already funded? Skip ahead.`
          }
        : {
            title: 'Have funds in Public',
            body: 'Top up your Public account if it’s empty. Already funded? Skip ahead.'
          },
      {
        title: 'Shield → NEAR Confidential',
        body: minimum
          ? `At least ${minimum} must arrive after fees (we suggest ${suggested}). Your draw runs instantly and the result shows in the app.`
          : 'Your draw runs instantly and the result shows in the app.'
      }
    ],
    facts: `${prizes} · ${DRAW_ODDS} per draw · Ends ${shortDate(campaign.end_time)}`
  }
}
