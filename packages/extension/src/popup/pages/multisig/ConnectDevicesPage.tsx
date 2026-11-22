import { useEffect, useState } from 'react'
import { allGuardiansConnected } from '@/core/multisig/create-session'
import type { CreateSessionState, DeviceSessionState } from '@/core/multisig/create-session'
import type { DeviceSlot, MultisigTransportKind } from '@/core/multisig/types'
import { DeviceCard } from '@/popup/components/multisig/DeviceCard'
import { PairingCodeSheet } from '@/popup/components/multisig/PairingCodeSheet'
import type { PairingCodeMode } from '@/popup/components/multisig/PairingCodeSheet'
import { Pill } from '@/popup/components/multisig/Pill'
import { SegmentedToggle } from '@/popup/components/multisig/SegmentedToggle'
import { FlowButton } from '@/popup/components/multisig/FlowButton'
import { useDialog } from '@/popup/hooks/useDialog'
import { useCreateSessionStore } from '@/popup/multisig/create-session-store'
import { MockDeviceChooser } from '@/popup/multisig/mock/MockDeviceChooser'
import { MOCK_CHOOSER_DEVICES, readMockSettings } from '@/popup/multisig/mock/mock-settings'
import { useNavigate } from '@/popup/provider/Router'
import { multisigCreateRoute } from '@/lib/multisig-tab'
import { MultisigTabLayout } from './MultisigTabLayout'

const CREATE_ROUTE = '/multisig/create'
const CEREMONY_ROUTE = `${CREATE_ROUTE}/ceremony`
const QR_CEREMONY_ROUTE = `${CREATE_ROUTE}/qr/0`
const FALLBACK_OWNER_NAME = 'Account'
// Long enough for the check mark to register before the sheet slides away.
const SUCCESS_HOLD_MS = 1000

const TRANSPORT_OPTIONS: { value: MultisigTransportKind; label: string }[] = [
  { value: 'ble', label: 'Bluetooth' },
  { value: 'qr', label: 'QR code' }
]

const QR_ONLY: readonly MultisigTransportKind[] = ['qr']
const BOTH_TRANSPORTS: readonly MultisigTransportKind[] = ['qr', 'ble']
const NO_DISABLED_TRANSPORTS: readonly MultisigTransportKind[] = []

function pairRoute(slot: DeviceSlot, step: 1 | 3 = 1): string {
  return `${CREATE_ROUTE}/pair/${slot}/${step}`
}

// Over Bluetooth the sheet also covers the wait for the phone's answer to the invite; over QR that
// state has its own pages.
function isPairing(entry: DeviceSessionState, transport: MultisigTransportKind): boolean {
  return (
    entry.connection === 'pending' ||
    entry.connection === 'code_wait' ||
    (transport === 'ble' && entry.connection === 'invite_shown')
  )
}

// A code with no expiry is the SAS the channel produced: the user compares it, nothing is typed.
function sheetMode(entry: DeviceSessionState | null): PairingCodeMode {
  if (entry?.connection === 'invite_shown') return 'waiting'
  if (entry?.connection === 'code_wait' && entry.pairingCodeExpiresAt === null) return 'compare'
  return 'enter'
}

interface PairingSheetView {
  /** The guardian the sheet is about; stays set through the exit animation after success. */
  guardian: DeviceSessionState | null
  open: boolean
  success: boolean
}

/**
 * Decides what the pairing code sheet shows. The reducer clears a guardian's code the moment it
 * connects, so the page remembers which slot it was pairing to keep the sheet up for a short
 * success state. Only view timing lives here; every pairing transition comes from the session.
 */
function usePairingSheet(
  guardians: readonly DeviceSessionState[],
  transport: MultisigTransportKind
): PairingSheetView {
  const pairing = guardians.find(entry => isPairing(entry, transport))
  const pairingSlot = pairing?.slot ?? null
  const [activeSlot, setActiveSlot] = useState<DeviceSlot | null>(null)
  const [holdOver, setHoldOver] = useState(false)

  useEffect(() => {
    if (pairingSlot === null) return
    setActiveSlot(pairingSlot)
    // A new pairing, including a repeat of the same slot, earns a fresh success hold.
    setHoldOver(false)
  }, [pairingSlot])

  // activeSlot can outlive a cancelled pairing, but it only counts once that guardian is
  // connected, and a guardian only gets there by pairing, which sets activeSlot again.
  const connected = guardians.find(
    entry => entry.slot === activeSlot && entry.connection === 'connected'
  )
  const success = pairing === undefined && connected !== undefined
  const holding = success && !holdOver

  useEffect(() => {
    if (!holding) return
    const timer = window.setTimeout(() => setHoldOver(true), SUCCESS_HOLD_MS)
    return () => window.clearTimeout(timer)
  }, [holding])

  return {
    guardian: pairing ?? connected ?? null,
    open: pairing !== undefined || holding,
    success
  }
}

