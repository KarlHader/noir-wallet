import { useEffect } from 'react'
import { Icon } from '@iconify/react'
import { verifyPageDevices, type CreateSessionState } from '@/core/multisig/create-session'
import { formatFingerprint } from '@/core/multisig/fingerprint'
import { DeviceCard, type DeviceCardStatus } from '@/popup/components/multisig/DeviceCard'
import { FingerprintBlock } from '@/popup/components/multisig/FingerprintBlock'
import { Button } from '@/popup/components/ui/button'
import { FlowButton } from '@/popup/components/multisig/FlowButton'
import { useDialog } from '@/popup/hooks/useDialog'
import {
  createdTeamRoute,
  createFlowRoute,
  parseVerifyStage,
  verifyRoute,
  type FingerprintStage
} from '@/popup/multisig/create-flow-routes'
import { useCreateSessionStore } from '@/popup/multisig/create-session-store'
import { useLocation, useNavigate } from '@/popup/provider/Router'
import { MultisigTabLayout } from './MultisigTabLayout'

interface StageCopy {
  title: string
  description: string
}

const STAGE_COPY: Readonly<Record<FingerprintStage, StageCopy>> = {
  roster: {
    title: 'Verify the roster',
    description:
      'Put both phones side by side. All three screens must show the same roster fingerprint.'
  },
  r1: {
    title: 'Verify round 1',
    description:
      'Put both phones side by side. All three screens must show the same value before continuing.'
  },
  final: {
    title: 'Verify the group',
    description: 'Every device must show the same value. Confirm on each phone, then scan its code.'
  }
}
// Bluetooth phones report their match themselves, so there is no code to scan afterwards.
const BLE_FINAL_DESCRIPTION = 'Every device must show the same value.'

function stageFingerprint(session: CreateSessionState, stage: FingerprintStage): string | null {
  if (stage === 'roster') return session.roster?.rosterHash ?? null
  if (stage === 'r1') return session.r1Fingerprint
  return session.finalFingerprint
}

/**
 * Step 3, the fingerprint check: `/multisig/create/verify?stage=roster|r1|final`. `roster` and
 * `r1` are the QR checks of a three-device group; `final` ends every setup. There is no back
 * arrow: the roster is locked, and leaving means aborting the session.
 */
export function VerifyPage() {
  const { search } = useLocation()
  const { replace } = useNavigate()
  const { confirm } = useDialog()
  const session = useCreateSessionStore(state => state.session)
  const scope = useCreateSessionStore(state => state.scope)
  const dispatch = useCreateSessionStore(state => state.dispatch)
  const stage = parseVerifyStage(new URLSearchParams(search).get('stage'))

  const activated = session?.phase === 'ACTIVATED'
  const target = session && !activated ? createFlowRoute(session) : null
  const here = verifyRoute(stage)

  useEffect(() => {
    if (activated) {
      // The store has saved the group already, so the team page can show it at once. Without a
      // scope there is no account to show it for.
      if (scope) replace(createdTeamRoute(scope))
      else window.close()
      return
    }
    // A confirmed QR check moves on to the next QR step (after the final one, the scan of each
    // phone's confirmation); a final check opened before the ceremony finished goes back to it.
    if (target !== null && target !== here) replace(target)
  }, [activated, scope, target, here, replace])

  // The route guard already redirects when the session is missing or aborted.
  if (!session) return null

  const devices = verifyPageDevices(session)
  // Only Bluetooth phones can report their match; over QR each phone checks on its own screen.
  const isBle = session.transportKind === 'ble'
  const waitingForDevices =
    isBle &&
    stage === 'final' &&
    session.ownerConfirmed.final &&
    !devices.every(entry => entry.confirmed)
  const fingerprint = stageFingerprint(session, stage)
  const copy = STAGE_COPY[stage]
  const description = isBle && stage === 'final' ? BLE_FINAL_DESCRIPTION : copy.description
  // The roster check has no flag of its own: confirming it moves the session straight on.
  const ownerConfirmed = stage === 'roster' ? false : session.ownerConfirmed[stage]

  // A phone's final confirmation arrives over Bluetooth or, over QR, from its scanned code; the
  // earlier QR checks happen on each phone's own screen.
  const deviceStatus = (confirmed: boolean): DeviceCardStatus => {
    if (!isBle && stage !== 'final') return 'connected'
    return confirmed ? 'confirmed' : 'waiting'
  }

  const handleReject = async () => {
    const confirmed = await confirm({
      title: 'Fingerprints differ?',
      message: 'Setup will be cancelled and must start over.',
      confirmText: 'Cancel setup',
      variant: 'danger'
    })
    if (!confirmed) return
    // The route guard sends the aborted session to the failed page.
    dispatch({ type: 'FINGERPRINT_REJECTED', stage })
  }

  return (
    <MultisigTabLayout
      step={3}
      title="Multisig"
      showBack={false}
      footer={
        <div className="space-y-2">
          <FlowButton
            isLoading={waitingForDevices || session.savingRecord}
            onClick={() => dispatch({ type: 'FINGERPRINT_CONFIRMED', stage })}
          >
            {session.savingRecord
              ? 'Saving…'
              : waitingForDevices
                ? 'Waiting for devices…'
                : 'Matches'}
          </FlowButton>
          {/* Once the owner has said Matches, rejecting is no longer the owner's call here. */}
          {!ownerConfirmed && (
            <Button variant="link" className="w-full" onClick={() => void handleReject()}>
              Doesn&apos;t match
            </Button>
          )}
        </div>
      }
    >
      <div className="flex flex-col items-center text-center">
        <div className="flex size-[72px] items-center justify-center rounded-full bg-primary/15">
          <Icon
            icon="lucide:link"
            width={28}
            height={28}
            className="text-primary"
            aria-hidden="true"
          />
        </div>
        <h2 className="mt-5 text-lg font-semibold">{copy.title}</h2>
      </div>

      <div className="mt-5">
        <FingerprintBlock value={formatFingerprint(fingerprint ?? '')} />
      </div>
      <p className="mt-3 text-center text-xs text-muted">{description}</p>

      <div className="mt-5 space-y-3">
        {devices.map(entry => (
          <DeviceCard
            key={entry.slot}
            slot={entry.slot}
            role="guardian"
            title={`${entry.device.name} · ${entry.device.model}`}
            status={deviceStatus(entry.confirmed)}
          />
        ))}
      </div>
    </MultisigTabLayout>
  )
}
