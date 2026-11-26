import type { ShieldWinCampaign, ShieldWinEntry } from './api'

export const ENTRY_POLL_INTERVAL_MS = 4000
export const ENTRY_POLL_LIMIT = 12
export const REWARD_POLL_INTERVAL_MS = 4000
export const REWARD_POLL_LIMIT = 30

export type BoardState = 'live' | 'upcoming' | 'ended-won' | 'ended-none' | 'missing'

export interface BoardView {
  readonly state: BoardState
  readonly pill: string
  readonly prizeAmount: string
  readonly prizeAsset: string
  readonly prizeDestination: string
  readonly drawsSoFar: number | null
  readonly endsLabel: string
  readonly endsValue: string
  readonly oddsLabel: string
  readonly oddsValue: string
  readonly minimumLabel: string
  readonly minimumValue: string
  readonly winnerNote: string
  readonly canJoin: boolean
}

export type EntryViewState =
  | 'none'
  | 'notwon'
  | 'won'
  | 'claiming'
  | 'sending'
  | 'claimed'
  | 'failed'

export interface EntryCopy {
  readonly title: string
  readonly body: string
}

const PRIZE_DESTINATION = 'Sent to your Zcash transparent address'
const ODDS_LABEL = 'Odds per draw'
const ODDS_VALUE = '1 / 4444'
const MINIMUM_LABEL = 'Minimum credited'

export function boardView(campaign: ShieldWinCampaign | null, nowMs: number): BoardView {
  if (campaign === null) {
    return {
      state: 'missing',
      pill: 'Unavailable',
      prizeAmount: '',
      prizeAsset: '',
      prizeDestination: '',
      drawsSoFar: null,
      endsLabel: 'Status',
      endsValue: 'Unavailable',
      oddsLabel: ODDS_LABEL,
      oddsValue: ODDS_VALUE,
      minimumLabel: MINIMUM_LABEL,
      minimumValue: '',
      winnerNote: '',
      canJoin: false
    }
  }
  const active = campaign.status === 'ACTIVE'
  return {
    state: stateOf(campaign),
    pill: pillOf(campaign),
    prizeAmount: campaign.reward_amount,
    prizeAsset: campaign.reward_asset,
    prizeDestination: PRIZE_DESTINATION,
    drawsSoFar: campaign.draw_count,
    endsLabel: campaign.status === 'ACTIVE' ? 'Ends in' : 'Status',
    endsValue:
      campaign.status === 'ACTIVE'
        ? countdown(campaign.end_time, nowMs)
        : statusWord(campaign.status),
    oddsLabel: ODDS_LABEL,
    oddsValue: ODDS_VALUE,
    minimumLabel: MINIMUM_LABEL,
    minimumValue: usdLabel(campaign.min_usd_value),
    winnerNote: winnerNoteOf(campaign),
    canJoin: active
  }
}

export function closedCampaignHint(board: BoardView): string {
  switch (board.state) {
    case 'upcoming':
      return 'This campaign has not started.'
    case 'ended-won':
      return prizeWonHint(board.prizeAmount, board.prizeAsset)
    case 'ended-none':
      return 'No one drew the winning number before the deadline. Thank you for participating!'
    case 'live':
    case 'missing':
      return ''
  }
}

export function latestEntry(entries: readonly ShieldWinEntry[]): ShieldWinEntry | null {
  return sortedEntries(entries)[0] ?? null
}

export function sortedEntries(entries: readonly ShieldWinEntry[]): ShieldWinEntry[] {
  return [...entries].sort(
    (left, right) => right.shield_completed_at - left.shield_completed_at || right.id - left.id
  )
}

export function entryView(entry: ShieldWinEntry | null): EntryViewState {
  if (entry === null) return 'none'
  if (entry.draw_result === 'NOT_WON') return 'notwon'
  switch (entry.reward_status) {
    case 'UNCLAIMED':
      return 'won'
    case 'CLAIMING':
      return 'claiming'
    case 'SENDING':
      return 'sending'
    case 'COMPLETED':
      return 'claimed'
    case 'FAILED':
      return 'failed'
    default:
      throw new Error('This winning entry has no payout status.')
  }
}