function GuardianPairingSheet({
  guardians,
  transport
}: {
  guardians: readonly DeviceSessionState[]
  transport: MultisigTransportKind
}) {
  const dispatch = useCreateSessionStore(state => state.dispatch)
  const { guardian, open, success } = usePairingSheet(guardians, transport)

  return (
    <PairingCodeSheet
      open={open}
      device={guardian?.device ?? null}
      code={guardian?.pairingCode ?? null}
      expiresAt={guardian?.pairingCodeExpiresAt ?? null}
      error={guardian?.codeError ?? null}
      success={success}
      mode={sheetMode(guardian)}
      onConfirm={() => {
        if (guardian) dispatch({ type: 'PAIR_SAS_CONFIRMED', slot: guardian.slot })
      }}
      onResend={() => {
        if (guardian) dispatch({ type: 'PAIR_CODE_RESEND', slot: guardian.slot })
      }}
      onCancel={() => {
        if (guardian) dispatch({ type: 'PAIR_CANCEL', slot: guardian.slot })
      }}
    />
  )
}

interface GuardianCardProps {
  entry: DeviceSessionState
  onConnect: (slot: DeviceSlot) => void
  onConfirmIdentity: (slot: DeviceSlot) => void
}

function GuardianCard({ entry, onConnect, onConfirmIdentity }: GuardianCardProps) {
  const { slot, connection, device } = entry

  switch (connection) {
    case 'empty':
      return (
        <DeviceCard
          slot={slot}
          role="guardian"
          title="Not connected"
          subtitle="Tap to connect"
          status="empty"
          onClick={() => onConnect(slot)}
        />
      )
    case 'connected':
      return (
        <DeviceCard
          slot={slot}
          role="guardian"
          title={device ? `${device.name} · ${device.model}` : 'Connected'}
          status="connected"
        />
      )
    case 'invite_shown':
      // QR only: the invite is out but the phone has not answered. Tapping goes back to it.
      return (
        <DeviceCard
          slot={slot}
          role="guardian"
          title={device?.model ?? 'Connecting…'}
          status="pending"
          highlighted
          onClick={() => onConnect(slot)}
        />
      )
    case 'identity_check':
      // QR only: the phone has answered; its identity still has to be matched by eye.
      return (
        <DeviceCard
          slot={slot}
          role="guardian"
          title={device ? `${device.name} · ${device.model}` : 'Connecting…'}
          subtitle="Confirm identity"
          status="pending"
          highlighted
          onClick={() => onConfirmIdentity(slot)}
        />
      )
    case 'choosing':
    case 'pending':
    case 'code_wait':
      return (
        <DeviceCard
          slot={slot}
          role="guardian"
          title={device?.model ?? 'Connecting…'}
          status="pending"
          highlighted
        />
      )
  }
}

