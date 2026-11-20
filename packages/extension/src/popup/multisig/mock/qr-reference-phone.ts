/**
 * noir-multisig-mock: a guardian phone on the QR transport, written to the iOS team's spec.
 *
 * It scans the codes the extension shows, checks every envelope the way the phone app does
 * (signature, sequence, round, session parameters, roster), runs its half of the DKG on the real
 * WASM through MockPhoneDkg and offers one signed reply code at a time. Without an iPhone at hand,
 * the Node tests and the dev panel drive the whole QR flow with it.
 */
import {
  parseDkgEnvelopePayload,
  parseKeysetSetupPayload,
  parsePairInvitePayload,
  parseRosterLockPayloadStrict,
  rosterSlotOf,
  type PairInvitePayload,
  type VaultWasm
} from '@/core/multisig/dkg-protocol'
import {
  createEnvelopeSigner,
  verifyEnvelope,
  type EnvelopeSigner
} from '@/core/multisig/envelope-signing'
import {
  generateDeviceIdentity,
  parseIdentityPublicKey,
  type DeviceIdentity
} from '@/core/multisig/identity'
import {
  deviceId,
  parseEnvelope,
  roundOf,
  type MultisigEnvelope,
  type MultisigMessageType
} from '@/core/multisig/messages'
import { rosterHash } from '@/core/multisig/roster'
import { bytesToBase64 } from '@/lib/bytes'
import { MockPhoneDkg } from './mock-phone-dkg'
import { MOCK_GUARDIANS, consumeNextResponse } from './mock-settings'

export type PhoneStage =
  | 'idle'
  | 'invited'
  | 'identity_confirmed'
  | 'ceremony'
  | 'done'
  | 'failed'
  | 'disposed'

export type ScanReport = 'processed' | 'duplicate' | 'not_for_me' | 'rejected_code' | 'aborted'

// Also the marker the build-surface check looks for, so it stays a literal.
const CHECK_FAILED = 'noir-multisig-mock: the reference phone refused the code'

/** Spec 3.5: a code holds one envelope or an array of 1 to 8. */
const MAX_ENVELOPES_PER_CODE = 8
const EXTENSION_ID = deviceId(1)

type Invite = PairInvitePayload & { groupId: string; sessionId: string; ed25519: Uint8Array }

function refuse(): never {
  throw new Error(CHECK_FAILED)
}

function parsePayload(envelope: MultisigEnvelope): unknown {
  try {
    return JSON.parse(envelope.encrypted_payload)
  } catch {
    return null
  }
}

function canonicalIdentity(value: string): string | null {
  const parsed = parseIdentityPublicKey(value)
  return parsed ? bytesToBase64(parsed.bytes) : null
}

