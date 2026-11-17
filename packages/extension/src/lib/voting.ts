import { isZcashHardwareKeySource } from '@/core/wallet/hardware-wallet-data'
import { ZEC_DECIMALS } from '@/config/wallet'
import { formatBaseUnitAmount } from './number-format'
import type { KeySource } from '@/types'
import type {
  BallotDecision,
  PreparedVotingRound,
  VotingActionResult,
  VotingDiscovery,
  VotingEligibility,
  VotingErrorCode,
  VotingProposal,
  VotingRoundPhase,
  VotingRoundStatus
} from '@/core/worker/types'

export type VotingDisplayStatus = 'active' | 'voted' | 'completed' | 'closed'

const VOTING_PHASES: readonly VotingRoundPhase[] = [
  'uninitialized',
  'config_authenticated',
  'eligible',
  'round_prepared',
  'delegation_pending',
  'delegation_confirmed',
  'vote_pending',
  'vote_confirmed',
  'shares_confirmed',
  'not_eligible',
  'round_rejected',
  'expired'
]
const VOTING_ERROR_CODES: readonly VotingErrorCode[] = [
  'CONFIG_FETCH_FAILED',
  'CONFIG_UNTRUSTED',
  'ROUND_UNAUTHENTICATED',
  'ROUND_EXPIRED',
  'NETWORK_MISMATCH',
  'WALLET_NOT_SYNCED',
  'NOT_ELIGIBLE',
  'PIR_SNAPSHOT_MISMATCH',
  'PROOF_FAILED',
  'PERSISTENCE_FAILED',
  'SUBMISSION_REJECTED',
  'SUBMISSION_UNKNOWN',
  'OPERATION_IN_PROGRESS',
  'RECOVERY_CONFLICT'
]

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`)
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${label}`)
  return value
}

function requiredSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

export function parseVotingDate(value: string): Date {
  const numeric = Number(value)
  const normalized =
    /^\d+$/.test(value) && Number.isSafeInteger(numeric)
      ? numeric < 1_000_000_000_000
        ? numeric * 1000
        : numeric
      : value
  return new Date(normalized)
}

export function supportsVotingKeySource(keySource: KeySource | undefined): boolean {
  return !isZcashHardwareKeySource(keySource)
}

export function getVotingDisplayStatus(
  round: VotingDiscovery['accepted'][number],
  status: VotingRoundStatus | null,
  now = Date.now()
): VotingDisplayStatus {
  if (status?.phase === 'shares_confirmed') return status.totalVotes > 0 ? 'voted' : 'completed'
  if (status?.phase === 'expired' || parseVotingDate(round.endsAt).getTime() <= now) return 'closed'
  return 'active'
}

export function getPopulatedVotingStatuses(
  rounds: ReadonlyArray<{
    round: VotingDiscovery['accepted'][number]
    status: VotingRoundStatus | null
  }>,
  now = Date.now()
): VotingDisplayStatus[] {
  const populated = new Set(
    rounds.map(({ round, status }) => getVotingDisplayStatus(round, status, now))
  )
  return (['active', 'voted', 'completed', 'closed'] as const).filter(status =>
    populated.has(status)
  )
}

export function formatVotingDate(value: string): string {
  const date = parseVotingDate(value)
  if (!Number.isFinite(date.getTime())) return '—'
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short'
  })
}

export function formatVotingZec(valueZats: string | undefined): string {
  if (!valueZats || !/^\d+$/.test(valueZats)) return '—'
  return formatBaseUnitAmount(BigInt(valueZats).toString(), ZEC_DECIMALS)
}

export function votingStatusLabel(status: VotingRoundStatus): string {
  const labels: Record<VotingRoundPhase, string> = {
    uninitialized: 'Checking poll',
    config_authenticated: 'Ready to vote',
    eligible: 'Ready to vote',
    round_prepared: 'Voting power prepared',
    delegation_pending: 'Registering voting power',
    delegation_confirmed: 'Ready to submit vote',
    vote_pending: 'Confirming vote',
    vote_confirmed: 'Finishing vote',
    shares_confirmed: status.totalVotes > 0 ? 'Vote confirmed' : 'No votes submitted',
    not_eligible: 'Not eligible',
    round_rejected: 'Poll unavailable',
    expired: 'Poll ended'
  }
  return labels[status.phase]
}

export function votingErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const code = raw.split(':', 1)[0]
  const messages: Record<string, string> = {
    WALLET_NOT_SYNCED: 'Zcash sync must finish before this vote can continue.',
    SYNC_BUSY: 'Zcash is syncing. Try again when sync finishes.',
    NOT_ELIGIBLE: 'This account is not eligible for the round.',
    ROUND_EXPIRED: 'This voting round has ended.',
    NETWORK_MISMATCH: 'This round belongs to a different Zcash network.',
    CONFIG_FETCH_FAILED: 'Voting information is unavailable. Try again later.',
    CONFIG_UNTRUSTED: 'Voting information failed its authenticity check.',
    ROUND_UNAUTHENTICATED: 'This voting round failed its authenticity check.',
    OPERATION_IN_PROGRESS: 'A voting operation is already in progress.',
    SUBMISSION_UNKNOWN: 'Submission status is unknown. Resume the round to check it.',
    PERSISTENCE_FAILED: 'Voting recovery state could not be saved. Reload the wallet.'
  }
  return messages[code] ?? 'Voting could not continue. Please try again.'
}

