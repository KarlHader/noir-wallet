/**
 * noir-multisig-mock: developer panel for the simulated phones.
 *
 * The real phones do not exist yet, so this panel plays the user's other hand: it decides how
 * each simulated phone answers next and completes the steps a real phone would complete (scan the
 * code on screen, show its reply). It holds no flow logic of its own; every action goes through
 * the create-session store. Builds with the multisig UI switched off must not contain this file;
 * the build-surface check looks for the marker string above, and the rendered test id below keeps
 * it in the bundle after minification.
 */
import { useEffect, useId, useState } from 'react'
import { Icon } from '@iconify/react'
import { guardianSlots, scanMarked } from '@/core/multisig/create-session'
import { formatFingerprint } from '@/core/multisig/fingerprint'
import type { DeviceSlot } from '@/core/multisig/types'
import { Button } from '@/popup/components/ui/button'
import { useCreateSessionStore } from '@/popup/multisig/create-session-store'
import { useMultisigGroupStore } from '@/popup/multisig/group-store'
import { useLocation } from '@/popup/provider/Router'
import { toast } from '@/store/toast-store'
import { useWalletStore } from '@/store/wallet-store'
import {
  readMockSettings,
  writeMockSettings,
  type MockQrPhones,
  type MockResponse,
  type MockSettings
} from './mock-settings'

const MOCK_RESPONSES: readonly MockResponse[] = [
  'approve',
  'reject',
  'timeout',
  'wrong_code',
  'disconnect'
]
// Shown before a session exists, so a response can be chosen ahead of the first pairing.
const DEFAULT_GUARDIAN_SLOTS: readonly DeviceSlot[] = [2, 3]

// Every flow page mounts its own layout, and with it its own panel, so the open state lives here
// to survive a page change instead of closing the panel on each step.
let panelOpen = false

const FIELD_CLASS =
  'w-full rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50'

function isMockResponse(value: string): value is MockResponse {
  return (MOCK_RESPONSES as readonly string[]).includes(value)
}

interface SlotSettingsProps {
  slot: DeviceSlot
  response: MockResponse
  onResponseChange: (slot: DeviceSlot, response: MockResponse) => void
}

