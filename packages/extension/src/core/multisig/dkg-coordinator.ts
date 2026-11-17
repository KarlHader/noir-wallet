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
import { SecretBin, round1Hash, type DkgShape, type VaultWasm } from './dkg-protocol'
import { deviceId } from './messages'
import {
  openVaultRecord,
  sealVaultRecord,
  type SealedVaultRecord,
  type VaultRecordHeader
} from './vault-record'

/** The wallet's mnemonic, which seals the record; throws when the wallet is not unlocked. */
export type MnemonicResolver = (walletId: string) => string

export type DkgCoordinatorConfig = DkgShape & {
  mainnet: boolean
  walletId: string
  groupId: string
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
  const keys = Object.keys(a) as (keyof VaultRecordHeader)[]
  return (
    keys.length === Object.keys(b).length &&
    keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && a[key] === b[key])
  )
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
    envelope: Uint8Array
  ): Promise<AcceptOutcome<Round1Outcome>> {
    const state = this.open()
    try {
      if (this.round1Complete) throw new Error('round 1 is already complete')
      const [sender, payload] = this.accept(state.relay, envelope, 'dkgR1', senderSlot)
      if (this.accepted1.has(sender)) throw new Error('duplicate round-1 envelope')
      this.accepted1.add(sender)
      state.broadcasts.set(sender, payload)
      if (this.accepted1.size < this.peerCount) return { complete: false }

      this.round1Complete = true
      const hash = await round1Hash(state.broadcasts.to_bytes())
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
    envelope: Uint8Array
  ): Promise<AcceptOutcome<Round2Outcome>> {
    const state = this.open()
    try {
      if (!this.round1Complete) throw new Error('round 1 is not complete')
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
    if (typeof sender !== 'number' || !(payload instanceof Uint8Array)) {
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

      const header: VaultRecordHeader = {
        version: 1,
        groupId: config.groupId,
        network: config.mainnet ? 'mainnet' : 'testnet',
        participants: config.participants,
        threshold: config.threshold,
        rosterSlot: 0,
        groupVerifyingKey: bytesToHex(groupKey),
        publicKeyPackage: bytesToBase64(publicKeyPackage),
        fvk: bytesToBase64(fvk),
        ufvk,
        address,
        fingerprint: bytesToHex(fingerprint)
      }
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