function ConnectDevices({ session }: { session: CreateSessionState }) {
  const { navigate } = useNavigate()
  const { confirm } = useDialog()
  const scope = useCreateSessionStore(state => state.scope)
  const chooser = useCreateSessionStore(state => state.chooser)
  const dispatch = useCreateSessionStore(state => state.dispatch)
  const switchTransport = useCreateSessionStore(state => state.switchTransport)
  const resolveChooser = useCreateSessionStore(state => state.resolveChooser)
  // QR codes are signed with the device identity, so QR waits until it has loaded.
  const identityStatus = useCreateSessionStore(state => state.identity.status)

  const guardians = session.devices.filter(entry => entry.slot !== 1)
  const ownerDevice = session.devices.find(entry => entry.slot === 1)?.device ?? null
  const ownerName = ownerDevice?.name ?? FALLBACK_OWNER_NAME
  const connectedCount = session.devices.filter(entry => entry.connection === 'connected').length
  const hasStartedPairing = guardians.some(entry => entry.connection !== 'empty')

  const handleTransportChange = async (kind: MultisigTransportKind) => {
    if (kind === session.transportKind) return
    // Once any phone is involved the reducer would void the pairing, so the user decides first.
    if (hasStartedPairing) {
      const confirmed = await confirm({
        title: 'Change connection method?',
        message: 'Connected devices will be disconnected and setup starts again.',
        confirmText: 'Change'
      })
      if (!confirmed) return
    }
    switchTransport(kind)
  }

  const handleConnect = (slot: DeviceSlot) => {
    if (session.transportKind === 'qr') navigate(pairRoute(slot))
    else if (readMockSettings().blePhones === 'real' && identityStatus !== 'ready') return
    else dispatch({ type: 'PAIR_START', slot })
  }

  const handleBack = async () => {
    if (hasStartedPairing) {
      const confirmed = await confirm({
        title: 'Leave setup?',
        message: 'Connected devices will be disconnected.',
        confirmText: 'Leave',
        variant: 'danger'
      })
      if (!confirmed) return
    }
    // The threshold page resets the store when it mounts, which also drops the transport. Doing
    // it here first would leave a flow page without a session for a render, and the route guard
    // would answer with its "Session lost" toast. The route is rebuilt from the store's scope
    // because this page's own URL never carries the account.
    navigate(scope ? multisigCreateRoute(scope) : CREATE_ROUTE)
  }

  const handleContinue = () => {
    dispatch({ type: 'CONTINUE' })
    navigate(session.transportKind === 'ble' ? CEREMONY_ROUTE : QR_CEREMONY_ROUTE)
  }

  return (
    <MultisigTabLayout
      step={2}
      title="Multisig"
      onBack={() => void handleBack()}
      footer={
        <FlowButton disabled={!allGuardiansConnected(session)} onClick={handleContinue}>
          Continue
        </FlowButton>
      }
    >
      <h2 className="mt-1 text-xl font-semibold text-white">Connect devices</h2>
      <div className="mt-2 text-sm text-[#BCBCC8]">
        Open Noir Guardians on each phone and stay on its waiting screen.
      </div>

      <div role="group" aria-label="Connection method" className="mt-4">
        <SegmentedToggle
          options={TRANSPORT_OPTIONS}
          value={session.transportKind}
          onChange={kind => void handleTransportChange(kind)}
          disabledValues={
            identityStatus === 'ready'
              ? NO_DISABLED_TRANSPORTS
              : readMockSettings().blePhones === 'real'
                ? BOTH_TRANSPORTS
                : QR_ONLY
          }
        />
        {identityStatus === 'unsupported' && (
          <div className="mt-2 text-xs text-muted">
            QR code setup needs a newer Chrome. Update Chrome and try again, or use Bluetooth.
          </div>
        )}
      </div>

      <div className="mt-7 flex items-center justify-between gap-2">
        <Pill tone="account">{ownerName}</Pill>
        <div className="text-sm tabular-nums text-muted">
          <span className="sr-only">Connected devices: </span>
          <span className="text-primary">{connectedCount}</span>/{session.devices.length}
        </div>
      </div>

      <div className="mt-3 space-y-3">
        {session.devices.map(entry =>
          entry.slot === 1 ? (
            <DeviceCard
              key={entry.slot}
              slot={1}
              role="owner"
              title={ownerDevice ? `${ownerDevice.name} · ${ownerDevice.model}` : ownerName}
              status="signed"
            />
          ) : (
            <GuardianCard
              key={entry.slot}
              entry={entry}
              onConnect={handleConnect}
              onConfirmIdentity={slot => navigate(pairRoute(slot, 3))}
            />
          )
        )}
      </div>

      {chooser && (
        <MockDeviceChooser
          open
          devices={MOCK_CHOOSER_DEVICES}
          onPick={({ advertisedName }) =>
            resolveChooser({ status: 'selected', id: advertisedName, name: advertisedName })
          }
          onCancel={() => resolveChooser({ status: 'cancelled' })}
        />
      )}
      <GuardianPairingSheet guardians={guardians} transport={session.transportKind} />
    </MultisigTabLayout>
  )
}

/** Step 1, part 2: pair each guardian phone, over Bluetooth here or via the QR pages. */
export function ConnectDevicesPage() {
  const session = useCreateSessionStore(state => state.session)
  // The route guard already redirects when the session is missing or aborted; this only
  // narrows the type for the page below.
  if (!session) return null
  return <ConnectDevices session={session} />
}