export type VotingChoices = Readonly<Record<number, number | 'skip' | undefined>>

type VotingSubmissionRequest = {
  action: 'roundStatus' | 'prepareRound' | 'submitDelegation' | 'submitBallot' | 'resumeRound'
  roundId: string
  decisions?: readonly BallotDecision[]
}

/** Advance only the reviewed ballot; confirmation recovery uses the engine's saved intent. */
export async function advanceVotingBallot(
  roundId: string,
  decisions: readonly BallotDecision[] | null,
  request: (input: VotingSubmissionRequest) => Promise<unknown>,
  onProgress: (message: string) => void
): Promise<VotingRoundStatus> {
  let status = parseVotingRoundStatus(await request({ action: 'roundStatus', roundId }))
  for (let step = 0; step < 3; step++) {
    const phase = status.phase
    if (['shares_confirmed', 'expired', 'not_eligible', 'round_rejected'].includes(phase)) break
    if (
      [
        'uninitialized',
        'config_authenticated',
        'eligible',
        'round_prepared',
        'delegation_confirmed'
      ].includes(phase) &&
      !decisions
    )
      break
    if (['uninitialized', 'config_authenticated', 'eligible'].includes(phase)) {
      onProgress('Preparing voting power…')
      parsePreparedVotingRound(await request({ action: 'prepareRound', roundId }))
    } else {
      const action =
        phase === 'round_prepared' ||
        (phase === 'delegation_pending' && status.nextAction === 'submit_delegation')
          ? 'submitDelegation'
          : phase === 'delegation_confirmed'
            ? 'submitBallot'
            : 'resumeRound'
      onProgress(
        action === 'submitDelegation'
          ? 'Registering voting power…'
          : action === 'submitBallot'
            ? 'Submitting vote…'
            : 'Checking confirmation…'
      )
      parseVotingActionResult(
        await request({
          action,
          roundId,
          ...(action === 'submitBallot' && decisions ? { decisions } : {})
        })
      )
    }
    status = parseVotingRoundStatus(await request({ action: 'roundStatus', roundId }))
    if (
      status.phase === phase ||
      ['delegation_pending', 'vote_pending', 'vote_confirmed'].includes(status.phase)
    )
      break
  }
  return status
}

/** Only explicit, reviewed decisions may become a ballot; an empty ballot casts no vote. */
export function createVotingBallot(
  proposals: readonly VotingProposal[],
  choices: VotingChoices
): BallotDecision[] {
  const decisions = validateVotingDecisions(
    proposals,
    proposals.map(proposal => {
      const choice = choices[proposal.proposalId]
      if (choice === undefined) throw new Error('Choose an option or skip each proposal.')
      return choice === 'skip'
        ? { kind: 'skip', proposalId: proposal.proposalId }
        : { kind: 'choice', proposalId: proposal.proposalId, option: choice }
    })
  )
  if (!decisions.some(decision => decision.kind === 'choice')) {
    throw new Error('Choose an option for at least one proposal.')
  }
  return decisions
}

export function parseVotingDiscovery(value: unknown): VotingDiscovery {
  const input = record(value, 'voting discovery')
  if (!Array.isArray(input.accepted) || !Array.isArray(input.rejected)) {
    throw new Error('Invalid voting discovery')
  }
  const accepted = input.accepted.map(item => {
    const round = record(item, 'voting round')
    return {
      roundId: requiredString(round.roundId, 'round ID'),
      name: requiredString(round.name, 'round name'),
      snapshotHeight: requiredSafeInteger(round.snapshotHeight, 'snapshot height'),
      startsAt: requiredString(round.startsAt, 'round start date'),
      endsAt: requiredString(round.endsAt, 'round end date'),
      proposalCount: requiredSafeInteger(round.proposalCount, 'proposal count')
    }
  })
  const rejected = input.rejected.map(item => {
    const round = record(item, 'rejected voting round')
    const code = requiredString(round.code, 'voting rejection code')
    if (!VOTING_ERROR_CODES.includes(code as VotingErrorCode)) {
      throw new Error('Invalid voting rejection code')
    }
    return {
      roundId: requiredString(round.roundId, 'round ID'),
      code: code as VotingErrorCode,
      message: requiredString(round.message, 'voting rejection message')
    }
  })
  return {
    accepted,
    rejected,
    configFingerprint: requiredString(input.configFingerprint, 'voting config fingerprint')
  }
}

function parsePhase(value: unknown): VotingRoundPhase {
  if (typeof value !== 'string' || !VOTING_PHASES.includes(value as VotingRoundPhase)) {
    throw new Error('Invalid voting phase')
  }
  return value as VotingRoundPhase
}

