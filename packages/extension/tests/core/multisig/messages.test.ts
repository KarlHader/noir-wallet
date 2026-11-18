import { test } from 'node:test'
import { expect } from '@playwright/test'
import { createEnvelopeFactory, parseEnvelope } from '../../../src/core/multisig/messages'
import { thresholdRequiresManualR1Check } from '../../../src/core/multisig/types'

const valid = {
  protocol_version: 1,
  message_type: 'PAIR_INVITE',
  group_id: 'g',
  session_id: 's',
  sender_id: 'device-1',
  recipient_id: 'device-2',
  round: 0,
  sequence: 1,
  payload_hash: 'mock',
  encrypted_payload: '{}',
  authentication_data: 'mock'
}

test.describe('multisig messages', () => {
  test('envelope factory increments sequence and assigns rounds', () => {
    const make = createEnvelopeFactory({ groupId: 'g', sessionId: 's', senderId: 'device-1' })
    const a = make('PAIR_INVITE', 'device-2')
    const b = make('DKG_R2_INBOX', 'device-2', { inbox: [] })
    expect([a.sequence, b.sequence]).toEqual([1, 2])
    expect([a.round, b.round]).toEqual([0, 2])
    expect(JSON.parse(b.encrypted_payload)).toEqual({ inbox: [] })
  })

  test('parseEnvelope rejects unknown message types and missing fields', () => {
    expect(parseEnvelope({ ...valid, message_type: 'NOPE' })).toBeNull()
    expect(parseEnvelope({ ...valid, session_id: undefined })).toBeNull()
    expect(parseEnvelope(valid)).toEqual(valid)
  })

  test('accepts iOS signing carriers with their fixed rounds', () => {
    for (const [message_type, round] of [
      ['SIGN_INIT', 1],
      ['SIGN_COMMITMENTS', 1],
      ['SIGN_PAYLOAD', 3],
      ['SIGN_SHARE', 3],
      ['SIGN_REJECT', 3],
      ['SIGN_RESULT', 3]
    ] as const) {
      expect(parseEnvelope({ ...valid, message_type, round })?.message_type).toBe(message_type)
    }
  })

  test('thresholdRequiresManualR1Check only for qr with three devices', () => {
    expect(thresholdRequiresManualR1Check('2-of-3', 'qr')).toBe(true)
    expect(thresholdRequiresManualR1Check('2-of-2', 'qr')).toBe(false)
    expect(thresholdRequiresManualR1Check('3-of-3', 'ble')).toBe(false)
  })
})
