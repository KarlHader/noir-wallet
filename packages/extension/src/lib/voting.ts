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

export type VotingDisplayStatus = 'active' | 'voted' | 'closed'

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
  if (status?.phase === 'shares_confirmed') return 'voted'
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
  return (['active', 'voted', 'closed'] as const).filter(status => populated.has(status))
}

export function canResumeVoting(status: VotingRoundStatus | null): boolean {
  return (
    !!status &&
    [
      'round_prepared',
      'delegation_pending',
      'delegation_confirmed',
      'vote_pending',
      'vote_confirmed'
    ].includes(status.phase)
  )
}

export function formatVotingPower(value: string | undefined): string {
  if (!value) return '-'
  if (/^\d+$/.test(value)) return BigInt(value).toLocaleString('en-US')
  const parsed = Number(value)
  return Number.isFinite(parsed) ? new Intl.NumberFormat('en-US').format(parsed) : value
}

export function formatVotingZec(valueZats: string | undefined): string {
  if (!valueZats || !/^\d+$/.test(valueZats)) return '-'
  return formatBaseUnitAmount(BigInt(valueZats).toString(), ZEC_DECIMALS)
}

export function votingProgress(result: VotingActionResult): number {
  if (result.totalBundles <= 0) return result.phase === 'shares_confirmed' ? 100 : 0
  return Math.min(100, Math.round((result.completedBundles / result.totalBundles) * 100))
}

export function votingErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const code = raw.split(':', 1)[0]
  const messages: Record<string, string> = {
    WALLET_NOT_SYNCED: 'Zcash sync must finish before this vote can continue.',
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
  return messages[code] ?? raw
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
