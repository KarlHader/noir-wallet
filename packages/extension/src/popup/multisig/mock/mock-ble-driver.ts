import type { CreateSessionEvent } from '@/core/multisig/create-session'
import type { VaultWasm } from '@/core/multisig/dkg-protocol'
import type { SessionDriver } from '@/core/multisig/driver'
import { createEnvelopeFactory, deviceId, type MultisigMessageType } from '@/core/multisig/messages'
import { PAIRING_CODE_TTL_MS, type DeviceSlot, type MultisigDevice } from '@/core/multisig/types'
import type { BluetoothSelection } from '@/lib/multisig-bluetooth'
import {
  MockPhone,
  createStepWatchdog,
  isGuardianSlot,
  randomPairingCode,
  realTimeHooks,
  type MockSessionIds
} from './mock-phone'
import { MOCK_GUARDIANS } from './mock-settings'

type Dispatch = (event: CreateSessionEvent) => void

export type ChooserRejection = 'unavailable' | 'duplicate'

export interface MockBleDriverOptions {
  session: MockSessionIds
  /** Shows a Bluetooth chooser and resolves with what became of it. */
  onChooser: (slot: DeviceSlot) => Promise<BluetoothSelection>
  /** Pairing did not start for a reason the user cannot see in the chooser itself. */
  onChooserRejected: (reason: ChooserRejection) => void
  /** The wallet WASM the simulated phones compute their DKG steps on. */
  loadVault: () => Promise<VaultWasm>
}

const UNNAMED_DEVICE = 'Unknown device'

// Only labels the pairing in progress: the phone states who it is in PAIR_RESPONSE.
function chooserDevice(slot: 2 | 3, name: string | null): MultisigDevice {
  const label = name ?? UNNAMED_DEVICE
  return { ...MOCK_GUARDIANS[slot], name: label, model: label }
}

/**
 * Bluetooth stand-in: messages go straight to a MockPhone per guardian slot, and its answers come
 * back as events. Inbound messages are always forwarded and the reducer decides what they mean;
 * a wait only arms a timer, because a filter here would swallow a phone's SESSION_ABORT, which
 * nobody ever waits for.
 */
