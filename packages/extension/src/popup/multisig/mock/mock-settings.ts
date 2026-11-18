/**
 * noir-multisig-mock: developer settings for the simulated phones.
 *
 * Simulated transports are opt-in development tools. The dev panel decides how each simulated
 * phone answers next; normal sessions connect to real phones. Builds
 * with the multisig UI switched off must not contain this module; the build-surface check looks
 * for the marker string above (see MULTISIG_MOCK_MARKER).
 */
import type { DeviceSlot, MultisigDevice } from '@/core/multisig/types'
import type { BluetoothDeviceQuery } from '@/lib/multisig-bluetooth'

export const MULTISIG_MOCK_MARKER = 'noir-multisig-mock'

// Written out as a literal rather than derived from MULTISIG_MOCK_MARKER: this string is used at
// runtime, so it survives minification and is what the build-surface check actually finds.
const MOCK_SETTINGS_STORAGE_KEY = 'noir-multisig-mock:settings'

export type MockResponse = 'approve' | 'reject' | 'timeout' | 'wrong_code' | 'disconnect'

/** 'simulated' keeps the flow usable where no Bluetooth device or real browser is around. */
type MockChooser = 'native' | 'simulated'

/** 'real' leaves QR sessions to real phones: no reference phone runs alongside them. */
export type MockQrPhones = 'simulated' | 'real'

/** 'real' leaves Bluetooth sessions to real phones: the extension connects over GATT itself. Default. */
export type MockBlePhones = 'simulated' | 'real'

export interface MockSettings {
  delayMs: number
  nextResponse: Record<DeviceSlot, MockResponse>
  chooser: MockChooser
  qrPhones: MockQrPhones
  blePhones: MockBlePhones
}

export const DEFAULT_MOCK_SETTINGS: MockSettings = Object.freeze({
  delayMs: 1000,
  nextResponse: Object.freeze({ 1: 'approve', 2: 'approve', 3: 'approve' }),
  chooser: 'native',
  qrPhones: 'real',
  blePhones: 'real'
})

// Development simulation only: the selected device is represented by a simulated phone.
export const MOCK_BLUETOOTH_QUERY: BluetoothDeviceQuery = Object.freeze({ acceptAllDevices: true })

export const MOCK_GUARDIANS: Readonly<Record<2 | 3, MultisigDevice>> = Object.freeze({
  2: { slot: 2, role: 'guardian', name: 'Alex', model: 'iPhone 17', platform: 'ios' },
  3: { slot: 3, role: 'guardian', name: 'Alex backup', model: 'Android', platform: 'android' }
})

export const MOCK_CHOOSER_DEVICES: readonly { slot: 2 | 3; advertisedName: string }[] =
  Object.freeze([
    { slot: 2, advertisedName: 'iPhone 17' },
    { slot: 3, advertisedName: 'Pixel 9' }
  ])

const MOCK_RESPONSES: readonly MockResponse[] = [
  'approve',
  'reject',
  'timeout',
  'wrong_code',
  'disconnect'
]
const SLOTS: readonly DeviceSlot[] = [1, 2, 3]

function isMockResponse(value: unknown): value is MockResponse {
  return typeof value === 'string' && (MOCK_RESPONSES as readonly string[]).includes(value)
}

function isValidDelay(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function copySettings(settings: MockSettings): MockSettings {
  return { ...settings, nextResponse: { ...settings.nextResponse } }
}

// Field by field, so a hand edit in devtools that breaks one value keeps the others.
function normalizeSettings(value: unknown): MockSettings {
  if (typeof value !== 'object' || value === null) return copySettings(DEFAULT_MOCK_SETTINGS)
  const { delayMs, nextResponse, chooser, qrPhones, blePhones } = value as Record<string, unknown>
  const responses =
    typeof nextResponse === 'object' && nextResponse !== null
      ? (nextResponse as Record<string, unknown>)
      : {}
  const result = copySettings(DEFAULT_MOCK_SETTINGS)
  if (isValidDelay(delayMs)) result.delayMs = delayMs
  if (chooser === 'native' || chooser === 'simulated') result.chooser = chooser
  if (qrPhones === 'simulated' || qrPhones === 'real') result.qrPhones = qrPhones
  if (blePhones === 'simulated' || blePhones === 'real') result.blePhones = blePhones
  for (const slot of SLOTS) {
    const response = responses[slot]
    if (isMockResponse(response)) result.nextResponse[slot] = response
  }
  return result
}

// Node tests have no sessionStorage, and a page with blocked site data throws on access, so the
// in-memory copy is the fallback and sessionStorage only mirrors it.
let memory: MockSettings = copySettings(DEFAULT_MOCK_SETTINGS)

function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

export function readMockSettings(): MockSettings {
  // Node's offline tests explicitly configure simulation; browser simulation is development-only.
  if (typeof window !== 'undefined' && import.meta.env?.DEV !== true) {
    return copySettings(DEFAULT_MOCK_SETTINGS)
  }
  const store = sessionStore()
  if (store) {
    try {
      // Read on every call so values edited by hand in devtools apply without a reload.
      const raw = store.getItem(MOCK_SETTINGS_STORAGE_KEY)
      if (raw !== null) memory = normalizeSettings(JSON.parse(raw))
    } catch {
      memory = copySettings(DEFAULT_MOCK_SETTINGS)
    }
  }
  return copySettings(memory)
}

export function writeMockSettings(next: MockSettings): void {
  memory = normalizeSettings(next)
  const store = sessionStore()
  if (!store) return
  try {
    store.setItem(MOCK_SETTINGS_STORAGE_KEY, JSON.stringify(memory))
  } catch {
    // The in-memory copy still holds the value for this page.
  }
}

/** Returns the slot's pending response and resets it to 'approve': each setting applies once. */
export function consumeNextResponse(slot: DeviceSlot): MockResponse {
  // readMockSettings returns a private copy, so it can be edited in place.
  const settings = readMockSettings()
  const response = settings.nextResponse[slot]
  if (response !== 'approve') {
    settings.nextResponse[slot] = 'approve'
    writeMockSettings(settings)
  }
  return response
}
