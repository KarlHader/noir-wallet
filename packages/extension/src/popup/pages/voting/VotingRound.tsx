import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { useLocation } from 'react-router-dom'
import { Button } from '@/popup/components/ui/button'
import { ListSkeleton } from '@/popup/components/ui/skeleton'
import { InlineError } from '@/popup/components/common/InlineError'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { useWalletStore } from '@/store/wallet-store'
import { zcashWalletRuntimeClient } from '@/popup/services/zcash-wallet-runtime-client'
import { cn } from '@/lib/utils'
import {
  advanceVotingBallot,
  createVotingBallot,
  formatVotingDate,
  formatVotingZec,
  parseVotingDiscovery,
  parseVotingEligibility,
  parseVotingProposals,
  parseVotingRoundStatus,
  parseVotingDate,
  votingErrorMessage,
  votingStatusLabel,
  type VotingChoices
} from '@/lib/voting'
import type {
  BallotDecision,
  VotingDiscovery,
  VotingEligibility,
  VotingProposal,
  VotingRoundStatus
} from '@/core/worker/types'

export function VotingRound() {
  const location = useLocation()
  const roundId = new URLSearchParams(location.search).get('roundId')
  const walletId = useWalletStore(state => state.currentWalletId)
  const accountId = useWalletStore(state => state.currentAccountId)
  const network = useWalletStore(state => state.currentNetwork)
  if (!roundId || !walletId || !accountId) {
    return (
      <div className="page-container">
        <PageHeader title="Coinholder poll" showBack />
        <div className="page-content">
          <InlineError message="Voting round is unavailable." />
        </div>
      </div>
    )
  }
  return (
    <VotingRoundContent
      key={`${network}:${walletId}:${accountId}:${roundId}`}
      roundId={roundId}
      walletId={walletId}
      accountId={accountId}
    />
  )
}

