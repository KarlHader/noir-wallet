/**
 * The coordinator's side of one DKG ceremony, at the byte level: the extension's own share (roster
 * slot 0) plus the relay that validates and forwards what the phones send. Runs wherever the WASM
 * is injected (the Zcash Worker in the extension, plain Node in tests) and never touches the
 * transport or `chrome.*`.
 *
 * Key material (round secrets, the static secret, the qsk) stays inside this object and is wiped
 * on close. Of everything the methods return, only the sealed vault record contains the share,
 * and only encrypted.
 */
import { bytesToBase64, bytesToHex } from '@/lib/bytes'
import {
  SecretBin,
  round1Hash,
  isDkgShape,
  parseDkgEnvelopePayload,
  parseRound1EchoPayload,
  parseDkgFinalPayload,
  type DkgShape,
  type VaultWasm
} from './dkg-protocol'
import { deviceId, parseEnvelope, type MultisigEnvelope } from './messages'
import { createInboundGate, type InboundGate } from './inbound-gate'
import type { RosterManifest } from './roster'
import type { DeviceSlot } from './types'
import {
  openVaultRecord,
  sealVaultRecord,
  parseVaultRecordBinding,
  isVaultGroupId,
  isVaultWalletId,
  type VaultRecordBinding,
  type SealedVaultRecord,
  type VaultRecordHeader
} from './vault-record'

/** The wallet's mnemonic, which seals the record; throws when the wallet is not unlocked. */
export type MnemonicResolver = (walletId: string) => string

export type DkgCoordinatorConfig = DkgShape & {
  mainnet: boolean
  walletId: string
  groupId: string
  binding?: VaultRecordBinding
  outerSessionId?: string
}

export type CreationEvidence = { outerSessionId: string; confirmations: MultisigEnvelope[] }

export function isOuterSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

function payloadOf(envelope: MultisigEnvelope): unknown {
  try {
    return JSON.parse(envelope.encrypted_payload)
  } catch {
    return null
  }
}

function rosterGate(roster: RosterManifest, sessionId: string): InboundGate {
  const own = roster.participants.find(peer => peer.slot === 0)
  if (!own) throw new Error('Invalid DKG roster')
  const peers = roster.participants.filter(peer => peer.slot !== 0)
  const gate = createInboundGate({
    groupId: roster.groupId,
    sessionId,
    ownIdentityPublicKey: own.identityPublicKey,
    slots: peers.map(peer => (peer.slot + 1) as DeviceSlot)
  })
  for (const peer of peers) gate.registerPeer((peer.slot + 1) as DeviceSlot, peer.identityPublicKey)
  return gate
}

/** Uses the same pinned identity and canonical wire checks as live contribution ingress. */
export async function verifyCreationConfirmations(
  roster: RosterManifest,
  fingerprint: string,
  evidence: CreationEvidence
): Promise<void> {
  if (
    !isOuterSessionId(evidence.outerSessionId) ||
    evidence.confirmations.length !== roster.participants.length - 1
  )
    throw new Error('Invalid DKG final confirmations')
  const gate = rosterGate(roster, evidence.outerSessionId)
  const accepted = new Set<number>()
  for (const candidate of evidence.confirmations) {
    const envelope = parseEnvelope(candidate)
    if (!envelope || envelope.message_type !== 'DKG_FINAL')
      throw new Error('Invalid DKG final confirmation')
    const payload = parseDkgFinalPayload(payloadOf(envelope))
    if (!payload || payload.fingerprint !== fingerprint) throw new Error('DKG fingerprint mismatch')
    const result = await gate.check(envelope)
    if (result.kind !== 'accept' || accepted.has(result.slot))
      throw new Error('Invalid DKG final authentication')
    accepted.add(result.slot)
  }
}

export type Round1Outcome = { round1Hash: string; bundles: ReadonlyMap<number, Uint8Array> }

export type Round2Outcome = {
  fingerprint: string
  inboxes: ReadonlyMap<number, Uint8Array>
  sealedQsk: ReadonlyMap<number, Uint8Array>
  record: SealedVaultRecord
}