export class QrReferencePhone {
  readonly slot: 2 | 3
  private readonly loadVault: () => Promise<VaultWasm>
  private readonly identity: Promise<DeviceIdentity>
  private currentStage: PhoneStage = 'idle'
  private invite: Invite | null = null
  private signer: EnvelopeSigner | null = null
  private dkg: MockPhoneDkg | null = null
  private lastSequence = 0
  private checkedRosterHash: string | null = null
  // JSON of every envelope handled, with the reply it produced (null: none), for spec 3.4 resends.
  private readonly handled = new Map<string, MultisigEnvelope | null>()
  private reply: MultisigEnvelope | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    slot: 2 | 3,
    loadVault: () => Promise<VaultWasm>,
    options: { identity?: DeviceIdentity } = {}
  ) {
    this.slot = slot
    this.loadVault = loadVault
    this.identity = options.identity ? Promise.resolve(options.identity) : generateDeviceIdentity()
    // Awaited where used; a phone that is never scanned must not report an unhandled rejection.
    this.identity.catch(() => {})
  }

  get stage(): PhoneStage {
    return this.currentStage
  }

  /** The roster hash this phone recomputed from an accepted ROSTER_LOCK, as its screen shows it. */
  rosterHashSeen(): string | null {
    return this.checkedRosterHash
  }

  async identityPublicKey(): Promise<string> {
    return bytesToBase64((await this.identity).publicKey)
  }

  /** Steps run one at a time, in call order: the WASM work in between is asynchronous. */
  scan(content: MultisigEnvelope | readonly MultisigEnvelope[]): Promise<ScanReport> {
    return this.enqueue(() => this.handleCode(content))
  }

  /** The code the phone shows now; it stays until a later scan replaces it. */
  nextCode(): MultisigEnvelope | null {
    return this.reply
  }

  confirmIdentity(): void {
    void this.enqueue(async () => {
      if (this.currentStage === 'invited') this.currentStage = 'identity_confirmed'
    })
  }

  /** The owner saw a different fingerprint: the phone ends the ceremony and tells the extension. */
  rejectIdentity(): void {
    void this.enqueue(async () => {
      if (this.currentStage !== 'invited') return
      try {
        const abort = await this.abortReply()
        // Read through the getter: the stage may have changed to disposed during the await.
        if (this.stage !== 'disposed') this.reply = abort
      } catch {
        this.fail()
      }
    })
  }

  /** Resolves once every scan and confirmation issued so far has been handled. */
  async settled(): Promise<void> {
    await this.queue
  }

  dispose(): void {
    if (this.currentStage === 'disposed') return
    this.currentStage = 'disposed'
    this.dkg?.dispose()
    this.dkg = null
    this.handled.clear()
    this.reply = null
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work)
    this.queue = run.catch(() => {})
    return run
  }

  private ended(): boolean {
    return this.currentStage === 'failed' || this.currentStage === 'disposed'
  }

  private async handleCode(
    content: MultisigEnvelope | readonly MultisigEnvelope[]
  ): Promise<ScanReport> {
    if (this.ended()) return 'aborted'
    const list: readonly unknown[] = Array.isArray(content) ? content : [content]
    if (Array.isArray(content)) {
      // Invites are made per phone, so a phone that has none yet only takes a single envelope.
      if (this.currentStage === 'idle') return 'rejected_code'
      if (list.length === 0 || list.length > MAX_ENVELOPES_PER_CODE) return 'rejected_code'
    }
    const envelopes: MultisigEnvelope[] = []
    for (const value of list) {
      const envelope = parseEnvelope(value)
      if (!envelope) return 'rejected_code'
      envelopes.push(envelope)
    }
    const own = deviceId(this.slot)
    const mine = [
      ...new Map(
        envelopes
          .filter(envelope => envelope.recipient_id === own)
          .map(envelope => [JSON.stringify(envelope), envelope] as const)
      )
    ]
    if (mine.length === 0) return 'not_for_me'
    if (this.currentStage === 'idle' && mine[0][1].message_type !== 'PAIR_INVITE') {
      return 'rejected_code'
    }

    let processed = false
    let earlierReply: MultisigEnvelope | null | undefined
    for (const [json, envelope] of mine) {
      if (this.handled.has(json)) {
        earlierReply = this.handled.get(json) ?? earlierReply
        continue
      }
      try {
        const reply = await this.handleEnvelope(envelope)
        if (this.currentStage === 'disposed') return 'aborted'
        this.handled.set(json, reply)
        this.reply = reply
        processed = true
      } catch {
        this.fail()
        return 'aborted'
      }
      if (this.ended()) return 'processed'
    }
    if (processed) return 'processed'
    // Spec 3.4: a resent code changes nothing and shows the reply it got the first time.
    this.reply = earlierReply ?? null
    return 'duplicate'
  }

  private fail(): void {
    if (this.currentStage === 'disposed') return
    this.currentStage = 'failed'
    this.reply = null
    this.dkg?.dispose()
    this.dkg = null
  }

  /** Spec 3.3: any failed check throws, and the caller ends the ceremony. */
  private async verify(envelope: MultisigEnvelope, ed25519: Uint8Array, invite: Invite) {
    if (envelope.group_id !== invite.groupId || envelope.session_id !== invite.sessionId) refuse()
    if (envelope.sender_id !== EXTENSION_ID || envelope.recipient_id !== deviceId(this.slot)) {
      refuse()
    }
    if (envelope.round !== roundOf(envelope.message_type)) refuse()
    if (envelope.sequence <= this.lastSequence) refuse()
    // Also recomputes payload_hash.
    if (!(await this.alive(verifyEnvelope(envelope, ed25519)))) refuse()
    this.lastSequence = envelope.sequence
  }

  private async handleEnvelope(envelope: MultisigEnvelope): Promise<MultisigEnvelope | null> {
    if (envelope.message_type === 'PAIR_INVITE') return this.acceptInvite(envelope)
    const invite = this.invite ?? refuse()
    await this.alive(this.verify(envelope, invite.ed25519, invite))
    switch (envelope.message_type) {
      case 'ROSTER_LOCK':
        return this.acceptRosterLock(envelope, invite)
      case 'DKG_R1_BUNDLE': {
        const payload = parseDkgEnvelopePayload(parsePayload(envelope)) ?? refuse()
        return this.respond('DKG_R1_ECHO', async dkg => dkg.round1Bundle(payload))
      }
      case 'DKG_R1_CERT':
        return this.respond('DKG_R2_BATCH', async dkg => dkg.round1Cert())
      case 'DKG_R2_INBOX': {
        const payload = parseDkgEnvelopePayload(parsePayload(envelope)) ?? refuse()
        this.ceremonyDkg().round2Inbox(payload)
        return null
      }
      case 'KEYSET_SETUP': {
        const payload = parseKeysetSetupPayload(parsePayload(envelope)) ?? refuse()
        const reply = await this.alive(
          this.respond('DKG_FINAL', async dkg => dkg.keysetSetup(payload))
        )
        if (!this.ended()) this.currentStage = 'done'
        return reply
      }
      // An abort from the extension, or anything the extension never sends to a phone.
      default:
        refuse()
    }
  }

  private async acceptInvite(envelope: MultisigEnvelope): Promise<MultisigEnvelope> {
    if (this.currentStage !== 'idle') refuse()
    const payload = parsePairInvitePayload(parsePayload(envelope)) ?? refuse()
    const identity = canonicalIdentity(payload.identityPublicKey) ?? refuse()
    if (payload.rosterSlot !== rosterSlotOf(this.slot)) refuse()
    if (envelope.recipient_id !== `device-${payload.rosterSlot + 1}`) refuse()
    const key = parseIdentityPublicKey(identity) ?? refuse()
    const invite: Invite = {
      ...payload,
      identityPublicKey: identity,
      groupId: envelope.group_id,
      sessionId: envelope.session_id,
      ed25519: key.ed25519
    }
    // Self-signed: this proves possession of the key only; the fingerprint check proves whose.
    await this.alive(this.verify(envelope, key.ed25519, invite))
    this.invite = invite
    this.signer = createEnvelopeSigner({
      groupId: invite.groupId,
      sessionId: invite.sessionId,
      senderId: deviceId(this.slot),
      signingKey: (await this.alive(this.identity)).signingKeys.privateKey
    })
    this.currentStage = 'invited'
    if (consumeNextResponse(this.slot) === 'reject') return this.abortReply()
    return this.sign('PAIR_RESPONSE', {
      identityPublicKey: await this.alive(this.identityPublicKey()),
      device: MOCK_GUARDIANS[this.slot]
    })
  }

  /** Spec 6.2, item by item. */
  private async acceptRosterLock(
    envelope: MultisigEnvelope,
    invite: Invite
  ): Promise<MultisigEnvelope> {
    if (this.currentStage !== 'identity_confirmed') refuse()
    const lock = parseRosterLockPayloadStrict(parsePayload(envelope)) ?? refuse()
    const { roster } = lock
    if (
      lock.dkgSessionId !== invite.dkgSessionId ||
      lock.participants !== invite.participants ||
      lock.threshold !== invite.threshold ||
      lock.rosterSlot !== invite.rosterSlot ||
      lock.mainnet !== invite.mainnet
    ) {
      refuse()
    }
    if (roster.groupId !== envelope.group_id || roster.threshold !== lock.threshold) refuse()
    if (roster.participants.length !== lock.participants) refuse()
    if (roster.participants.some((participant, index) => participant.slot !== index)) refuse()
    if (roster.participants[0].identityPublicKey !== invite.identityPublicKey) refuse()
    const ownEntry = roster.participants[lock.rosterSlot]
    if (ownEntry?.identityPublicKey !== (await this.alive(this.identityPublicKey()))) refuse()
    const recomputed = rosterHash(roster)
    if (recomputed !== roster.rosterHash) refuse()
    this.checkedRosterHash = recomputed

    if (consumeNextResponse(this.slot) === 'reject') return this.abortReply()
    const wasm = await this.alive(this.loadVault())
    // Created only after the last await, so a phone disposed meanwhile never holds a DKG.
    const dkg = new MockPhoneDkg(wasm)
    this.dkg = dkg
    const round1 = dkg.rosterLock({
      dkgSessionId: lock.dkgSessionId,
      participants: lock.participants,
      threshold: lock.threshold,
      rosterSlot: lock.rosterSlot,
      mainnet: lock.mainnet
    })
    this.currentStage = 'ceremony'
    return this.sign('DKG_R1', round1)
  }

  private ceremonyDkg(): MockPhoneDkg {
    if (this.currentStage !== 'ceremony' || !this.dkg) refuse()
    return this.dkg
  }

  /** A DKG step that answers: the dev panel decides once per step whether the phone refuses. */
  private async respond(
    replyType: MultisigMessageType,
    run: (dkg: MockPhoneDkg) => Promise<Record<string, unknown>>
  ): Promise<MultisigEnvelope> {
    const dkg = this.ceremonyDkg()
    // 'timeout', 'disconnect' and 'wrong_code' mean nothing on a QR step: they answer as approve.
    if (consumeNextResponse(this.slot) === 'reject') return this.abortReply()
    return this.sign(replyType, await this.alive(run(dkg)))
  }

  private async abortReply(): Promise<MultisigEnvelope> {
    const abort = await this.alive(this.sign('SESSION_ABORT', {}))
    this.fail()
    return abort
  }

  private sign(
    messageType: MultisigMessageType,
    payload: Record<string, unknown>
  ): Promise<MultisigEnvelope> {
    const signer = this.signer ?? refuse()
    return this.alive(signer.next(messageType, EXTENSION_ID, payload))
  }

  /**
   * Every await inside a step goes through here: dispose() does not wait for the queue, so a step
   * that resumes after it must stop before it touches the phone's state again.
   */
  private async alive<T>(pending: Promise<T>): Promise<T> {
    const value = await pending
    if (this.currentStage === 'disposed') refuse()
    return value
  }
}