export function unclaimedWins(entries: readonly ShieldWinEntry[]): ShieldWinEntry[] {
  return entries
    .filter(entry => entry.draw_result === 'WON' && entry.reward_status === 'UNCLAIMED')
    .sort((left, right) => right.id - left.id)
}

export function rewardTransactionUrl(entry: ShieldWinEntry): string | null {
  return entry.draw_result === 'WON' && entry.reward_status === 'COMPLETED' && entry.transfer_hash
    ? `https://blockchair.com/zcash/transaction/${entry.transfer_hash}`
    : null
}

export function entryCopy(view: EntryViewState, entry: ShieldWinEntry | null): EntryCopy {
  if (view !== 'none' && entry === null) throw new Error('This result needs an entry.')
  switch (view) {
    case 'none':
      return { title: 'Not entered yet', body: 'You have not entered yet.' }
    case 'notwon':
      return { title: 'Not a winner', body: '' }
    case 'won':
      return {
        title: 'Unclaimed',
        body: 'You won a prize. Claim on this page to a Zcash transparent address.'
      }
    case 'claiming':
      return { title: 'Claiming', body: 'Your claim is being processed.' }
    case 'sending':
      return { title: 'Sending', body: 'Your payout is being sent.' }
    case 'claimed':
      return {
        title: 'Completed',
        body: 'Your payout is complete.'
      }
    case 'failed':
      return {
        title: 'Failed',
        body: 'The payout failed. Contact support for help.'
      }
    default: {
      const unreachable: never = view
      throw new Error(`Unknown entry result: ${String(unreachable)}`)
    }
  }
}

function stateOf(campaign: ShieldWinCampaign): BoardState {
  switch (campaign.status) {
    case 'ACTIVE':
      return 'live'
    case 'UPCOMING':
      return 'upcoming'
    case 'SOLD_OUT':
      return 'ended-won'
    case 'ENDED':
      return campaign.winner_count > 0 ? 'ended-won' : 'ended-none'
  }
}

function pillOf(campaign: ShieldWinCampaign): string {
  switch (campaign.status) {
    case 'ACTIVE':
      return 'Live · Prize unclaimed'
    case 'SOLD_OUT':
      return 'Ended · Prize won'
    case 'ENDED':
      return campaign.winner_count > 0 ? 'Ended · Prize won' : 'Ended · No winner'
    case 'UPCOMING':
      return 'Not started'
  }
}

export function campaignStatusWord(status: Exclude<ShieldWinCampaign['status'], 'ACTIVE'>): string {
  return statusWord(status)
}

export function deadlineLabel(endTimeSeconds: number): string {
  const ms = endTimeSeconds * 1000
  if (!Number.isFinite(ms)) return ''
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(new Date(ms))
}

function statusWord(status: Exclude<ShieldWinCampaign['status'], 'ACTIVE'>): string {
  switch (status) {
    case 'UPCOMING':
      return 'Soon'
    case 'SOLD_OUT':
    case 'ENDED':
      return 'Ended'
  }
}

function prizeWonHint(amount: string, asset: string): string {
  const prize = [amount, asset].filter(part => part.length > 0).join(' ')
  return prize
    ? `The ${prize} prize has been won. Thank you for participating!`
    : 'The prize has been won. Thank you for participating!'
}

function winnerNoteOf(campaign: ShieldWinCampaign): string {
  if (campaign.max_winners === 1) return 'Only one winner'
  if (campaign.max_winners === 0) return 'No winner cap'
  return `Up to ${campaign.max_winners} winners · ${campaign.winner_count} so far`
}

function usdLabel(amount: string): string {
  return amount.startsWith('$') ? amount : `$${amount}`
}

function countdown(endTimeSeconds: number, nowMs: number): string {
  const remainingMs = endTimeSeconds * 1000 - nowMs
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return '00:00:00'
  const totalSeconds = Math.ceil(remainingMs / 1000)
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const clock = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
  return days > 0 ? `${days}d ${clock}` : clock
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}
