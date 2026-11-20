import type { MultisigMessageType } from './messages'
import type { DeviceSlot, MultisigThreshold, VerifyStage } from './types'

export type QrStep =
  | {
      kind: 'show'
      /** The phones that scan this code. */
      slots: readonly DeviceSlot[]
      messageTypes: readonly MultisigMessageType[]
      title: string
    }
  | {
      kind: 'scan'
      /** Every phone whose code is expected; scans are collected in any order. */
      slots: readonly DeviceSlot[]
      messageType: MultisigMessageType
      title: string
    }
  | { kind: 'verify'; stage: VerifyStage; title: string }

// Pairing is invite, reply and identity check per phone, regardless of threshold.
const PAIRING_STEP_COUNT = 3

export function buildQrPairingSteps(slot: DeviceSlot): readonly [QrStep, QrStep, QrStep] {
  return [
    { kind: 'show', slots: [slot], messageTypes: ['PAIR_INVITE'], title: 'Invite' },
    { kind: 'scan', slots: [slot], messageType: 'PAIR_RESPONSE', title: 'Reply' },
    { kind: 'verify', stage: 'identity', title: 'Confirm device identity' }
  ]
}

export function buildQrCeremonySteps(threshold: MultisigThreshold): readonly QrStep[] {
  const guardians: readonly DeviceSlot[] = threshold === '2-of-2' ? [2] : [2, 3]
  // Over QR with three devices there is no live channel to cross-check the roster and the
  // round-1 commitments, so the user compares them by eye.
  const withChecks = threshold !== '2-of-2'
  const roster: QrStep[] = [
    { kind: 'show', slots: guardians, messageTypes: ['ROSTER_LOCK'], title: 'Group roster' }
  ]
  if (withChecks) roster.push({ kind: 'verify', stage: 'roster', title: 'Verify the roster' })
  const round1: QrStep[] = [
    { kind: 'scan', slots: guardians, messageType: 'DKG_R1', title: 'Round 1' },
    { kind: 'show', slots: guardians, messageTypes: ['DKG_R1_BUNDLE'], title: 'Round 1 bundle' }
  ]
  if (withChecks) round1.push({ kind: 'verify', stage: 'r1', title: 'Verify round 1' })
  return [
    ...roster,
    ...round1,
    { kind: 'scan', slots: guardians, messageType: 'DKG_R1_ECHO', title: 'Round 1 check' },
    { kind: 'show', slots: guardians, messageTypes: ['DKG_R1_CERT'], title: 'Round 1 complete' },
    { kind: 'scan', slots: guardians, messageType: 'DKG_R2_BATCH', title: 'Round 2' },
    {
      kind: 'show',
      slots: guardians,
      messageTypes: ['DKG_R2_INBOX', 'KEYSET_SETUP'],
      title: 'Shares'
    },
    { kind: 'verify', stage: 'final', title: 'Verify the group' },
    { kind: 'scan', slots: guardians, messageType: 'DKG_FINAL', title: 'Final confirmation' }
  ]
}

export function qrStepCounter(
  threshold: MultisigThreshold,
  phase: 'pairing' | 'ceremony',
  index: number
): { current: number; total: number } {
  const total = phase === 'pairing' ? PAIRING_STEP_COUNT : buildQrCeremonySteps(threshold).length
  // An out-of-range index means the caller's step state is wrong; fail loudly instead of
  // showing a made-up "12/11" to the user.
  if (!Number.isInteger(index) || index < 0 || index >= total) {
    throw new RangeError(`QR ${phase} step index ${index} is outside 0..${total - 1}`)
  }
  return { current: index + 1, total }
}
