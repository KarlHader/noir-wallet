/**
 * A simulated guardian phone, plus the timing pieces both mock transports share.
 *
 * Stays free of React and browser-only APIs so Node tests can drive it with their own hooks.
 * Pairing is still make-believe; the DKG steps run on the real wallet WASM through MockPhoneDkg.
 */
import {
  parseDkgEnvelopePayload,
  parseKeysetSetupPayload,
  parseRosterLockPayload,
  type VaultWasm
} from '@/core/multisig/dkg-protocol'
import {
  createEnvelopeFactory,
  deviceId,
  type MultisigEnvelope,
  type MultisigMessageType
} from '@/core/multisig/messages'
import { SESSION_STEP_TIMEOUT_MS, type DeviceSlot } from '@/core/multisig/types'
import { MockPhoneDkg } from './mock-phone-dkg'
import { MOCK_GUARDIANS, consumeNextResponse, readMockSettings } from './mock-settings'

export interface MockPhoneHooks {
  now(): number
  schedule(fn: () => void, delayMs: number): () => void
}

export interface MockSessionIds {
  groupId: string
  sessionId: string
}

/** 'failed' is a DKG step the phone could not complete: the transport aborts the ceremony. */
export type MockPhoneSignal = MultisigEnvelope | { type: 'disconnect' } | { type: 'failed' }

/** The hooks the running extension uses; tests pass their own to control time. */
export const realTimeHooks: MockPhoneHooks = {
  now: () => Date.now(),
  schedule: (fn, delayMs) => {
    const id = setTimeout(fn, delayMs)
    return () => clearTimeout(id)
  }
}

export function isGuardianSlot(slot: DeviceSlot): slot is 2 | 3 {
  return slot !== 1
}

const PAIRING_CODE_SPACE = 1_000_000

/** A 6-digit, zero-padded pairing code. */
export function randomPairingCode(): string {
  // Mock pairing proves nothing, so the modulo bias and the Math.random fallback do not matter.
  const value =
    typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function'
      ? crypto.getRandomValues(new Uint32Array(1))[0] % PAIRING_CODE_SPACE
      : Math.floor(Math.random() * PAIRING_CODE_SPACE)
  return String(value).padStart(6, '0')
}

function otherPairingCode(code: string): string {
  let wrong = randomPairingCode()
  while (wrong === code) wrong = randomPairingCode()
  return wrong
}

export interface StepWatchdog {
  /**
   * Starts the slot's step timer, replacing any earlier one. PAIR_RESPONSE gets none: the
   * pairing code's own expiry already bounds how long pairing can wait.
   */
  arm(slot: DeviceSlot, messageType: MultisigMessageType, onTimeout: () => void): void
  /** Stops the slot's timer if it was waiting for this message type. */
  satisfy(slot: DeviceSlot, messageType: MultisigMessageType): void
  disarm(slot: DeviceSlot): void
  disarmAll(): void
}

export function createStepWatchdog(hooks: MockPhoneHooks): StepWatchdog {
  const timers = new Map<DeviceSlot, { messageType: MultisigMessageType; cancel: () => void }>()

  function disarm(slot: DeviceSlot): void {
    timers.get(slot)?.cancel()
    timers.delete(slot)
  }

  return {
    arm(slot, messageType, onTimeout) {
      disarm(slot)
      if (messageType === 'PAIR_RESPONSE') return
      const entry = { messageType, cancel: () => {} }
      timers.set(slot, entry)
      entry.cancel = hooks.schedule(() => {
        // Identity check: hooks whose cancel cannot stop a running timer must not fire a stale one.
        if (timers.get(slot) !== entry) return
        timers.delete(slot)
        onTimeout()
      }, SESSION_STEP_TIMEOUT_MS)
    },
    satisfy(slot, messageType) {
      if (timers.get(slot)?.messageType === messageType) disarm(slot)
    },
    disarm,
    disarmAll() {
      for (const entry of timers.values()) entry.cancel()
      timers.clear()
    }
  }
}