function SlotSettings({ slot, response, onResponseChange }: SlotSettingsProps) {
  const selectId = useId()
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1 font-medium text-foreground">Device {slot}</legend>
      <label htmlFor={selectId} className="mb-1 block text-muted">
        Next response
      </label>
      <select
        id={selectId}
        value={response}
        onChange={event => {
          const next = event.target.value
          if (isMockResponse(next)) onResponseChange(slot, next)
        }}
        className={FIELD_CLASS}
      >
        {MOCK_RESPONSES.map(option => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </fieldset>
  )
}

/** Floating panel (bottom right of the multisig tab) that steers the simulated phones. */
export function DevPanel() {
  const panelId = useId()
  const delayId = useId()
  const chooserId = useId()
  const qrPhonesId = useId()
  const session = useCreateSessionStore(state => state.session)
  const pendingDisplay = useCreateSessionStore(state => state.pendingDisplay)
  const pendingScan = useCreateSessionStore(state => state.pendingScan)
  const dispatch = useCreateSessionStore(state => state.dispatch)
  const markPhoneScanned = useCreateSessionStore(state => state.markPhoneScanned)
  const simulateScan = useCreateSessionStore(state => state.simulateScan)
  const confirmIdentity = useCreateSessionStore(state => state.confirmIdentity)
  const storedScope = useCreateSessionStore(state => state.scope)
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  const { search } = useLocation()

  const [open, setOpen] = useState(panelOpen)
  const [settings, setSettings] = useState<MockSettings>(readMockSettings)
  // Kept apart from settings.delayMs so the field can be empty or half typed without the
  // stored value snapping back under the cursor.
  const [delayText, setDelayText] = useState(() => String(readMockSettings().delayMs))

  // The phones reset a slot's response to 'approve' once they have used it, so the stored values
  // move on their own. Re-reading when the panel opens and whenever the session moves keeps the
  // fields honest.
  useEffect(() => {
    if (!open) return
    const latest = readMockSettings()
    setSettings(latest)
    setDelayText(String(latest.delayMs))
  }, [open, session])

  const slots = session ? guardianSlots(session) : DEFAULT_GUARDIAN_SLOTS
  const guardians = session?.devices.filter(entry => entry.slot !== 1) ?? []

  // A display can name several phones (the 3-device group code); mark the first that has not
  // scanned it yet.
  const scannedSlots = session?.qrShownTo ?? []
  const phoneToMark = pendingDisplay?.slots.find(slot => !scannedSlots.includes(slot)) ?? null

  // One simulated reply per phone the camera still waits for.
  const slotsToSimulate =
    pendingScan?.slots.filter(slot => {
      const entry = guardians.find(guardian => guardian.slot === slot)
      return entry !== undefined && !scanMarked(entry, pendingScan.messageType)
    }) ?? []
  const identityChecks = guardians.filter(entry => entry.connection === 'identity_check')
  const realPhones = settings.qrPhones === 'real'

  const pending = [
    pendingDisplay
      ? `display ${pendingDisplay.messageTypes.join(' + ')} → ${pendingDisplay.slots.join(', ')}`
      : null,
    pendingScan ? `scan ${pendingScan.messageType} ← ${pendingScan.slots.join(', ')}` : null
  ].filter((part): part is string => part !== null)

  // Built from a fresh read, not from state: a phone may have consumed a response since the last
  // render, and writing the stale copy back would re-arm it.
  const updateSettings = (change: (current: MockSettings) => MockSettings) => {
    writeMockSettings(change(readMockSettings()))
    setSettings(readMockSettings())
  }

  const handleResponseChange = (slot: DeviceSlot, response: MockResponse) => {
    updateSettings(current => ({
      ...current,
      nextResponse: { ...current.nextResponse, [slot]: response }
    }))
  }

  const handleDelayChange = (raw: string) => {
    setDelayText(raw)
    const delayMs = Number(raw)
    if (raw.trim() === '' || !Number.isFinite(delayMs) || delayMs < 0) return
    updateSettings(current => ({ ...current, delayMs }))
  }

  const handleChooserChange = (raw: string) => {
    const chooser = raw === 'simulated' ? 'simulated' : 'native'
    updateSettings(current => ({ ...current, chooser }))
  }

  // Applies from the next QR session: the store decides on attaching its driver.
  const handleQrPhonesChange = (raw: string) => {
    const qrPhones: MockQrPhones = raw === 'real' ? 'real' : 'simulated'
    updateSettings(current => ({ ...current, qrPhones }))
  }

  const handleReset = async () => {
    try {
      // Not the session store's reset(): on a flow page that would drop the session under the
      // page and trigger the session-lost redirect.
      await useMultisigGroupStore.getState().clear()
      toast.info('Multisig data cleared')
    } catch (error) {
      console.error('Failed to clear multisig data', error)
      toast.error('Could not clear multisig data')
    }
  }

  const handleCheckShare = async () => {
    const params = new URLSearchParams(search)
    const walletId = params.get('walletId')
    const accountId = params.get('accountId')
    const scope =
      storedScope ??
      (walletId && accountId ? { network: currentNetwork, walletId, accountId } : null)
    if (!scope) {
      toast.info('No account to check')
      return
    }
    try {
      // Loaded on click, like the session store does, so nothing that imports this panel pulls the
      // Worker client (and chrome.*) into its module graph.
      const { requestVaultGroup } = await import('@/core/worker/client')
      const summary = await requestVaultGroup('vault.group.summary', { scope })
      if (summary.status === 'ok') {
        toast.info(`Saved share OK · ${formatFingerprint(summary.fingerprint)}`)
      } else {
        toast.info('No saved share for this account')
      }
    } catch {
      // Not logged: the error may carry detail about the sealed record.
      toast.error('Could not check the saved share')
    }
  }

  return (
    <div
      data-testid="noir-multisig-mock-panel"
      className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2"
    >
      {open && (
        <div
          id={panelId}
          className="w-72 space-y-3 rounded-xl border border-border bg-popover p-3 text-xs text-foreground shadow-lg"
        >
          <div className="space-y-1">
            <p>Session: {session?.phase ?? '—'}</p>
            {guardians.map(entry => (
              <p key={entry.slot}>
                Device {entry.slot}: {entry.connection}
              </p>
            ))}
            <p className="break-words">
              Pending: {pending.length > 0 ? pending.join(' | ') : 'none'}
            </p>
          </div>

          {slots.map(slot => (
            <SlotSettings
              key={slot}
              slot={slot}
              response={settings.nextResponse[slot]}
              onResponseChange={handleResponseChange}
            />
          ))}

          <div>
            <label htmlFor={delayId} className="mb-1 block text-muted">
              Delay (ms)
            </label>
            <input
              id={delayId}
              type="number"
              min={0}
              step={100}
              value={delayText}
              onChange={event => handleDelayChange(event.target.value)}
              className={FIELD_CLASS}
            />
          </div>

          <div>
            <label htmlFor={chooserId} className="mb-1 block text-muted">
              Bluetooth chooser
            </label>
            <select
              id={chooserId}
              value={settings.chooser}
              onChange={event => handleChooserChange(event.target.value)}
              className={FIELD_CLASS}
            >
              <option value="native">Browser</option>
              <option value="simulated">Simulated</option>
            </select>
          </div>

          <div>
            <label htmlFor={qrPhonesId} className="mb-1 block text-muted">
              QR phones
            </label>
            <select
              id={qrPhonesId}
              value={settings.qrPhones}
              onChange={event => handleQrPhonesChange(event.target.value)}
              className={FIELD_CLASS}
            >
              <option value="simulated">Simulated</option>
              <option value="real">Real</option>
            </select>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={phoneToMark === null}
              onClick={() => {
                if (phoneToMark !== null) markPhoneScanned(phoneToMark)
              }}
            >
              Phone scanned
            </Button>
            {slotsToSimulate.map(slot => (
              <Button
                key={slot}
                variant="outline"
                size="sm"
                disabled={realPhones}
                onClick={() => void simulateScan(slot)}
              >
                Simulate scan · Device {slot}
              </Button>
            ))}
            {identityChecks.map(entry => (
              <Button
                key={entry.slot}
                variant="outline"
                size="sm"
                onClick={() => confirmIdentity(entry.slot)}
              >
                Confirm identity · Device {entry.slot}
              </Button>
            ))}
            <Button
              variant="outline"
              size="sm"
              disabled={!session}
              onClick={() => dispatch({ type: 'USER_ABORT' })}
            >
              Abort session
            </Button>
            <Button variant="outline" size="sm" onClick={() => void handleReset()}>
              Reset multisig data
            </Button>
            <Button
              variant="outline"
              size="sm"
              data-testid="noir-multisig-mock-check-share"
              onClick={() => void handleCheckShare()}
            >
              Check saved share
            </Button>
          </div>
        </div>
      )}
      <button
        type="button"
        aria-label="Developer panel"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => {
          panelOpen = !open
          setOpen(panelOpen)
        }}
        className="flex size-10 cursor-pointer items-center justify-center rounded-full border border-border bg-popover text-foreground shadow-lg transition-colors hover:bg-accent"
      >
        <Icon icon="lucide:bug" width={18} height={18} aria-hidden="true" />
      </button>
    </div>
  )
}
