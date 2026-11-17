import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  buildQrCeremonySteps,
  buildQrPairingSteps,
  qrStepCounter
} from '../../../src/core/multisig/qr-plan'

test.describe('multisig qr-plan', () => {
  test('pairing is invite, reply, identity check', () => {
    expect(buildQrPairingSteps(2)).toEqual([
      { kind: 'show', slots: [2], messageTypes: ['PAIR_INVITE'], title: 'Invite' },
      { kind: 'scan', slots: [2], messageType: 'PAIR_RESPONSE', title: 'Reply' },
      { kind: 'verify', stage: 'identity', title: 'Confirm device identity' }
    ])
    expect(buildQrPairingSteps(3)[0]).toEqual({
      kind: 'show',
      slots: [3],
      messageTypes: ['PAIR_INVITE'],
      title: 'Invite'
    })
  })

  test('2-of-2 ceremony is the nine steps of spec 7.2', () => {
    expect(buildQrCeremonySteps('2-of-2')).toEqual([
      { kind: 'show', slots: [2], messageTypes: ['ROSTER_LOCK'], title: 'Group roster' },
      { kind: 'scan', slots: [2], messageType: 'DKG_R1', title: 'Round 1' },
      { kind: 'show', slots: [2], messageTypes: ['DKG_R1_BUNDLE'], title: 'Round 1 bundle' },
      { kind: 'scan', slots: [2], messageType: 'DKG_R1_ECHO', title: 'Round 1 check' },
      { kind: 'show', slots: [2], messageTypes: ['DKG_R1_CERT'], title: 'Round 1 complete' },
      { kind: 'scan', slots: [2], messageType: 'DKG_R2_BATCH', title: 'Round 2' },
      {
        kind: 'show',
        slots: [2],
        messageTypes: ['DKG_R2_INBOX', 'KEYSET_SETUP'],
        title: 'Shares'
      },
      { kind: 'verify', stage: 'final', title: 'Verify the group' },
      { kind: 'scan', slots: [2], messageType: 'DKG_FINAL', title: 'Final confirmation' }
    ])
  })

  test('x-of-3 ceremony adds the roster and round-1 checks', () => {
    for (const t of ['2-of-3', '3-of-3'] as const) {
      expect(buildQrCeremonySteps(t)).toEqual([
        { kind: 'show', slots: [2, 3], messageTypes: ['ROSTER_LOCK'], title: 'Group roster' },
        { kind: 'verify', stage: 'roster', title: 'Verify the roster' },
        { kind: 'scan', slots: [2, 3], messageType: 'DKG_R1', title: 'Round 1' },
        { kind: 'show', slots: [2, 3], messageTypes: ['DKG_R1_BUNDLE'], title: 'Round 1 bundle' },
        { kind: 'verify', stage: 'r1', title: 'Verify round 1' },
        { kind: 'scan', slots: [2, 3], messageType: 'DKG_R1_ECHO', title: 'Round 1 check' },
        { kind: 'show', slots: [2, 3], messageTypes: ['DKG_R1_CERT'], title: 'Round 1 complete' },
        { kind: 'scan', slots: [2, 3], messageType: 'DKG_R2_BATCH', title: 'Round 2' },
        {
          kind: 'show',
          slots: [2, 3],
          messageTypes: ['DKG_R2_INBOX', 'KEYSET_SETUP'],
          title: 'Shares'
        },
        { kind: 'verify', stage: 'final', title: 'Verify the group' },
        { kind: 'scan', slots: [2, 3], messageType: 'DKG_FINAL', title: 'Final confirmation' }
      ])
    }
  })

  test('counters count per phase', () => {
    expect(qrStepCounter('2-of-2', 'pairing', 0)).toEqual({ current: 1, total: 3 })
    expect(qrStepCounter('2-of-3', 'pairing', 2)).toEqual({ current: 3, total: 3 })
    expect(qrStepCounter('2-of-2', 'ceremony', 0)).toEqual({ current: 1, total: 9 })
    expect(qrStepCounter('2-of-2', 'ceremony', 8)).toEqual({ current: 9, total: 9 })
    expect(qrStepCounter('3-of-3', 'ceremony', 0)).toEqual({ current: 1, total: 11 })
    expect(qrStepCounter('2-of-3', 'ceremony', 10)).toEqual({ current: 11, total: 11 })
  })

  test('qrStepCounter rejects indexes outside the phase', () => {
    expect(() => qrStepCounter('2-of-2', 'pairing', 3)).toThrow(RangeError)
    expect(() => qrStepCounter('2-of-2', 'ceremony', 9)).toThrow(RangeError)
    expect(() => qrStepCounter('3-of-3', 'ceremony', 11)).toThrow(RangeError)
    expect(() => qrStepCounter('3-of-3', 'ceremony', -1)).toThrow(RangeError)
  })
})