// What an approving phone sends back for each message from the extension. A message missing here
// (DKG_ACTIVATE, for one) gets no reply and leaves the dev-panel setting for a later step.
const REPLY_TYPE: Partial<Record<MultisigMessageType, MultisigMessageType>> = {
  PAIR_INVITE: 'PAIR_RESPONSE',
  ROSTER_LOCK: 'DKG_R1',
  DKG_R1_BUNDLE: 'DKG_R1_ECHO',
  DKG_R1_CERT: 'DKG_R2_BATCH',
  KEYSET_SETUP: 'DKG_FINAL'
}

// The DKG step each coordinator message triggers on the real WASM.
type CeremonyStep = 'rosterLock' | 'round1Bundle' | 'round1Cert' | 'round2Inbox' | 'keysetSetup'

const CEREMONY_STEP: Partial<Record<MultisigMessageType, CeremonyStep>> = {
  ROSTER_LOCK: 'rosterLock',
  DKG_R1_BUNDLE: 'round1Bundle',
  DKG_R1_CERT: 'round1Cert',
  DKG_R2_INBOX: 'round2Inbox',
  KEYSET_SETUP: 'keysetSetup'
}

// Stands in for the protocol data of messages the WASM does not define (none this round, kept for
// the QR path's produce()).
const PLACEHOLDER_PAYLOAD = { mock: true }

function parsePayload(envelope: MultisigEnvelope): unknown {
  try {
    return JSON.parse(envelope.encrypted_payload)
  } catch {
    return null
  }
}

export class MockPhone {
  private readonly slot: 2 | 3
  private readonly session: MockSessionIds
  private readonly hooks: MockPhoneHooks
  private readonly loadVault: (() => Promise<VaultWasm>) | undefined
  private readonly envelopeTo: ReturnType<typeof createEnvelopeFactory>
  private readonly pending = new Set<{ cancel: () => void }>()
  private pairingCode: string | null = null
  private disposed = false
  private dkg: MockPhoneDkg | null = null
  // Ceremony messages are computed one after another, in arrival order.
  private chain: Promise<void> = Promise.resolve()
  private failed = false

  constructor(
    slot: 2 | 3,
    session: MockSessionIds,
    hooks: MockPhoneHooks,
    loadVault?: () => Promise<VaultWasm>
  ) {
    this.slot = slot
    this.session = { groupId: session.groupId, sessionId: session.sessionId }
    this.hooks = hooks
    this.loadVault = loadVault
    this.envelopeTo = createEnvelopeFactory({ ...this.session, senderId: deviceId(slot) })
  }

  /**
   * The code the phone's user reads off the extension screen and types in. The driver hands it
   * over directly because the code must never travel in a message: its only value is that it
   * does not cross the channel.
   */
  setPairingCode(code: string): void {
    this.pairingCode = code
  }

  /** Resolves once every ceremony message received so far has been computed and answered. */
  whenIdle(): Promise<void> {
    return this.chain
  }

  /**
   * Answers a message from the extension according to the slot's next dev-panel response.
   * SESSION_ABORT has no reply type, so it is taken in silently, like a phone leaving the setup.
   * Every answer goes through hooks.schedule, even with no delay: the reducer emits a send before
   * the matching wait, so a reply delivered inside the send would arrive before anyone waits.
   */
  receive(envelope: MultisigEnvelope, emit: (reply: MockPhoneSignal) => void): void {
    if (this.disposed || !this.isAddressedToMe(envelope)) return
    const step = CEREMONY_STEP[envelope.message_type]
    const replyType = REPLY_TYPE[envelope.message_type]
    // The inbox is consumed without an answer, so it never spends a dev-panel response either.
    if (step && !replyType) {
      this.enqueue(step, envelope, null, emit)
      return
    }
    if (!replyType) return

    let code: string | null = null
    if (envelope.message_type === 'PAIR_INVITE') {
      code = this.pairingCode
      // Without a code there is nothing for the phone's user to type, so it cannot answer.
      if (code === null) return
    }

    const response = consumeNextResponse(this.slot)
    switch (response) {
      case 'timeout':
        return
      case 'disconnect':
        this.later(() => emit({ type: 'disconnect' }))
        return
      case 'reject':
        this.later(() => emit(this.abortEnvelope()))
        return
      case 'wrong_code':
      case 'approve': {
        if (code !== null) {
          // A wrong code only means something while pairing; on later steps it answers normally.
          const payload = {
            code: response === 'wrong_code' ? otherPairingCode(code) : code,
            device: MOCK_GUARDIANS[this.slot]
          }
          this.later(() => emit(this.envelopeTo(replyType, deviceId(1), payload)))
          return
        }
        if (step) this.enqueue(step, envelope, replyType, emit)
        return
      }
    }
  }