export type AcceptOutcome<T> = { complete: false } | ({ complete: true } & T)

type Dkg = InstanceType<VaultWasm['Dkg']>
// Dkg1/2/3 have private constructors, so their types come from the calls that produce them.
type Dkg1 = ReturnType<Dkg['part1']>
type DkgRelay = InstanceType<VaultWasm['DkgRelay']>
type MessageSet = InstanceType<VaultWasm['MessageSet']>

const CLOSED = 'DKG session is closed'

/** What the synchronous WASM part of round 2 hands to the asynchronous sealing part. */
type Prepared = {
  outcome: Omit<Round2Outcome, 'record'>
  header: VaultRecordHeader
  share: Uint8Array
  keyPackage: Uint8Array
}

const encoder = new TextEncoder()

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index])
}

function sameHeader(a: VaultRecordHeader, b: VaultRecordHeader): boolean {
  function sameValue(left: unknown, right: unknown): boolean {
    if (left === right) return true
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
    if (Array.isArray(left) !== Array.isArray(right)) return false
    const l = left as Record<string, unknown>
    const r = right as Record<string, unknown>
    const keys = Object.keys(l)
    return (
      keys.length === Object.keys(r).length &&
      keys.every(key => Object.prototype.hasOwnProperty.call(r, key) && sameValue(l[key], r[key]))
    )
  }
  return sameValue(a, b)
}

interface OpenedState {
  relay: DkgRelay
  dkg: Dkg
  dkg1: Dkg1
  round1Secret: Uint8Array
  broadcasts: MessageSet
  /** One inbox per roster slot, the coordinator's own at 0. */
  inboxes: Map<number, MessageSet>
}

export class DkgCoordinatorSession {
  readonly sessionId: Uint8Array
  private state: OpenedState | null
  private readonly accepted1 = new Set<number>()
  private readonly accepted2 = new Set<number>()
  private round1Complete = false
  private round1Digest: string | null = null
  private readonly confirmed1 = new Set<number>()
  private readonly gate: InboundGate | null
  private pending: Promise<void> = Promise.resolve()

  private constructor(
    private readonly wasm: VaultWasm,
    private readonly config: DkgCoordinatorConfig,
    private readonly resolveMnemonic: MnemonicResolver,
    private readonly bin: SecretBin,
    sessionId: Uint8Array,
    state: OpenedState
  ) {
    this.sessionId = sessionId
    this.state = state
    this.gate = config.binding ? rosterGate(config.binding.roster, config.outerSessionId!) : null
  }

  static open(
    wasm: VaultWasm,
    config: DkgCoordinatorConfig,
    resolveMnemonic: MnemonicResolver,
    bin: SecretBin = new SecretBin(),
    sessionId: Uint8Array = wasm.EnvelopeCodec.new_session_id()
  ): DkgCoordinatorSession {
    // Checked before any wasm object exists, so a refusal leaks nothing.
    if (sessionId.length !== 16) throw new Error('session id must be 16 bytes')
    sessionId = sessionId.slice()
    if (
      !isDkgShape(config) ||
      typeof config.mainnet !== 'boolean' ||
      !isVaultGroupId(config.groupId) ||
      !isVaultWalletId(config.walletId)
    )
      throw new Error('Invalid vault DKG configuration')
    const binding =
      config.binding === undefined ? undefined : parseVaultRecordBinding(config.binding)
    if (
      binding === null ||
      (binding &&
        (!isOuterSessionId(config.outerSessionId) ||
          binding.roster.groupId !== config.groupId ||
          binding.roster.threshold !== config.threshold ||
          binding.roster.participants.length !== config.participants))
    ) {
      throw new Error('Invalid vault DKG binding')
    }
    config = Object.freeze({ ...config, ...(binding ? { binding } : {}) })
    const relay = new wasm.DkgRelay(sessionId, config.participants)
    const dkg = new wasm.Dkg(config.participants, config.threshold, 0, sessionId)
    const dkg1 = dkg.part1()
    const broadcasts = new wasm.MessageSet()
    broadcasts.set(0, dkg1.broadcast())
    const inboxes = new Map<number, MessageSet>()
    for (let slot = 0; slot < config.participants; slot += 1) {
      inboxes.set(slot, new wasm.MessageSet())
    }
    return new DkgCoordinatorSession(wasm, config, resolveMnemonic, bin, sessionId, {
      relay,
      dkg,
      dkg1,
      round1Secret: bin.keep(dkg1.secret()),
      broadcasts,
      inboxes
    })
  }