export function createMockBleDriver(options: MockBleDriverOptions): SessionDriver {
  const hooks = realTimeHooks
  const session: MockSessionIds = {
    groupId: options.session.groupId,
    sessionId: options.session.sessionId
  }
  const envelopeTo = createEnvelopeFactory({ ...session, senderId: deviceId(1) })
  const phones = new Map<2 | 3, MockPhone>()
  const codeExpiry = new Map<DeviceSlot, () => void>()
  const watchdog = createStepWatchdog(hooks)
  // Bumped on every new chooser and on teardown, so an answer to an abandoned chooser is dropped
  // instead of selecting a device for a later pairing attempt.
  const chooserRequests = new Map<DeviceSlot, number>()
  const bluetoothIds = new Map<2 | 3, string>()
  let disposed = false

  // Warms the page's WASM instance while the user is still pairing; a failure here is reported
  // later, by the first phone that actually needs it.
  void options.loadVault().catch(() => {})

  function cancelCodeExpiry(slot: DeviceSlot): void {
    codeExpiry.get(slot)?.()
    codeExpiry.delete(slot)
  }

  function dropPhone(slot: DeviceSlot): void {
    if (!isGuardianSlot(slot)) return
    phones.get(slot)?.dispose()
    phones.delete(slot)
    bluetoothIds.delete(slot)
  }

  function nextChooserRequest(slot: DeviceSlot): number {
    const request = (chooserRequests.get(slot) ?? 0) + 1
    chooserRequests.set(slot, request)
    return request
  }

  // The chooser cannot hide a phone that is already in the group, and one phone holding two
  // shares would defeat the threshold, so the answer is checked after the pick.
  function isTakenByOtherSlot(slot: 2 | 3, id: string): boolean {
    return [...bluetoothIds].some(([other, taken]) => other !== slot && taken === id)
  }

  function requestDevice(slot: DeviceSlot, dispatch: Dispatch): void {
    if (!isGuardianSlot(slot)) return
    const request = nextChooserRequest(slot)
    const reject = (reason: ChooserRejection) => {
      options.onChooserRejected(reason)
      dispatch({ type: 'PAIR_SELECTION_CANCELLED', slot })
    }
    const settle = (selection: BluetoothSelection) => {
      if (disposed || chooserRequests.get(slot) !== request) return
      if (selection.status === 'cancelled') {
        dispatch({ type: 'PAIR_SELECTION_CANCELLED', slot })
        return
      }
      if (selection.status === 'unavailable') {
        reject('unavailable')
        return
      }
      if (isTakenByOtherSlot(slot, selection.id)) {
        reject('duplicate')
        return
      }
      dropPhone(slot)
      phones.set(slot, new MockPhone(slot, session, hooks, options.loadVault))
      bluetoothIds.set(slot, selection.id)
      dispatch({ type: 'PAIR_DEVICE_SELECTED', slot, device: chooserDevice(slot, selection.name) })
    }
    // Synchronous up to onChooser: the browser's chooser needs the click that got us here. A
    // chooser that throws or rejects counts as the user closing it.
    new Promise<BluetoothSelection>(resolve => resolve(options.onChooser(slot))).then(settle, () =>
      settle({ status: 'cancelled' })
    )
  }

  function issueCode(slot: DeviceSlot, dispatch: Dispatch): void {
    if (!isGuardianSlot(slot)) return
    // PAIR_CODE_EXPIRED does not say which code expired, so only the newest code may keep a timer.
    cancelCodeExpiry(slot)
    const code = randomPairingCode()
    const expiresAt = hooks.now() + PAIRING_CODE_TTL_MS
    const expire = () => {
      codeExpiry.delete(slot)
      dispatch({ type: 'PAIR_CODE_EXPIRED', slot })
    }
    codeExpiry.set(slot, hooks.schedule(expire, PAIRING_CODE_TTL_MS))
    // Stands in for the user reading the code off the screen; the invite never carries it.
    phones.get(slot)?.setPairingCode(code)
    // Synchronous on purpose: the reducer must hold the new code before any reply can be checked.
    dispatch({ type: 'PAIR_CODE_ISSUED', slot, code, expiresAt })
  }

  function sendTo(
    slot: DeviceSlot,
    messageType: MultisigMessageType,
    payload: Record<string, unknown> | undefined,
    dispatch: Dispatch
  ): void {
    if (!isGuardianSlot(slot)) return
    const phone = phones.get(slot)
    // No phone means the slot was torn down; the step watchdog reports the silence if it matters.
    if (!phone) return
    phone.receive(envelopeTo(messageType, deviceId(slot), payload), signal => {
      // Anything a replaced or dropped phone still says belongs to an earlier pairing.
      if (disposed || phones.get(slot) !== phone) return
      if ('type' in signal) {
        if (signal.type === 'failed') {
          // The phone could not complete a DKG step; the session must not wait for a reply.
          dispatch({ type: 'DKG_FAILED' })
          return
        }
        dropPhone(slot)
        dispatch({ type: 'DEVICE_DISCONNECTED', slot })
        return
      }
      watchdog.satisfy(slot, signal.message_type)
      dispatch({ type: 'MESSAGE_RECEIVED', slot, envelope: signal, at: hooks.now() })
    })
  }

  function teardown(slot: DeviceSlot): void {
    dropPhone(slot)
    cancelCodeExpiry(slot)
    watchdog.disarm(slot)
    nextChooserRequest(slot)
  }

  return {
    kind: 'ble',
    execute(effect, dispatch) {
      if (disposed) return
      switch (effect.type) {
        case 'requestDevice':
          requestDevice(effect.slot, dispatch)
          break
        case 'issueCode':
          issueCode(effect.slot, dispatch)
          break
        case 'sendTo':
          sendTo(effect.slot, effect.messageType, effect.payload, dispatch)
          break
        case 'awaitFrom':
          watchdog.arm(effect.slot, effect.messageType, () => dispatch({ type: 'STEP_TIMEOUT' }))
          break
        case 'disconnect':
          teardown(effect.slot)
          break
        // QR effects never reach a Bluetooth session, and the store persists the group itself.
        case 'display':
        case 'awaitScan':
        case 'persistGroup':
          break
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const phone of phones.values()) phone.dispose()
      phones.clear()
      for (const cancel of codeExpiry.values()) cancel()
      codeExpiry.clear()
      watchdog.disarmAll()
    }
  }
}
