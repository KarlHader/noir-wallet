import type { DeviceSlot } from './types'

export type MultisigMessageType =
  | 'PAIR_INVITE'
  | 'PAIR_RESPONSE'
  | 'ROSTER_LOCK'
  | 'DKG_R1'
  | 'DKG_R1_BUNDLE'
  | 'DKG_R1_ECHO'
  | 'DKG_R1_CERT'
  | 'DKG_R2_BATCH'
  | 'DKG_R2_INBOX'
  | 'KEYSET_SETUP'
  | 'DKG_FINAL'
  | 'DKG_ACTIVATE'
  | 'SESSION_ABORT'

export interface MultisigEnvelope {
  protocol_version: 1
  message_type: MultisigMessageType
  group_id: string
  session_id: string
  sender_id: string
  recipient_id: string
  round: number
  sequence: number
  payload_hash: string
  encrypted_payload: string
  authentication_data: string
}

export interface EnvelopeFactoryInput {
  groupId: string
  sessionId: string
  senderId: string
}

// Doubles as the allow-list of valid message types: Record keeps it exhaustive at compile time.
const ROUND_BY_MESSAGE_TYPE: Record<MultisigMessageType, number> = {
  PAIR_INVITE: 0,
  PAIR_RESPONSE: 0,
  ROSTER_LOCK: 0,
  DKG_R1: 1,
  DKG_R1_BUNDLE: 1,
  DKG_R1_ECHO: 1,
  DKG_R1_CERT: 1,
  DKG_R2_BATCH: 2,
  DKG_R2_INBOX: 2,
  KEYSET_SETUP: 3,
  DKG_FINAL: 3,
  DKG_ACTIVATE: 3,
  SESSION_ABORT: 3
}

// Bluetooth mock only: placeholder hash and tag until that path moves to the signed protocol.
const MOCK_PLACEHOLDER = 'mock'

export function roundOf(messageType: MultisigMessageType): number {
  return ROUND_BY_MESSAGE_TYPE[messageType]
}

function isMessageType(value: unknown): value is MultisigMessageType {
  // hasOwnProperty rather than `in`, so inherited keys such as "toString" are not accepted.
  return (
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(ROUND_BY_MESSAGE_TYPE, value)
  )
}

function isCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function createEnvelopeFactory(
  input: EnvelopeFactoryInput
): (
  message_type: MultisigMessageType,
  recipient_id: string,
  payload?: Record<string, unknown>
) => MultisigEnvelope {
  let sequence = 0
  return (message_type, recipient_id, payload = {}) => {
    sequence += 1
    return {
      protocol_version: 1,
      message_type,
      group_id: input.groupId,
      session_id: input.sessionId,
      sender_id: input.senderId,
      recipient_id,
      round: ROUND_BY_MESSAGE_TYPE[message_type],
      sequence,
      payload_hash: MOCK_PLACEHOLDER,
      encrypted_payload: JSON.stringify(payload),
      authentication_data: MOCK_PLACEHOLDER
    }
  }
}

export function parseEnvelope(value: unknown): MultisigEnvelope | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Record<string, unknown>
  const {
    protocol_version,
    message_type,
    group_id,
    session_id,
    sender_id,
    recipient_id,
    round,
    sequence,
    payload_hash,
    encrypted_payload,
    authentication_data
  } = candidate
  if (protocol_version !== 1 || !isMessageType(message_type)) return null
  if (
    typeof group_id !== 'string' ||
    typeof session_id !== 'string' ||
    typeof sender_id !== 'string' ||
    typeof recipient_id !== 'string' ||
    typeof payload_hash !== 'string' ||
    typeof encrypted_payload !== 'string' ||
    typeof authentication_data !== 'string' ||
    !isCounter(round) ||
    !isCounter(sequence)
  ) {
    return null
  }
  // Rebuilt field by field so unknown extra properties from the wire never reach callers.
  return {
    protocol_version,
    message_type,
    group_id,
    session_id,
    sender_id,
    recipient_id,
    round,
    sequence,
    payload_hash,
    encrypted_payload,
    authentication_data
  }
}

export function deviceId(slot: DeviceSlot): string {
  return `device-${slot}`
}