function VotingRoundContent({
  roundId,
  walletId,
  accountId
}: {
  roundId: string
  walletId: string
  accountId: string
}) {
  const scope = { walletId, accountId }
  const [round, setRound] = useState<VotingDiscovery['accepted'][number] | null>(null)
  const [proposals, setProposals] = useState<VotingProposal[]>([])
  const [eligibility, setEligibility] = useState<VotingEligibility | null>(null)
  const [status, setStatus] = useState<VotingRoundStatus | null>(null)
  const [choices, setChoices] = useState<VotingChoices>({})
  const [review, setReview] = useState<BallotDecision[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [eligibilityError, setEligibilityError] = useState<string | null>(null)
  const sequence = useRef(0)
  const mounted = useRef(true)
  const submitting = useRef(false)
  const roster = useRef('')
  const content = useRef<HTMLDivElement>(null)

  useEffect(() => {
    content.current?.scrollTo({ top: 0 })
  }, [review !== null])

  const refresh = useCallback(async () => {
    const request = ++sequence.current
    const current = () => mounted.current && request === sequence.current
    setLoading(true)
    setError(null)
    setEligibilityError(null)
    try {
      const discovery = parseVotingDiscovery(
        await zcashWalletRuntimeClient.voting<unknown>({
          walletId,
          accountId,
          action: 'discoverRounds'
        })
      )
      if (!current()) return
      const authenticated = discovery.accepted.find(candidate => candidate.roundId === roundId)
      if (!authenticated) throw new Error('ROUND_UNAUTHENTICATED')
      setRound(authenticated)
      // Public proposals remain readable even when this account is still syncing.
      await Promise.all([
        (async () => {
          const parsed = parseVotingProposals(
            await zcashWalletRuntimeClient.voting<unknown>({
              walletId,
              accountId,
              action: 'roundProposals',
              roundId
            })
          )
          if (!current()) return
          const fingerprint = JSON.stringify(parsed)
          if (roster.current && roster.current !== fingerprint) {
            setChoices({})
            setReview(null)
          }
          roster.current = fingerprint
          setProposals(parsed)
        })().catch(cause => {
          if (current()) setError(votingErrorMessage(cause))
        }),
        (async () => {
          const parsed = parseVotingRoundStatus(
            await zcashWalletRuntimeClient.voting<unknown>({
              walletId,
              accountId,
              action: 'roundStatus',
              roundId
            })
          )
          if (current()) setStatus(parsed)
        })().catch(cause => {
          if (current()) {
            setStatus(null)
            setError(votingErrorMessage(cause))
          }
        }),
        (async () => {
          const parsed = parseVotingEligibility(
            await zcashWalletRuntimeClient.voting<unknown>({
              walletId,
              accountId,
              action: 'checkEligibility',
              roundId
            })
          )
          if (current()) setEligibility(parsed)
        })().catch(cause => {
          if (current()) {
            setEligibility(null)
            setEligibilityError(votingErrorMessage(cause))
          }
        })
      ])
    } catch (cause) {
      if (current()) {
        setError(votingErrorMessage(cause))
        setRound(null)
        setStatus(null)
      }
    } finally {
      if (current()) setLoading(false)
    }
  }, [walletId, accountId, roundId])

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
      sequence.current++
    }
  }, [refresh])

  const perform = async () => {
    if (submitting.current) return
    submitting.current = true
    setWorking('Checking vote…')
    setError(null)
    try {
      const next = await advanceVotingBallot(
        roundId,
        review,
        input => {
          if (!mounted.current) return Promise.reject(new Error('Voting page closed'))
          return zcashWalletRuntimeClient.voting<unknown>({ ...scope, ...input })
        },
        message => {
          if (mounted.current) setWorking(message)
        }
      )
      if (mounted.current) setStatus(next)
      if (mounted.current) await refresh()
    } catch (cause) {
      if (mounted.current) setError(votingErrorMessage(cause))
    } finally {
      submitting.current = false
      if (mounted.current) setWorking(null)
    }
  }

  const phase = status?.phase
  const complete = phase === 'shares_confirmed'
  const submitted = complete || phase === 'vote_pending' || phase === 'vote_confirmed'
  const closed =
    phase === 'expired' || (round !== null && parseVotingDate(round.endsAt).getTime() <= Date.now())
  const recovering =
    phase === 'delegation_pending' || phase === 'vote_pending' || phase === 'vote_confirmed'
  const busy = loading || working !== null
  const canChoose = !!round && !!status && !!eligibility?.eligible && !submitted && !closed
  const answered = proposals.filter(proposal => choices[proposal.proposalId] !== undefined).length
  const selected = proposals.filter(
    proposal => typeof choices[proposal.proposalId] === 'number'
  ).length
  const canReview = proposals.length > 0 && answered === proposals.length && selected > 0
  const reviewing = review !== null && !submitted

  return (
    <div className="page-container">
      <PageHeader
        title={reviewing ? 'Review vote' : 'Coinholder poll'}
        showBack
        backDisabled={working !== null}
        onBack={
          reviewing
            ? () => {
                if (!busy) setReview(null)
              }
            : undefined
        }
        rightContent={
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh round"
            onClick={refresh}
            disabled={busy || reviewing}
          >
            <Icon
              icon="lucide:refresh-cw"
              width={16}
              height={16}
              className={loading ? 'animate-spin' : ''}
            />
          </Button>
        }
      />
      <div ref={content} className="page-content space-y-4">
        {error && <InlineError message={error} onRetry={refresh} retrying={busy} />}
        {loading && !round && <ListSkeleton rows={3} label="Loading poll" card />}
        {round && (
          <>
            <section className="space-y-2">
              <h2 className="text-lg font-medium">{round.name}</h2>
              <p className="text-xs text-muted">
                {closed ? 'Ended' : 'Ends'} {formatVotingDate(round.endsAt)}
              </p>
              <div className="flex items-center justify-between gap-3 text-xs text-muted">
                <span>Snapshot block {round.snapshotHeight.toLocaleString('en-US')}</span>
                <a
                  className="inline-flex shrink-0 items-center gap-1 text-primary hover:underline"
                  href={`https://zecblock.com/governance/${encodeURIComponent(round.roundId)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Poll details
                  <Icon icon="lucide:external-link" width={12} />
                </a>
              </div>
            </section>
            <section className="space-y-2 rounded-xl bg-card p-3 text-sm">
              {eligibility ? (
                <>
                  <div className="flex justify-between gap-3">
                    <span className="text-muted">Voting power</span>
                    <strong className="break-all text-right">
                      {formatVotingZec(eligibility.votingPower)} ZEC
                    </strong>
                  </div>
                  <div className="flex justify-between gap-3 text-xs">
                    <span className="text-muted">Balance at snapshot</span>
                    <span className="break-all text-right">
                      {formatVotingZec(eligibility.snapshotVotingValueZats)} ZEC
                    </span>
                  </div>
                  {!eligibility.eligible && (
                    <p className="text-xs text-warning">
                      {eligibility.reasonCode === 'INSUFFICIENT_SNAPSHOT_VALUE'
                        ? 'Balance at snapshot'
                        : 'Voting power'}{' '}
                      is below {formatVotingZec(eligibility.minimumRequiredZats)} ZEC.
                    </p>
                  )}
                </>
              ) : eligibilityError ? (
                <InlineError message={eligibilityError} onRetry={refresh} retrying={busy} />
              ) : (
                <span className="text-muted">Checking voting power…</span>
              )}
            </section>
            {status &&
              (submitted ||
                recovering ||
                phase === 'round_prepared' ||
                phase === 'delegation_confirmed') && (
                <section
                  className="space-y-2 rounded-xl border border-border p-3"
                  aria-live="polite"
                >
                  <div className={cn('text-sm font-medium', complete && 'text-primary')}>
                    {votingStatusLabel(status)}
                  </div>
                  {(phase === 'delegation_pending' || phase === 'round_prepared') &&
                    status.totalBundles > 0 && (
                      <p className="text-xs text-muted">
                        Voting power registered: {status.completedBundles}/{status.totalBundles}
                      </p>
                    )}
                  {submitted && status.totalVotes > 0 && (
                    <p className="text-xs text-muted">
                      Votes confirmed: {status.confirmedVotes}/{status.totalVotes}
                    </p>
                  )}
                  {phase === 'vote_confirmed' && status.requiredHelpers > 0 && (
                    <p className="text-xs text-muted">
                      Final confirmations: {status.confirmedHelpers}/{status.requiredHelpers}
                    </p>
                  )}
                </section>
              )}
            <div className="flex items-center justify-between gap-2 text-sm">
              <h3 className="font-medium">{proposals.length || round.proposalCount} proposals</h3>
              {canChoose && !reviewing && (
                <span className="text-xs text-muted">
                  {answered}/{proposals.length} answered
                </span>
              )}
            </div>
            {proposals.map((proposal, index) => {
              const decision = review?.find(item => item.proposalId === proposal.proposalId)
              return (
                <section
                  key={proposal.proposalId}
                  className="space-y-3 rounded-xl border border-border p-3"
                >
                  <h4 className="text-sm font-medium leading-5">
                    <span className="mr-2 text-muted">{index + 1}.</span>
                    {proposal.title}
                  </h4>
                  {decision && reviewing ? (
                    <p
                      className={cn(
                        'text-sm',
                        decision.kind === 'choice' ? 'text-primary' : 'text-muted'
                      )}
                    >
                      {decision.kind === 'skip' ? 'Skipped' : proposal.options[decision.option]}
                    </p>
                  ) : canChoose && !reviewing ? (
                    <div role="radiogroup" aria-label={proposal.title} className="space-y-2">
                      <div
                        className={cn(
                          'grid gap-2',
                          proposal.options.length <= 3 ? 'grid-cols-3' : 'grid-cols-1'
                        )}
                      >
                        {proposal.options.map((option, optionIndex) => (
                          <button
                            key={optionIndex}
                            type="button"
                            role="radio"
                            aria-checked={choices[proposal.proposalId] === optionIndex}
                            disabled={busy}
                            onClick={() =>
                              setChoices(current => ({
                                ...current,
                                [proposal.proposalId]: optionIndex
                              }))
                            }
                            className={cn(
                              'flex min-h-9 items-center justify-center gap-1 rounded-lg border border-border px-2 py-2 text-xs hover:bg-card focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50',
                              choices[proposal.proposalId] === optionIndex &&
                                'border-primary bg-primary/10 text-primary'
                            )}
                          >
                            {choices[proposal.proposalId] === optionIndex && (
                              <Icon icon="lucide:check" width={12} className="shrink-0" />
                            )}
                            {option}
                          </button>
                        ))}
                      </div>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={choices[proposal.proposalId] === 'skip'}
                        disabled={busy}
                        onClick={() =>
                          setChoices(current => ({ ...current, [proposal.proposalId]: 'skip' }))
                        }
                        className="inline-flex items-center gap-1 py-1 text-xs text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
                      >
                        {choices[proposal.proposalId] === 'skip' && (
                          <Icon icon="lucide:check" width={12} />
                        )}
                        Skip this proposal
                      </button>
                    </div>
                  ) : (
                    !submitted && (
                      <p className="text-xs text-muted">{proposal.options.join(' · ')}</p>
                    )
                  )}
                </section>
              )
            })}
            {canChoose &&
              !reviewing &&
              proposals.length > 0 &&
              answered === proposals.length &&
              selected === 0 && (
                <p role="status" className="text-xs text-warning">
                  Choose an option for at least one proposal.
                </p>
              )}
          </>
        )}
      </div>
      {(canChoose || recovering) && !complete && !closed && (
        <div className="page-footer">
          {reviewing || recovering ? (
            <Button
              className="w-full"
              onClick={() => void perform()}
              disabled={busy || !status || (!review && !recovering)}
            >
              {working ?? (recovering ? 'Continue voting' : 'Submit vote')}
            </Button>
          ) : (
            <Button
              className="w-full"
              disabled={busy || !canReview}
              onClick={() => setReview(createVotingBallot(proposals, choices))}
            >
              Review vote
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