  /**
   * The reply this phone shows as a QR code for the extension to scan. Over QR there is no live
   * channel, so timeout and disconnect cannot happen and count as approve, and there is no code
   * to get wrong; reject still answers with SESSION_ABORT.
   */
  produce(messageType: MultisigMessageType): MultisigEnvelope {
    if (consumeNextResponse(this.slot) === 'reject') return this.abortEnvelope()
    const payload =
      messageType === 'PAIR_RESPONSE' ? { device: MOCK_GUARDIANS[this.slot] } : PLACEHOLDER_PAYLOAD
    return this.envelopeTo(messageType, deviceId(1), payload)
  }

  dispose(): void {
    this.disposed = true
    for (const entry of this.pending) entry.cancel()
    this.pending.clear()
    this.dkg?.dispose()
    this.dkg = null
  }

  private isAddressedToMe(envelope: MultisigEnvelope): boolean {
    return (
      envelope.group_id === this.session.groupId &&
      envelope.session_id === this.session.sessionId &&
      envelope.recipient_id === deviceId(this.slot)
    )
  }

  private abortEnvelope(): MultisigEnvelope {
    return this.envelopeTo('SESSION_ABORT', deviceId(1), PLACEHOLDER_PAYLOAD)
  }

  // One failure ends this phone's ceremony: it is reported once, and later steps are swallowed,
  // the way a real phone would stop answering after refusing a message.
  private enqueue(
    step: CeremonyStep,
    envelope: MultisigEnvelope,
    replyType: MultisigMessageType | null,
    emit: (reply: MockPhoneSignal) => void
  ): void {
    this.chain = this.chain.then(async () => {
      if (this.disposed || this.failed) return
      try {
        const payload = await this.compute(step, envelope)
        if (replyType && !this.disposed) {
          this.later(() => emit(this.envelopeTo(replyType, deviceId(1), payload)))
        }
      } catch {
        this.failed = true
        if (!this.disposed) this.later(() => emit({ type: 'failed' }))
      }
    })
  }

  private async compute(
    step: CeremonyStep,
    envelope: MultisigEnvelope
  ): Promise<Record<string, unknown> | undefined> {
    const dkg = await this.phoneDkg()
    const payload = parsePayload(envelope)
    switch (step) {
      case 'rosterLock': {
        const lock = parseRosterLockPayload(payload)
        if (!lock) throw new Error('malformed ROSTER_LOCK')
        return dkg.rosterLock(lock)
      }
      case 'round1Bundle': {
        const bundle = parseDkgEnvelopePayload(payload)
        if (!bundle) throw new Error('malformed DKG_R1_BUNDLE')
        return dkg.round1Bundle(bundle)
      }
      case 'round1Cert':
        return dkg.round1Cert()
      case 'round2Inbox': {
        const inbox = parseDkgEnvelopePayload(payload)
        if (!inbox) throw new Error('malformed DKG_R2_INBOX')
        dkg.round2Inbox(inbox)
        return undefined
      }
      case 'keysetSetup': {
        const setup = parseKeysetSetupPayload(payload)
        if (!setup) throw new Error('malformed KEYSET_SETUP')
        return dkg.keysetSetup(setup)
      }
    }
  }

  private async phoneDkg(): Promise<MockPhoneDkg> {
    if (this.dkg) return this.dkg
    if (!this.loadVault) throw new Error('this simulated phone has no wallet WASM')
    const wasm = await this.loadVault()
    if (this.disposed) throw new Error('disposed while loading')
    this.dkg ??= new MockPhoneDkg(wasm)
    return this.dkg
  }

  private later(fn: () => void): void {
    const entry = { cancel: () => {} }
    this.pending.add(entry)
    entry.cancel = this.hooks.schedule(() => {
      this.pending.delete(entry)
      if (!this.disposed) fn()
    }, readMockSettings().delayMs)
  }
}