export function parseVotingEligibility(value: unknown): VotingEligibility {
  const input = record(value, 'voting eligibility')
  const reason = input.reasonCode
  if (
    reason !== null &&
    reason !== 'INSUFFICIENT_SNAPSHOT_VALUE' &&
    reason !== 'INSUFFICIENT_VOTING_POWER'
  ) {
    throw new Error('Invalid voting eligibility reason')
  }
  if (typeof input.eligible !== 'boolean') throw new Error('Invalid voting eligibility')
  return {
    roundId: requiredString(input.roundId, 'round ID'),
    eligible: input.eligible,
    snapshotVotingValueZats: requiredString(input.snapshotVotingValueZats, 'snapshot value'),
    minimumRequiredZats: requiredString(input.minimumRequiredZats, 'minimum voting value'),
    reasonCode: reason,
    selectedValueZats: requiredString(input.selectedValueZats, 'selected value'),
    votingPower: requiredString(input.votingPower, 'voting power'),
    selectedNoteCount: requiredSafeInteger(input.selectedNoteCount, 'selected note count'),
    bundleCount: requiredSafeInteger(input.bundleCount, 'bundle count'),
    trimmedValueZats: requiredString(input.trimmedValueZats, 'trimmed voting value')
  }
}

export function parseVotingRoundStatus(value: unknown): VotingRoundStatus {
  const input = record(value, 'voting status')
  return {
    roundId: requiredString(input.roundId, 'round ID'),
    phase: parsePhase(input.phase),
    completedBundles: requiredSafeInteger(input.completedBundles, 'completed bundle count'),
    totalBundles: requiredSafeInteger(input.totalBundles, 'total bundle count'),
    nextAction: requiredString(input.nextAction, 'next voting action'),
    confirmedVotes: requiredSafeInteger(input.confirmedVotes, 'confirmed vote count'),
    totalVotes: requiredSafeInteger(input.totalVotes, 'total vote count'),
    confirmedHelpers: requiredSafeInteger(input.confirmedHelpers, 'confirmed helper count'),
    requiredHelpers: requiredSafeInteger(input.requiredHelpers, 'required helper count')
  }
}

export function parsePreparedVotingRound(value: unknown): PreparedVotingRound {
  const input = record(value, 'prepared voting round')
  return {
    roundId: requiredString(input.roundId, 'round ID'),
    bundleCount: requiredSafeInteger(input.bundleCount, 'bundle count'),
    selectedNoteCount: requiredSafeInteger(input.selectedNoteCount, 'selected note count'),
    votingPower: requiredString(input.votingPower, 'voting power'),
    state: parsePhase(input.state)
  }
}

export function parseVotingProposals(value: unknown): VotingProposal[] {
  if (!Array.isArray(value)) throw new Error('Invalid voting proposals')
  return value.map(item => {
    const input = record(item, 'voting proposal')
    if (!Array.isArray(input.options)) throw new Error('Invalid voting proposal options')
    return {
      proposalId: requiredSafeInteger(input.proposalId, 'proposal ID'),
      title: requiredString(input.title, 'proposal title'),
      options: input.options.map(option => requiredString(option, 'proposal option'))
    }
  })
}

export function parseVotingActionResult(value: unknown): VotingActionResult {
  const input = record(value, 'voting action result')
  return {
    roundId: requiredString(input.roundId, 'round ID'),
    phase: parsePhase(input.phase),
    completedBundles: requiredSafeInteger(input.completedBundles, 'completed bundle count'),
    totalBundles: requiredSafeInteger(input.totalBundles, 'total bundle count'),
    nextAction: requiredString(input.nextAction, 'next voting action')
  }
}

export function validateVotingDecisions(
  proposals: readonly VotingProposal[],
  value: unknown
): BallotDecision[] {
  if (!Array.isArray(value) || value.length !== proposals.length) {
    throw new Error('Each proposal requires one voting decision')
  }
  const byProposal = new Map(proposals.map(proposal => [proposal.proposalId, proposal]))
  const decisions = value.map(item => {
    const input = record(item, 'voting decision')
    const proposalId = requiredSafeInteger(input.proposalId, 'voting proposal ID')
    const proposal = byProposal.get(proposalId)
    if (!proposal) throw new Error('Voting decision references an unknown proposal')
    byProposal.delete(proposalId)
    if (input.kind === 'skip' && Object.keys(input).length === 2) {
      return { kind: 'skip' as const, proposalId }
    }
    if (
      input.kind === 'choice' &&
      Object.keys(input).length === 3 &&
      typeof input.option === 'number' &&
      Number.isSafeInteger(input.option) &&
      input.option >= 0 &&
      input.option < proposal.options.length
    ) {
      return { kind: 'choice' as const, proposalId, option: input.option }
    }
    throw new Error('Voting decision is invalid')
  })
  if (byProposal.size > 0) throw new Error('Each proposal requires one voting decision')
  return decisions
}
