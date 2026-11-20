/**
 * noir-multisig-mock: one simulated phone's half of the DKG, on the real WASM.
 *
 * Mirrors what the Guardian app will do with the same package: hold its own `Dkg` object, answer
 * each coordinator message with the next protocol step, and check every coordinator envelope
 * itself (session, sender, recipient, type, sequence) before trusting its payload. The payloads
 * crossing in and out are the interim message contents from `dkg-protocol.ts`, so the mock
 * transport can carry them unchanged.
 */
import { base64ToBytes, bytesToBase64, bytesToHex } from '@/lib/bytes'
import {
  SecretBin,
  round1Hash,
  type DkgEnvelopePayload,
  type DkgFinalPayload,
  type KeysetSetupPayload,
  type RosterLockPayload,
  type Round1EchoPayload,
  type VaultWasm
} from '@/core/multisig/dkg-protocol'

type Dkg = InstanceType<VaultWasm['Dkg']>
type MessageSet = InstanceType<VaultWasm['MessageSet']>

// Each step is only valid once, in protocol order; a failed check ends the phone's ceremony.
type Stage = 'idle' | 'round1' | 'bundled' | 'round2' | 'finalized' | 'done' | 'failed' | 'disposed'

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index])
}

export class MockPhoneDkg {
  private stage: Stage = 'idle'
  private sessionId: Uint8Array | null = null
  private rosterSlot = -1
  private mainnet = true
  private lastSequence = 0
  private dkg: Dkg | null = null
  private dkg1: ReturnType<Dkg['part1']> | null = null
  private dkg2: ReturnType<Dkg['part2']> | null = null
  private dkg3: ReturnType<Dkg['part3']> | null = null
  private broadcasts: MessageSet | null = null
  private round1Secret: Uint8Array | null = null
  private round2Secret: Uint8Array | null = null
  private staticSecret: Uint8Array | null = null
  private owned: { free(): void }[] = []

  constructor(
    private readonly wasm: VaultWasm,
    private readonly bin: SecretBin = new SecretBin()
  ) {}

  rosterLock(payload: RosterLockPayload): DkgEnvelopePayload {
    return this.step('idle', 'round1', () => {
      this.sessionId = base64ToBytes(payload.dkgSessionId)
      this.rosterSlot = payload.rosterSlot
      this.mainnet = payload.mainnet
      this.dkg = this.own(
        new this.wasm.Dkg(
          payload.participants,
          payload.threshold,
          payload.rosterSlot,
          this.sessionId
        )
      )
      this.dkg1 = this.own(this.dkg.part1())
      this.round1Secret = this.bin.keep(this.dkg1.secret())
      return {
        envelope: bytesToBase64(this.dkg1.broadcast_envelope(this.sessionId, 1, payload.rosterSlot))
      }
    })
  }

  async round1Bundle(payload: DkgEnvelopePayload): Promise<Round1EchoPayload> {
    return this.stepAsync('round1', 'bundled', async () => {
      const set = this.own(
        this.wasm.MessageSet.from_bytes(this.openFromCoordinator(payload.envelope, 'dkgR1Bundle'))
      )
      // The coordinator may relay, never rewrite: this phone's own entry must be byte-identical.
      const mine = set.get(this.rosterSlot)
      if (!mine || !this.dkg1 || !sameBytes(mine, this.dkg1.broadcast())) {
        throw new Error("round-1 set does not carry this phone's own broadcast")
      }
      this.broadcasts = set
      return { round1Hash: await round1Hash(set.to_bytes()) }
    })
  }

  round1Cert(): DkgEnvelopePayload {
    return this.step('bundled', 'round2', () => {
      if (!this.dkg || !this.broadcasts || !this.round1Secret || !this.sessionId) {
        throw new Error('round 1 is not complete')
      }
      this.dkg2 = this.own(this.dkg.part2(this.round1Secret, this.broadcasts))
      this.round2Secret = this.bin.keep(this.dkg2.secret())
      return {
        envelope: bytesToBase64(this.dkg2.outgoing_envelope(this.sessionId, 2, this.rosterSlot))
      }
    })
  }