  get closed(): boolean {
    return this.state === null
  }

  async acceptRound1(
    senderSlot: number,
    envelope: Uint8Array,
    signedEnvelope?: MultisigEnvelope
  ): Promise<AcceptOutcome<Round1Outcome>> {
    const bytes = envelope.slice()
    const signed = parseEnvelope(signedEnvelope)
    return this.serialized(() => this.acceptRound1Now(senderSlot, bytes, signed))
  }

  private async acceptRound1Now(
    senderSlot: number,
    envelope: Uint8Array,
    signed: MultisigEnvelope | null
  ): Promise<AcceptOutcome<Round1Outcome>> {
    const state = this.open()
    try {
      await this.authenticate('DKG_R1', senderSlot, envelope, signed)
      if (this.round1Complete) throw new Error('round 1 is already complete')
      const [sender, payload] = this.accept(state.relay, envelope, 'dkgR1', senderSlot)
      if (this.accepted1.has(sender)) throw new Error('duplicate round-1 envelope')
      this.accepted1.add(sender)
      state.broadcasts.set(sender, payload)
      if (this.accepted1.size < this.peerCount) return { complete: false }

      this.round1Complete = true
      const hash = await round1Hash(state.broadcasts.to_bytes())
      this.open()
      this.round1Digest = hash
      const bundles = new Map<number, Uint8Array>()
      for (const slot of this.peerSlots()) {
        bundles.set(slot, state.relay.bundle(1, slot, state.broadcasts))
      }
      return { complete: true, round1Hash: hash, bundles }
    } catch (error) {
      this.close()
      throw error
    }
  }

  async acceptRound2(
    senderSlot: number,
    envelope: Uint8Array,
    signedEnvelope?: MultisigEnvelope
  ): Promise<AcceptOutcome<Round2Outcome>> {
    const bytes = envelope.slice()
    const signed = parseEnvelope(signedEnvelope)
    return this.serialized(() => this.acceptRound2Now(senderSlot, bytes, signed))
  }

  private async acceptRound2Now(
    senderSlot: number,
    envelope: Uint8Array,
    signed: MultisigEnvelope | null
  ): Promise<AcceptOutcome<Round2Outcome>> {
    const state = this.open()
    try {
      if (!this.round1Complete) throw new Error('round 1 is not complete')
      if (this.gate && this.confirmed1.size !== this.peerCount)
        throw new Error('round 1 confirmations are incomplete')
      await this.authenticate('DKG_R2_BATCH', senderSlot, envelope, signed)
      const [sender, batchBytes] = this.accept(state.relay, envelope, 'dkgR2Batch', senderSlot)
      if (this.accepted2.has(sender)) throw new Error('duplicate round-2 envelope')
      this.accepted2.add(sender)
      this.sortIntoInboxes(state, sender, batchBytes)
      if (this.accepted2.size < this.peerCount) return { complete: false }
      return { complete: true, ...(await this.finish(state)) }
    } catch (error) {
      this.close()
      throw error
    }
  }

  async confirmRound1(signedEnvelope: MultisigEnvelope): Promise<void> {
    const signed = parseEnvelope(signedEnvelope)
    return this.serialized(async () => {
      this.open()
      if (!this.gate || !this.round1Digest || !signed || signed.message_type !== 'DKG_R1_ECHO')
        throw new Error('Invalid round 1 confirmation')
      const payload = parseRound1EchoPayload(payloadOf(signed))
      if (!payload || payload.round1Hash !== this.round1Digest)
        throw new Error('round 1 hash mismatch')
      const result = await this.gate.check(signed)
      this.open()
      if (result.kind !== 'accept' || this.confirmed1.has(result.slot - 1))
        throw new Error('Invalid round 1 authentication')
      this.confirmed1.add(result.slot - 1)
    })
  }

