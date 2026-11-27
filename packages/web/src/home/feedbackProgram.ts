/**
 * Community Feedback Rewards (/feedback-rewards, FeedbackRewards.tsx): community members use the
 * wallet, report what they find, and earn points; each round's top three share 0.5 ZEC. It starts
 * as a trial of two two-week rounds. This is a product-feedback program, not the security bug
 * bounty: vulnerabilities go to HackenProof.
 *
 * Fill in the settings below as they are announced. Until then the page says the dates and the
 * submission link are still to come.
 */

/** When round 1 opens, as an ISO time with its zone, for example '2026-12-01T16:00:00Z'. */
export const FIRST_ROUND_START: string | null = null

/** The official feedback channel that every report goes through. */
export const SUBMIT_URL: string | null = null

/** The HackenProof bug bounty, where security issues are reported instead. */
export const BUG_BOUNTY_URL: string | null = 'https://hackenproof.com/programs/noirwallet'

/** Where the weekly leaderboard is posted. */
export const LEADERBOARD = { handle: '@noir_wallet', href: 'https://x.com/noir_wallet' } as const

export const ROUND_DAYS = 14
export const ROUND_COUNT = 2

/** Prize pool of each round (ZEC) and its split among the top three. */
export const ROUND_POOL = '0.5'
export const PRIZES = [
  { place: '1st', amount: '0.25' },
  { place: '2nd', amount: '0.15' },
  { place: '3rd', amount: '0.10' }
] as const

/** Points a report earns, by its real value to the product. A report counts in one row only. */
export const CATEGORIES: readonly { points: number; name: string; about: string }[] = [
  {
    points: 10,
    name: 'Major functional issue',
    about: 'A core feature does not work and seriously gets in the way of using the wallet.'
  },
  {
    points: 5,
    name: 'Functional issue',
    about: 'A feature misbehaves and gets in the way of normal use.'
  },
  {
    points: 5,
    name: 'Performance or compatibility issue',
    about: 'Problems with sync, speed, hardware wallets, browsers or dApps.'
  },
  {
    points: 3,
    name: 'Product suggestion',
    about: 'A clear improvement with a real use case and practical value.'
  },
  {
    points: 2,
    name: 'UI / UX issue',
    about: 'Problems with how screens display, respond or feel to use.'
  },
  {
    points: 1,
    name: 'Copy or translation issue',
    about: 'Text that is wrong or easy to misread.'
  },
  {
    points: 0,
    name: 'Invalid or duplicate',
    about: 'Known issues, repeat submissions, and feedback without real value.'
  }
]

/** Report values that the ranking example counts, highest first. */
export const POINT_VALUES = [10, 5, 3, 2, 1] as const

/** Ranking example: how many reports of each value (POINT_VALUES order) users A–D sent. */
export const EXAMPLE: readonly { user: string; counts: readonly number[] }[] = [
  { user: 'A', counts: [2, 1, 0, 0, 0] },
  { user: 'B', counts: [1, 3, 0, 0, 0] },
  { user: 'C', counts: [0, 5, 0, 0, 0] },
  { user: 'D', counts: [0, 0, 2, 6, 5] }
]

export function totalPoints(counts: readonly number[]): number {
  return counts.reduce((sum, count, index) => sum + count * POINT_VALUES[index], 0)
}

/**
 * Ranking order: total points, then more 10-point reports, then more 5-point reports. (The last
 * tie-break, who reached their final total first, needs submission times the example doesn't
 * have.)
 */
export function byRank(a: { counts: readonly number[] }, b: { counts: readonly number[] }) {
  return (
    totalPoints(b.counts) - totalPoints(a.counts) ||
    b.counts[0] - a.counts[0] ||
    b.counts[1] - a.counts[1]
  )
}