  round2Inbox(payload: DkgEnvelopePayload): void {
    this.step('round2', 'finalized', () => {
      const incoming = this.wasm.MessageSet.from_bytes(
        this.openFromCoordinator(payload.envelope, 'dkgR2Inbox')
      )
      try {
        if (!this.dkg || !this.broadcasts || !this.round2Secret) {
          throw new Error('round 2 is not complete')
        }
        this.dkg3 = this.own(this.dkg.part3(this.round2Secret, this.broadcasts, incoming))
      } finally {
        incoming.free()
      }
      this.staticSecret = this.bin.keep(this.dkg3.static_secret())
    })
  }

  keysetSetup(payload: KeysetSetupPayload): DkgFinalPayload {
    return this.step('finalized', 'done', () => {
      if (!this.dkg3 || !this.staticSecret) throw new Error('round 3 is not complete')
      // Keys and prologue come from this phone's own view of the roster, never from the message.
      const statics = this.dkg3.statics()
      try {
        const coordinatorKey = statics.get(0)
        if (!coordinatorKey) throw new Error('no coordinator static key')
        const qsk = this.bin.keep(
          this.wasm.Sealed.open(
            this.staticSecret,
            coordinatorKey,
            this.wasm.Sealed.prologue(statics),
            base64ToBytes(payload.sealedQsk)
          )
        )
        const keyset: unknown[] = this.wasm.Keyset.derive(
          this.dkg3.group_verifying_key(),
          qsk,
          this.mainnet,
          0
        )
        const fingerprint = keyset[4]
        if (!(fingerprint instanceof Uint8Array)) throw new Error('unexpected keyset output')
        return { fingerprint: bytesToHex(fingerprint) }
      } finally {
        statics.free()
      }
    })
  }

  dispose(): void {
    if (this.stage === 'disposed') return
    this.stage = 'disposed'
    this.bin.wipe()
    const owned = this.owned
    this.owned = []
    for (const object of owned) object.free()
    this.dkg = this.dkg1 = this.dkg2 = this.dkg3 = null
    this.broadcasts = null
    this.round1Secret = this.round2Secret = this.staticSecret = null
  }

  private own<T extends { free(): void }>(object: T): T {
    this.owned.push(object)
    return object
  }

  private step<T>(from: Stage, to: Stage, run: () => T): T {
    if (this.stage !== from) throw new Error(`cannot run this step while ${this.stage}`)
    try {
      const value = run()
      this.stage = to
      return value
    } catch (error) {
      this.stage = 'failed'
      throw error
    }
  }

  private async stepAsync<T>(from: Stage, to: Stage, run: () => Promise<T>): Promise<T> {
    if (this.stage !== from) throw new Error(`cannot run this step while ${this.stage}`)
    try {
      const value = await run()
      this.stage = to
      return value
    } catch (error) {
      this.stage = 'failed'
      throw error
    }
  }

  /** What DkgRelay.accept checks on the coordinator, done here for messages going the other way. */
  private openFromCoordinator(
    envelope: string,
    expected: 'dkgR1Bundle' | 'dkgR2Inbox'
  ): Uint8Array {
    const decoded: unknown[] = this.wasm.EnvelopeCodec.decode(base64ToBytes(envelope))
    const [msgType, , sender, recipient, sequence, sessionId, payload] = decoded
    if (
      typeof msgType !== 'number' ||
      typeof sender !== 'number' ||
      typeof recipient !== 'number' ||
      typeof sequence !== 'number' ||
      !(sessionId instanceof Uint8Array) ||
      !(payload instanceof Uint8Array)
    ) {
      throw new Error('unexpected envelope shape')
    }
    if (!this.sessionId || !sameBytes(sessionId, this.sessionId)) {
      throw new Error('envelope belongs to another session')
    }
    if (sender !== this.wasm.EnvelopeCodec.coordinator_slot) {
      throw new Error('envelope is not from the coordinator')
    }
    if (recipient !== this.rosterSlot) throw new Error('envelope is for another phone')
    if (msgType !== this.wasm.EnvelopeCodec.msg_type(expected)) {
      throw new Error('unexpected message type')
    }
    if (sequence <= this.lastSequence) throw new Error('replayed or out-of-order envelope')
    this.lastSequence = sequence
    return payload
  }
}