  private serialized<T>(run: () => Promise<T>): Promise<T> {
    const result = this.pending.then(run).catch((error: unknown) => {
      this.close()
      throw error
    })
    this.pending = result.then(
      () => {},
      () => {}
    )
    return result
  }

  private async authenticate(
    type: 'DKG_R1' | 'DKG_R2_BATCH',
    senderSlot: number,
    bytes: Uint8Array,
    signed: MultisigEnvelope | null
  ): Promise<void> {
    if (!this.gate) return
    if (!signed || signed.message_type !== type) throw new Error('Signed DKG contribution required')
    const payload = parseDkgEnvelopePayload(payloadOf(signed))
    if (!payload || payload.envelope !== bytesToBase64(bytes))
      throw new Error('Signed DKG inner envelope mismatch')
    const result = await this.gate.check(signed)
    this.open()
    if (result.kind !== 'accept' || result.slot - 1 !== senderSlot)
      throw new Error('Invalid DKG contribution authentication')
  }

  close(): void {
    const state = this.state
    if (!state) return
    this.state = null
    this.bin.wipe()
    // Each WASM object is freed exactly once; a second free of a wasm-bindgen handle aborts.
    for (const inbox of state.inboxes.values()) inbox.free()
    state.broadcasts.free()
    state.dkg1.free()
    state.dkg.free()
    state.relay.free()
  }

  private open(): OpenedState {
    if (!this.state) throw new Error(CLOSED)
    return this.state
  }

  private get peerCount(): number {
    return this.config.participants - 1
  }

  private peerSlots(): number[] {
    const slots: number[] = []
    for (let slot = 1; slot < this.config.participants; slot += 1) slots.push(slot)
    return slots
  }

  /**
   * The relay checks session, recipient, type, roster and sequence. The transport's own idea of
   * who sent the envelope is checked here, so a phone cannot speak for another slot.
   */
  private accept(
    relay: DkgRelay,
    envelope: Uint8Array,
    expected: 'dkgR1' | 'dkgR2Batch',
    senderSlot: number
  ): [number, Uint8Array] {
    if (!this.peerSlots().includes(senderSlot)) throw new Error('sender slot is not a phone')
    const accepted: unknown[] = relay.accept(envelope, expected)
    const [sender, payload] = accepted
    if (
      !Array.isArray(accepted) ||
      accepted.length !== 2 ||
      typeof sender !== 'number' ||
      !(payload instanceof Uint8Array)
    ) {
      throw new Error('unexpected relay output')
    }
    if (sender !== senderSlot) throw new Error('envelope sender does not match the transport slot')
    return [sender, payload]
  }

  private sortIntoInboxes(state: OpenedState, sender: number, batchBytes: Uint8Array): void {
    const batch = this.wasm.MessageSet.from_bytes(batchBytes)
    try {
      for (const recipient of batch.slots()) {
        const inbox = state.inboxes.get(recipient)
        const pkg = batch.get(recipient)
        if (!inbox || !pkg) throw new Error('round-2 package addressed outside the roster')
        inbox.set(sender, pkg)
      }
    } finally {
      batch.free()
    }
  }

  /**
   * Spec §5.2: own round 2 and 3, a fresh qsk, then one inbox and one sealed qsk per phone; and
   * the extension's own share, sealed into a vault record under the wallet's mnemonic.
   */
  private async finish(state: OpenedState): Promise<Round2Outcome> {
    const { outcome, header, share, keyPackage } = this.derive(state)
    try {
      const mnemonic = this.resolveMnemonic(this.config.walletId)
      const record = await sealVaultRecord(header, share, mnemonic)
      if (this.closed) throw new Error(CLOSED)
      // Read back before handing the record out: one that cannot be opened would lose the share.
      const opened = await openVaultRecord(record, mnemonic)
      try {
        if (this.closed) throw new Error(CLOSED)
        if (!sameHeader(opened.header, header) || !sameBytes(opened.share, share)) {
          throw new Error('sealed vault record does not read back')
        }
      } finally {
        opened.share.fill(0)
      }
      return { ...outcome, record }
    } catch (error) {
      // A close() during an await wiped the share mid-flight; whatever failed, that is the cause.
      throw this.closed ? new Error(CLOSED) : error
    } finally {
      share.fill(0)
      keyPackage.fill(0)
    }
  }

