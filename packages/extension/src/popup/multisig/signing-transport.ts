import type { UR } from '@ngraveio/bc-ur'
import { assertSigningCarrierSize } from '@/core/multisig/sign-protocol'
import type { SigningReviewBinding } from '@/core/multisig/signing-coordinator'
import { deviceId, parseEnvelope, roundOf } from '@/core/multisig/messages'
import type { MultisigEnvelope } from '@/core/multisig/messages'
import type { DeviceSlot } from '@/core/multisig/types'
import { decodeEnvelopeUR, MAX_ENVELOPES_PER_CODE } from '@/lib/multisig-ur'

export type SigningScanOutcome = 'accepted' | 'duplicate' | 'ignored'

export interface QrSigningTransport {
  setOutbound(envelopes: readonly MultisigEnvelope[]): void
  getOutbound(): MultisigEnvelope[]
  ingestQr(ur: UR): Promise<SigningScanOutcome>
  dispose(): void
}

/** A short-lived carrier. The Background/Worker remains the authority for phone signatures. */
export function createQrSigningTransport(options: {
  binding: SigningReviewBinding
  onEnvelope: (envelope: MultisigEnvelope) => Promise<void>
  now?: () => number
}): QrSigningTransport {
  const binding = { ...options.binding, selectedSlots: [...options.binding.selectedSlots] }
  if (
    !Number.isSafeInteger(binding.expiresAt) ||
    binding.selectedSlots.length < 2 ||
    binding.selectedSlots.length > 3 ||
    !binding.selectedSlots.includes(0) ||
    new Set(binding.selectedSlots).size !== binding.selectedSlots.length ||
    binding.selectedSlots.some(slot => !Number.isInteger(slot) || slot < 0 || slot > 2)
  ) {
    throw new Error('Invalid signing session')
  }
  const phones = new Set(
    binding.selectedSlots.filter(slot => slot !== 0).map(slot => deviceId((slot + 1) as DeviceSlot))
  )
  const now = options.now ?? Date.now
  let disposed = false
  let outbound: MultisigEnvelope[] = []
  let tail: Promise<unknown> = Promise.resolve()
  const accepted = new Map<string, { sequence: number; envelope: string }>()

  function isCurrent(): boolean {
    return !disposed && now() < binding.expiresAt
  }

  function isSessionEnvelope(envelope: MultisigEnvelope): boolean {
    return (
      envelope.group_id === binding.groupId &&
      envelope.session_id === binding.sessionId &&
      envelope.round === roundOf(envelope.message_type)
    )
  }

  return {
    setOutbound(envelopes) {
      if (!isCurrent() || envelopes.length > MAX_ENVELOPES_PER_CODE) {
        throw new Error('Signing session is unavailable')
      }
      const next = envelopes.map(raw => {
        const envelope = parseEnvelope(raw)
        if (
          !envelope ||
          !isSessionEnvelope(envelope) ||
          envelope.sender_id !== deviceId(1) ||
          !phones.has(envelope.recipient_id) ||
          !['SIGN_INIT', 'SIGN_PAYLOAD', 'SESSION_ABORT'].includes(envelope.message_type)
        ) {
          throw new Error('Invalid signing carrier')
        }
        assertSigningCarrierSize(envelope, 'qr')
        return envelope
      })
      outbound = next
    },
    getOutbound: () => (isCurrent() ? outbound.map(envelope => ({ ...envelope })) : []),
    ingestQr(ur) {
      const job = tail
        .catch(() => {})
        .then(async (): Promise<SigningScanOutcome> => {
          if (!isCurrent()) return 'ignored'
          const envelope = decodeEnvelopeUR(ur)
          if (
            !envelope ||
            !isSessionEnvelope(envelope) ||
            !phones.has(envelope.sender_id) ||
            envelope.recipient_id !== deviceId(1) ||
            !['SIGN_COMMITMENTS', 'SIGN_SHARE', 'SIGN_REJECT', 'SESSION_ABORT'].includes(
              envelope.message_type
            )
          ) {
            return 'ignored'
          }
          try {
            assertSigningCarrierSize(envelope, 'qr')
          } catch {
            return 'ignored'
          }
          const previous = accepted.get(envelope.sender_id)
          const serialized = JSON.stringify(envelope)
          if (previous && envelope.sequence <= previous.sequence) {
            return previous.sequence === envelope.sequence && previous.envelope === serialized
              ? 'duplicate'
              : 'ignored'
          }
          await options.onEnvelope(envelope)
          if (!isCurrent()) return 'ignored'
          accepted.set(envelope.sender_id, { sequence: envelope.sequence, envelope: serialized })
          return 'accepted'
        })
      tail = job
      return job
    },
    dispose() {
      disposed = true
      outbound = []
      accepted.clear()
    }
  }
}
