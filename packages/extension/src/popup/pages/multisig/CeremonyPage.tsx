import { useEffect } from 'react'
import type { CreateSessionState } from '@/core/multisig/create-session'
import type { SessionPhase } from '@/core/multisig/types'
import { CeremonyRow, type CeremonyRowStatus } from '@/popup/components/multisig/CeremonyRow'
import { CEREMONY_ROUTE, createFlowRoute } from '@/popup/multisig/create-flow-routes'
import { useCreateSessionStore } from '@/popup/multisig/create-session-store'
import { useNavigate } from '@/popup/provider/Router'
import { MultisigTabLayout } from './MultisigTabLayout'

interface CeremonyRowView {
  label: string
  status: CeremonyRowStatus
  progress?: number
  detail?: string
}

// Long enough to see every row done before the verify page takes over.
const CEREMONY_DONE_HOLD_MS = 1000

// The ceremony phases in the order a session moves through them.
const PHASE_ORDER: readonly SessionPhase[] = [
  'CREATED',
  'PAIRING',
  'ROSTER_LOCKED',
  'DKG_R1',
  'R1_VERIFIED',
  'DKG_R2',
  'FINALIZED',
  'KEYSET_VERIFIED',
  'ACTIVATED'
]

function isPast(phase: SessionPhase, than: SessionPhase): boolean {
  const index = PHASE_ORDER.indexOf(phase)
  return index !== -1 && index > PHASE_ORDER.indexOf(than)
}

function roundRow(label: string, received: number, total: number, done: boolean): CeremonyRowView {
  if (done) return { label, status: 'done' }
  return {
    label,
    status: 'progress',
    detail: `${received}/${total}`,
    progress: total > 0 ? (received / total) * 100 : 0
  }
}

/**
 * A round is done once every phone has sent its part and the session has moved on: over
 * Bluetooth round 1 stays open after the last package until every phone echoes the bundle.
 */
function ceremonyRows(session: CreateSessionState): readonly CeremonyRowView[] {
  const guardians = session.devices.filter(entry => entry.slot !== 1)
  const total = guardians.length
  const r1 = guardians.filter(entry => entry.r1Received).length
  const r2 = guardians.filter(entry => entry.r2Received).length
  const r1Done = r1 === total && isPast(session.phase, 'DKG_R1')
  const r2Done = r2 === total && isPast(session.phase, 'DKG_R2')
  const finalized = session.phase === 'FINALIZED' || isPast(session.phase, 'FINALIZED')

  return [
    roundRow('Public Commitments', r1, total, r1Done),
    r1Done
      ? roundRow('Encrypted Contributions', r2, total, r2Done)
      : { label: 'Encrypted Contributions', status: 'awaiting' },
    { label: 'Finalize', status: finalized ? 'done' : 'awaiting' }
  ]
}

/** Step 3 over Bluetooth: the phones and the extension run the key ceremony on their own. */
export function CeremonyPage() {
  const { replace } = useNavigate()
  const session = useCreateSessionStore(state => state.session)

  // The final check (KEYSET_VERIFIED) and a QR session both belong to other pages.
  const target = session ? createFlowRoute(session) : null
  // Over Bluetooth the last round-2 batch takes the session straight to KEYSET_VERIFIED, so
  // without a pause the last two rows would never be seen as done.
  const ceremonyDone = session?.transportKind === 'ble' && isPast(session.phase, 'FINALIZED')
  useEffect(() => {
    if (target === null || target === CEREMONY_ROUTE) return
    if (!ceremonyDone) {
      replace(target)
      return
    }
    const timer = window.setTimeout(() => replace(target), CEREMONY_DONE_HOLD_MS)
    return () => window.clearTimeout(timer)
  }, [target, ceremonyDone, replace])

  // The route guard already redirects when the session is missing or aborted.
  if (!session) return null

  return (
    <MultisigTabLayout step={3} title="Multisig" showBack={false}>
      <h2 className="text-lg font-semibold">Key ceremony</h2>
      <p className="mt-2 text-xs text-muted">
        All devices compute locally. Keep your phones nearby.
      </p>
      <div className="mt-4 space-y-3">
        {ceremonyRows(session).map(row => (
          <CeremonyRow
            key={row.label}
            label={row.label}
            status={row.status}
            progress={row.progress}
            detail={row.detail}
          />
        ))}
      </div>
    </MultisigTabLayout>
  )
}
