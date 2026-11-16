import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from '@iconify/react'
import { useLocation } from 'react-router-dom'
import { Button } from '@/popup/components/ui/button'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { useNavigate } from '@/popup/provider/Router'
import { zcashWalletRuntimeClient } from '@/popup/services/zcash-wallet-runtime-client'
import {
  canResumeVoting,
  formatVotingPower,
  parsePreparedVotingRound,
  parseVotingActionResult,
  parseVotingEligibility,
  parseVotingProposals,
  parseVotingRoundStatus,
  validateVotingDecisions,
  votingErrorMessage,
  votingProgress
} from '@/lib/voting'
import type { VotingEligibility, VotingProposal, VotingRoundStatus } from '@/core/worker/types'

export function VotingRound() {
  const location = useLocation()
  const { navigate } = useNavigate()
  const roundId = useMemo(
    () => new URLSearchParams(location.search).get('roundId'),
    [location.search]
  )
  const [proposals, setProposals] = useState<VotingProposal[]>([])
  const [eligibility, setEligibility] = useState<VotingEligibility | null>(null)
  const [status, setStatus] = useState<VotingRoundStatus | null>(null)
  const [choices, setChoices] = useState<Record<number, number | null>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!roundId) return
    setLoading(true)
    setError(null)
    try {
      const [eligibilityRaw, statusRaw, proposalsRaw] = await Promise.all([
        zcashWalletRuntimeClient.voting<unknown>({ action: 'checkEligibility', roundId }),
        zcashWalletRuntimeClient.voting<unknown>({ action: 'roundStatus', roundId }),
        zcashWalletRuntimeClient.voting<unknown>({ action: 'roundProposals', roundId })
      ])
      setEligibility(parseVotingEligibility(eligibilityRaw))
      setStatus(parseVotingRoundStatus(statusRaw))
      const parsedProposals = parseVotingProposals(proposalsRaw)
      setProposals(parsedProposals)
      setChoices(current => {
        const next = { ...current }
        for (const proposal of parsedProposals) next[proposal.proposalId] ??= null
        return next
      })
    } catch (cause) {
      setError(votingErrorMessage(cause))
    } finally {
      setLoading(false)
    }
  }, [roundId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const perform = async (action: string) => {
    if (!roundId) return
    setLoading(true)
    setError(null)
    try {
      let result: unknown
      if (action === 'prepare') {
        result = await zcashWalletRuntimeClient.voting<unknown>({ action: 'prepareRound', roundId })
        parsePreparedVotingRound(result)
      } else if (action === 'delegate') {
        result = await zcashWalletRuntimeClient.voting<unknown>({
          action: 'submitDelegation',
          roundId
        })
      } else if (action === 'ballot') {
        const decisions = validateVotingDecisions(
          proposals,
          proposals.map(proposal =>
            choices[proposal.proposalId] === null || choices[proposal.proposalId] === undefined
              ? { kind: 'skip', proposalId: proposal.proposalId }
              : {
                  kind: 'choice',
                  proposalId: proposal.proposalId,
                  option: choices[proposal.proposalId] as number
                }
          )
        )
        result = await zcashWalletRuntimeClient.voting<unknown>({
          action: 'submitBallot',
          roundId,
          decisions
        })
      } else {
        result = await zcashWalletRuntimeClient.voting<unknown>({ action: 'resumeRound', roundId })
      }
      const actionResult = parseVotingActionResult(result)
      setStatus(current => (current ? { ...current, ...actionResult } : null))
      await refresh()
    } catch (cause) {
      setError(votingErrorMessage(cause))
    } finally {
      setLoading(false)
    }
  }

  if (!roundId) {
    return (
      <div className="page-container">
        <PageHeader title="Voting round" showBack />
        <div className="page-content">
          <p role="alert">Voting round is unavailable.</p>
        </div>
      </div>
    )
  }

  const phase = status?.phase
  const isComplete = phase === 'shares_confirmed'
  const pending = status
    ? ['delegation_pending', 'vote_pending', 'vote_confirmed'].includes(status.phase)
    : false
  const primaryAction =
    phase === 'round_prepared'
      ? { label: 'Submit delegation', action: 'delegate' }
      : phase === 'delegation_confirmed'
        ? { label: 'Submit ballot', action: 'ballot' }
        : canResumeVoting(status)
          ? { label: 'Resume voting', action: 'resume' }
          : eligibility?.eligible && !isComplete
            ? { label: 'Prepare round', action: 'prepare' }
            : null

  return (
    <div className="page-container">
      <PageHeader title="Voting round" showBack />
      <div className="page-content space-y-4">
        <div className="flex items-center justify-between gap-3">
          <span className="truncate font-mono text-xs text-muted">{roundId}</span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh round"
            onClick={refresh}
            disabled={loading}
          >
            <Icon
              icon="lucide:refresh-cw"
              width={16}
              height={16}
              className={loading ? 'animate-spin' : ''}
            />
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {eligibility && (
          <section className="rounded-lg border border-border p-3">
            <div className="flex justify-between text-sm">
              <span>Eligibility</span>
              <strong>{eligibility.eligible ? 'Eligible' : 'Not eligible'}</strong>
            </div>
            <div className="mt-2 flex justify-between text-xs text-muted">
              <span>Voting power</span>
              <span>{formatVotingPower(eligibility.votingPower)}</span>
            </div>
            <div className="mt-1 flex justify-between text-xs text-muted">
              <span>Selected notes</span>
              <span>{eligibility.selectedNoteCount}</span>
            </div>
          </section>
        )}
        {status && (
          <section className="rounded-lg border border-border p-3">
            <div className="flex justify-between text-sm">
              <span>Status</span>
              <strong className="capitalize">{status.phase.replace(/_/g, ' ')}</strong>
            </div>
            {status.totalBundles > 0 && (
              <div className="mt-2 text-xs text-muted">
                Bundle progress: {status.completedBundles}/{status.totalBundles}
              </div>
            )}
            {pending && (
              <p className="mt-2 text-xs text-muted">
                {status.confirmedVotes}/{status.totalVotes} votes confirmed ·{' '}
                {status.confirmedHelpers}/{status.requiredHelpers} helpers
              </p>
            )}
          </section>
        )}
        {phase === 'delegation_confirmed' &&
          proposals.map(proposal => (
            <label key={proposal.proposalId} className="block rounded-lg border border-border p-3">
              <span className="text-sm font-medium">{proposal.title}</span>
              <select
                className="mt-2 h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
                value={choices[proposal.proposalId] ?? ''}
                onChange={event =>
                  setChoices(current => ({
                    ...current,
                    [proposal.proposalId]:
                      event.target.value === '' ? null : Number(event.target.value)
                  }))
                }
              >
                <option value="">Skip</option>
                {proposal.options.map((option, index) => (
                  <option key={`${proposal.proposalId}-${index}`} value={index}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
          ))}
        {status && <div className="text-xs text-muted">{votingProgress(status)}% complete</div>}
        <div className="flex gap-2">
          {primaryAction && (
            <Button
              className="flex-1"
              onClick={() => void perform(primaryAction.action)}
              disabled={loading || (primaryAction.action === 'ballot' && proposals.length === 0)}
            >
              {loading ? 'Working…' : primaryAction.label}
            </Button>
          )}
          {isComplete && <p className="py-2 text-sm text-primary">Ballot confirmed</p>}
          <Button variant="outline" onClick={() => navigate('/voting')}>
            Rounds
          </Button>
        </div>
      </div>
    </div>
  )
}
