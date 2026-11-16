import { useCallback, useEffect, useState } from 'react'
import { Icon } from '@iconify/react'
import { Button } from '@/popup/components/ui/button'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { ListSkeleton } from '@/popup/components/ui/skeleton'
import { useNavigate } from '@/popup/provider/Router'
import { zcashWalletRuntimeClient } from '@/popup/services/zcash-wallet-runtime-client'
import {
  getVotingDisplayStatus,
  parseVotingDiscovery,
  parseVotingRoundStatus,
  votingErrorMessage
} from '@/lib/voting'
import type { VotingDiscovery, VotingRoundStatus } from '@/core/worker/types'

export function VotingRounds() {
  const { navigate } = useNavigate()
  const [discovery, setDiscovery] = useState<VotingDiscovery | null>(null)
  const [statuses, setStatuses] = useState<Record<string, VotingRoundStatus | null>>({})
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const raw = await zcashWalletRuntimeClient.voting<unknown>({ action: 'discoverRounds' })
      const result = parseVotingDiscovery(raw)
      const entries = await Promise.all(
        result.accepted.map(async round => {
          try {
            const value = await zcashWalletRuntimeClient.voting<unknown>({
              action: 'roundStatus',
              roundId: round.roundId
            })
            return [round.roundId, parseVotingRoundStatus(value)] as const
          } catch {
            return [round.roundId, null] as const
          }
        })
      )
      setDiscovery(result)
      setStatuses(Object.fromEntries(entries))
    } catch (cause) {
      setError(votingErrorMessage(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div className="page-container">
      <PageHeader
        title="Zcash voting"
        showBack
        rightContent={
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh voting rounds"
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
        }
      />
      <div className="page-content space-y-3">
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {loading && !discovery && <ListSkeleton rows={3} label="Loading voting rounds" card />}
        {discovery?.accepted.length === 0 && (
          <p className="text-sm text-muted">No voting rounds are available.</p>
        )}
        {discovery?.accepted.map(round => {
          const status = statuses[round.roundId] ?? null
          const displayStatus = getVotingDisplayStatus(round, status)
          return (
            <button
              key={round.roundId}
              type="button"
              onClick={() => navigate(`/voting/round?roundId=${encodeURIComponent(round.roundId)}`)}
              className="w-full rounded-lg border border-border bg-card px-4 py-3 text-left hover:border-primary/60"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="min-w-0 text-sm font-medium">{round.name}</span>
                <span className="shrink-0 text-xs capitalize text-muted">{displayStatus}</span>
              </div>
              <div className="mt-2 flex justify-between gap-3 text-xs text-muted">
                <span>{round.proposalCount} proposals</span>
                <span>Ends {new Date(round.endsAt).toLocaleDateString()}</span>
              </div>
            </button>
          )
        })}
        {discovery?.rejected.map(round => (
          <div key={round.roundId} className="rounded-lg border border-border px-4 py-3">
            <div className="text-sm font-medium">{round.roundId}</div>
            <p className="mt-1 text-xs text-muted">{round.message}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