  /**
   * Every WASM call of round 2, done before the first await: a close() during the sealing awaits
   * frees the state's WASM objects, so nothing after this may touch them.
   */
  private derive(state: OpenedState): Prepared {
    const { wasm, bin, config } = this
    const temporaries: { free(): void }[] = []
    try {
      const dkg2 = state.dkg.part2(state.round1Secret, state.broadcasts)
      temporaries.push(dkg2)
      const round2Secret = bin.keep(dkg2.secret())
      const outgoing = dkg2.outgoing()
      temporaries.push(outgoing)
      for (const recipient of outgoing.slots()) {
        const inbox = state.inboxes.get(recipient)
        const pkg = outgoing.get(recipient)
        if (!inbox || !pkg) throw new Error('own round-2 package addressed outside the roster')
        inbox.set(0, pkg)
      }

      const ownInbox = state.inboxes.get(0)
      if (!ownInbox) throw new Error('missing own inbox')
      const dkg3 = state.dkg.part3(round2Secret, state.broadcasts, ownInbox)
      temporaries.push(dkg3)
      const staticSecret = bin.keep(dkg3.static_secret())
      const statics = dkg3.statics()
      temporaries.push(statics)
      const prologue = wasm.Sealed.prologue(statics)
      const qsk = bin.keep(wasm.Keyset.generate_qsk())
      const groupKey = dkg3.group_verifying_key()
      const keyPackage = bin.keep(dkg3.key_package())
      const publicKeyPackage = dkg3.public_key_package()

      const inboxes = new Map<number, Uint8Array>()
      const sealedQsk = new Map<number, Uint8Array>()
      for (const slot of this.peerSlots()) {
        const inbox = state.inboxes.get(slot)
        const peerKey = statics.get(slot)
        if (!inbox || !peerKey) throw new Error(`no round-2 material for slot ${slot}`)
        inboxes.set(slot, state.relay.bundle(2, slot, inbox))
        sealedQsk.set(slot, wasm.Sealed.seal(staticSecret, peerKey, prologue, qsk))
      }

      const keyset: unknown[] = wasm.Keyset.derive(groupKey, qsk, config.mainnet, 0)
      const [fvk, ufvk, address, , fingerprint] = keyset
      if (
        !(fvk instanceof Uint8Array) ||
        typeof ufvk !== 'string' ||
        typeof address !== 'string' ||
        !(fingerprint instanceof Uint8Array)
      ) {
        throw new Error('unexpected keyset output')
      }
      if (!wasm.Keyset.address_is_shielded_only(address)) {
        throw new Error('derived address is not shielded-only')
      }

      // Roster slot 0 is the extension's own; the device id is a placeholder until devices have
      // real identities, and only labels the backup.
      const backup = new wasm.ShareBackup(
        keyPackage,
        0,
        encoder.encode(deviceId(1)),
        encoder.encode(config.groupId),
        groupKey
      )
      temporaries.push(backup)
      const share = bin.keep(backup.to_bytes())

      const baseHeader = {
        groupId: config.groupId,
        network: config.mainnet ? ('mainnet' as const) : ('testnet' as const),
        participants: config.participants,
        threshold: config.threshold,
        rosterSlot: 0 as const,
        groupVerifyingKey: bytesToHex(groupKey),
        publicKeyPackage: bytesToBase64(publicKeyPackage),
        fvk: bytesToBase64(fvk),
        ufvk,
        address,
        fingerprint: bytesToHex(fingerprint)
      }
      const header: VaultRecordHeader = config.binding
        ? { ...baseHeader, version: 2, ownerWalletId: config.walletId, ...config.binding }
        : { ...baseHeader, version: 1 }
      return {
        outcome: { fingerprint: header.fingerprint, inboxes, sealedQsk },
        header,
        share,
        keyPackage
      }
    } finally {
      for (const temporary of temporaries) temporary.free()
    }
  }
}
