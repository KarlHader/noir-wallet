export type MultisigThreshold = '2-of-2' | '2-of-3' | '3-of-3'
export type MultisigTransportKind = 'ble' | 'qr'
export type DeviceSlot = 1 | 2 | 3
export type DeviceRole = 'owner' | 'guardian'
export type DevicePlatform = 'extension' | 'ios' | 'android'

export interface MultisigDevice {
  slot: DeviceSlot
  role: DeviceRole
  name: string
  model: string
  platform: DevicePlatform
}

export interface MultisigGroupRecord {
  groupId: string
  threshold: MultisigThreshold
  transportKind: MultisigTransportKind
  devices: readonly MultisigDevice[]
  fingerprint: string
  createdAt: number
  // Legacy display records remain marked true. Background publishes false only for a committed
  // independent account; the ready journal and authenticated record remain authoritative.
  mock: boolean
}

export type SessionPhase =
  | 'CREATED'
  | 'PAIRING'
  | 'ROSTER_LOCKED'
  | 'DKG_R1'
  | 'R1_VERIFIED'
  | 'DKG_R2'
  | 'FINALIZED'
  | 'KEYSET_VERIFIED'
  | 'ACTIVATED'
  | 'ABORTED'

export type AbortReason =
  | 'device_disconnected'
  | 'verification_failed'
  | 'code_expired'
  | 'user_cancelled'
  | 'session_expired'
  | 'transport_switched'
  | 'fingerprint_mismatch'
  | 'phone_rejected'
  | 'save_failed'

// The design document lists `reply_scanned` separately, but it happens in the same event as
// `connected`, so the two are merged into `connected`.
export type DeviceConnectionState =
  | 'empty'
  | 'choosing'
  | 'pending'
  | 'code_wait'
  | 'invite_shown'
  | 'identity_check'
  | 'connected'

export const PAIRING_CODE_MAX_ATTEMPTS = 5
export const PAIRING_CODE_TTL_MS = 60_000
export const QR_DISPLAY_TTL_MS = 30 * 60_000
export const SESSION_STEP_TIMEOUT_MS = 120_000

export function thresholdDeviceCount(threshold: MultisigThreshold): 2 | 3 {
  return threshold === '2-of-2' ? 2 : 3
}

// Over QR there is no live channel to cross-check round-1 commitments between phones, so the
// user compares them by eye; that only becomes necessary once a third device is involved.
export function thresholdRequiresManualR1Check(
  threshold: MultisigThreshold,
  kind: MultisigTransportKind
): boolean {
  return kind === 'qr' && thresholdDeviceCount(threshold) === 3
}

export type VerifyStage = 'identity' | 'roster' | 'r1' | 'final'