export const RULES: readonly { title: string; body: string }[] = [
  {
    title: 'Real and Verifiable',
    body: 'Feedback must be genuine and clear, with enough detail for the team to verify it.'
  },
  {
    title: 'First Report Counts',
    body: 'The same issue scores once, for the first person to report it validly.'
  },
  {
    title: 'One Defect, One Score',
    body: 'Related problems caused by the same defect are normally scored together.'
  },
  {
    title: 'No Repeats',
    body: 'Known or previously confirmed issues don’t score again. A fixed issue that comes back in a new version can.'
  },
  {
    title: 'No Limit',
    body: 'There is no cap on how many valid reports you send.'
  },
  {
    title: 'Play Fair',
    body: 'Multiple accounts, fake feedback and spam resubmissions can’t earn rewards.'
  },
  {
    title: 'Team Excluded',
    body: 'Noir Wallet staff and official testers are not ranked.'
  },
  {
    title: 'Valid Feedback to Win',
    body: 'Winners need at least one valid report. If fewer than three people qualify, the open places are not awarded.'
  }
]

/** What a report should include. */
export const REPORT_CHECKLIST = [
  'Your community username',
  'Your Noir Wallet version',
  'What happened, or your suggestion',
  'Steps to reproduce, if relevant',
  'Screenshots or a screen recording, if relevant',
  'Browser, device and network, if relevant'
] as const

const DAY_MS = 86_400_000

export type Round = { number: number; start: Date; end: Date }

/** The trial's rounds, back to back from the first start; none while the start is unset or invalid. */
export function roundsFrom(start: string | null): Round[] {
  const first = start ? new Date(start).getTime() : Number.NaN
  if (Number.isNaN(first)) return []
  return Array.from({ length: ROUND_COUNT }, (_, index) => ({
    number: index + 1,
    start: new Date(first + index * ROUND_DAYS * DAY_MS),
    end: new Date(first + (index + 1) * ROUND_DAYS * DAY_MS)
  }))
}

export type RoundPhase = 'upcoming' | 'live' | 'ended'

export function roundPhase(round: Round, now: Date): RoundPhase {
  if (now < round.start) return 'upcoming'
  return now < round.end ? 'live' : 'ended'
}

export type ProgramState =
  | { phase: 'unscheduled' }
  | { phase: 'upcoming'; round: Round }
  | { phase: 'live'; round: Round }
  | { phase: 'over' }

export function programState(rounds: readonly Round[], now: Date): ProgramState {
  if (rounds.length === 0) return { phase: 'unscheduled' }
  const live = rounds.find(round => roundPhase(round, now) === 'live')
  if (live) return { phase: 'live', round: live }
  return now < rounds[0].start ? { phase: 'upcoming', round: rounds[0] } : { phase: 'over' }
}

const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

function dayTime(date: Date): string {
  const hours = String(date.getUTCHours()).padStart(2, '0')
  const minutes = String(date.getUTCMinutes()).padStart(2, '0')
  return `${day.format(date)}, ${hours}:${minutes}`
}

/** "Dec 1, 16:00 UTC" */
export function utcMoment(date: Date): string {
  return `${dayTime(date)} UTC`
}

/** "Dec 1, 16:00 – Dec 15, 16:00 UTC" */
export function roundSpan(round: Round): string {
  return `${dayTime(round.start)} – ${utcMoment(round.end)}`
}

/** The status line under the page title. */
export function statusLine(state: ProgramState): string {
  switch (state.phase) {
    case 'unscheduled':
      return 'Round dates coming soon'
    case 'upcoming':
      return `Round 1 opens ${utcMoment(state.round.start)}`
    case 'live':
      return `Round ${state.round.number} of ${ROUND_COUNT} is open · closes ${utcMoment(state.round.end)}`
    case 'over':
      return 'The trial has ended. Thanks for taking part!'
  }
}

/**
 * The feedback link, while feedback is being collected: during a round, or before the dates are
 * set once the link exists. Before round 1 and after the trial the page says so instead.
 */
export function submitLinkFor(url: string | null, state: ProgramState): string | null {
  return url && (state.phase === 'live' || state.phase === 'unscheduled') ? url : null
}
