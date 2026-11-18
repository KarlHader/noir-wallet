import { sha256 } from '@noble/hashes/sha2'
import type * as WalletWasm from '@/lib/wasm-pkg/zcash_wallet_wasm'
import { bytesToBase64, bytesToHex } from '@/lib/bytes'
import { createEnvelopeSigner, verifyEnvelope, type EnvelopeSigner } from './envelope-signing'
import { parseIdentityPublicKey, type DeviceIdentity } from './identity'
import { parseEnvelope, roundOf, type MultisigEnvelope, type MultisigMessageType } from './messages'
import { parseRosterManifest, type RosterManifest } from './roster'
import {
  assertSigningCarrierSize,
  parseSignEnvelopePayload,
  readSigningInner,
  signingBase64,
  signingBatch,
  SIGN_PCZT_BASE64_LIMIT
} from './sign-protocol'

export type SigningWasm = Pick<
  typeof WalletWasm,
  'Coordinator' | 'Signer' | 'EnvelopeCodec' | 'PcztTools' | 'Verification'
>
export type NoncePhase = 'created' | 'committed' | 'consumed'
export type PersistNoncePhase = (phase: NoncePhase) => Promise<void>
export interface SigningScope {
  walletId: string
  accountId: string
  network: 'mainnet' | 'testnet'
  groupId: string
  rosterVersion: number
}
export interface SigningReviewBinding extends SigningScope {
  reviewId: string
  pcztDigest: string
  sessionId: string
  expiresAt: number
  selectedSlots: readonly number[]
}
export interface SigningCoordinatorOptions {
  scope: SigningScope
  binding: SigningReviewBinding
  roster: RosterManifest
  identity: DeviceIdentity
  keyPackage: Uint8Array
  publicKeyPackage: Uint8Array
  groupVerifyingKey: Uint8Array
  pczt: Uint8Array
  transport: 'qr' | 'ble'
  persistNoncePhase: PersistNoncePhase
  now?: () => number
  schedule?: (callback: () => void, delayMs: number) => () => void
}
export interface SigningStatus {
  sessionId: string
  phase: 'created' | 'commitments' | 'shares' | 'signed' | 'aborted'
  selectedSlots: readonly number[]
  committedSlots: readonly number[]
  sharedSlots: readonly number[]
}
export interface SigningProgress {
  status: SigningStatus
  outbound: MultisigEnvelope[]
}

const FAIL = 'Signing session is unavailable'
const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, index) => byte === b[index])
const cloneMessages = (messages: readonly MultisigEnvelope[]) =>
  messages.map(message => ({ ...message }))

/** One immutable reviewed transaction. This authority belongs in the Worker, never a page. */
export class SigningCoordinatorSession {
  private readonly binding: SigningReviewBinding
  private readonly roster: RosterManifest
  private readonly keyPackage: Uint8Array
  private readonly publicKeyPackage: Uint8Array
  private readonly ak: Uint8Array
  private readonly pczt: Uint8Array
  private readonly transportPczt: Uint8Array
  private readonly sighash: Uint8Array
  private readonly alphas: Uint8Array
  private readonly sessionId: Uint8Array
  private readonly envelopeSigner: EnvelopeSigner
  private readonly transport: 'qr' | 'ble'
  private readonly persist: PersistNoncePhase
  private readonly now: () => number
  private coordinator: InstanceType<SigningWasm['Coordinator']> | null = null
  private signer: InstanceType<SigningWasm['Signer']> | null = null
  private phase: SigningStatus['phase'] = 'created'
  private readonly commitments = new Set<number>()
  private readonly shares = new Set<number>()
  private readonly lastOuterSequence = new Map<number, number>()
  private readonly processed = new Map<string, MultisigEnvelope[]>()
  private started: MultisigEnvelope[] | null = null
  private signedPczt: Uint8Array | null = null
  private tail: Promise<unknown> = Promise.resolve()
  private disarm: () => void = () => {}
  private resultReported = false
  private closed = false

  private constructor(
    private readonly wasm: SigningWasm,
    options: SigningCoordinatorOptions
  ) {
    this.binding = { ...options.binding, selectedSlots: [...options.binding.selectedSlots] }
    const scope = { ...options.scope }
    const roster = parseRosterManifest(options.roster)
    const identityBytes = options.identity.publicKey.slice()
    if (
      !roster ||
      roster.groupId !== scope.groupId ||
      !['walletId', 'accountId', 'groupId', 'network', 'rosterVersion'].every(
        key => scope[key as keyof SigningScope] === this.binding[key as keyof SigningScope]
      ) ||
      !scope.walletId ||
      !scope.accountId ||
      !scope.groupId ||
      !['mainnet', 'testnet'].includes(scope.network) ||
      !Number.isSafeInteger(scope.rosterVersion) ||
      scope.rosterVersion < 1 ||
      !this.binding.reviewId ||
      !/^[0-9a-f]{64}$/.test(this.binding.pcztDigest) ||
      !Number.isSafeInteger(this.binding.expiresAt) ||
      (options.transport !== 'qr' && options.transport !== 'ble') ||
      roster.participants[0].identityPublicKey !== bytesToBase64(identityBytes) ||
      options.identity.signingKeys.privateKey.extractable
    )
      throw new Error(FAIL)
    const slots = this.binding.selectedSlots
    if (
      slots.length !== roster.threshold ||
      !slots.includes(0) ||
      new Set(slots).size !== slots.length ||
      slots.some(
        slot => !Number.isInteger(slot) || slot < 0 || slot >= roster.participants.length
      ) ||
      new Set(roster.participants.map(peer => peer.identityPublicKey)).size !==
        roster.participants.length
    )
      throw new Error(FAIL)
    const session = signingBase64(this.binding.sessionId, 24)
    if (!session || session.length !== 16 || options.groupVerifyingKey.length !== 32)
      throw new Error(FAIL)
    this.sessionId = session
    this.roster = roster
    this.now = options.now ?? Date.now
    this.persist = options.persistNoncePhase
    this.transport = options.transport
    this.keyPackage = options.keyPackage.slice()
    this.publicKeyPackage = options.publicKeyPackage.slice()
    this.ak = options.groupVerifyingKey.slice()
    this.pczt = options.pczt.slice()
    try {
      if (bytesToHex(sha256(this.pczt)) !== this.binding.pcztDigest) throw new Error(FAIL)
      wasm.PcztTools.check(this.pczt)
      this.sighash = wasm.PcztTools.shielded_sighash(this.pczt)
      this.alphas = wasm.PcztTools.action_alphas(this.pczt)
      const rks = wasm.PcztTools.action_rks(this.pczt)
      if (
        this.sighash.length !== 32 ||
        !this.alphas.length ||
        this.alphas.length % 32 !== 0 ||
        this.alphas.length > 256 * 32 ||
        rks.length !== this.alphas.length
      )
        throw new Error(FAIL)
      wasm.PcztTools.check_action_bindings(this.pczt, this.ak, this.alphas)
      this.transportPczt = wasm.PcztTools.strip_proofs(this.pczt)
      if (
        bytesToBase64(this.transportPczt).length > SIGN_PCZT_BASE64_LIMIT ||
        !equal(this.sighash, wasm.PcztTools.shielded_sighash(this.transportPczt))
      )
        throw new Error(FAIL)
      wasm.PcztTools.check(this.transportPczt)
      wasm.PcztTools.check_action_bindings(this.transportPczt, this.ak, this.alphas)
      this.envelopeSigner = createEnvelopeSigner({
        groupId: this.binding.groupId,
        sessionId: this.binding.sessionId,
        senderId: 'device-1',
        signingKey: options.identity.signingKeys.privateKey
      })
      this.live()
    } catch {
      this.keyPackage.fill(0)
      this.pczt.fill(0)
      throw new Error(FAIL)
    }
  }

  static async open(
    wasm: SigningWasm,
    options: SigningCoordinatorOptions
  ): Promise<SigningCoordinatorSession> {
    const session = new SigningCoordinatorSession(wasm, options)
    const schedule =
      options.schedule ??
      ((callback: () => void, delay: number) => {
        const timer = setTimeout(callback, delay)
        ;(timer as { unref?: () => void }).unref?.()
        return () => clearTimeout(timer)
      })
    session.disarm = schedule(() => session.cancel(), session.binding.expiresAt - session.now())
    return session
  }

  status(): SigningStatus {
    return {
      sessionId: this.binding.sessionId,
      phase: this.phase,
      selectedSlots: [...this.binding.selectedSlots],
      committedSlots: [...this.commitments].sort(),
      sharedSlots: [...this.shares].sort()
    }
  }

  private progress(outbound: readonly MultisigEnvelope[] = []): SigningProgress {
    return { status: this.status(), outbound: cloneMessages(outbound) }
  }

  private live(): void {
    if (
      this.closed ||
      this.phase === 'aborted' ||
      (this.phase !== 'signed' && this.now() >= this.binding.expiresAt)
    )
      throw new Error(FAIL)
  }

  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      try {
        this.live()
        return await operation()
      } catch {
        this.cancel()
        throw new Error(FAIL)
      }
    })
    this.tail = result.catch(() => {})
    return result
  }

  private async durable(phase: NoncePhase): Promise<void> {
    await this.persist(phase)
    this.live()
  }

  private async wrap(
    type: MultisigMessageType,
    slot: number,
    inner: Uint8Array,
    pczt?: Uint8Array
  ): Promise<MultisigEnvelope> {
    const envelope = await this.envelopeSigner.next(type, `device-${slot + 1}`, {
      envelope: bytesToBase64(inner),
      ...(pczt ? { pczt: bytesToBase64(pczt) } : {})
    })
    this.live()
    assertSigningCarrierSize(envelope, this.transport)
    return envelope
  }

  start(): Promise<SigningProgress> {
    return this.queue(async () => {
      if (this.started) return this.progress(this.started)
      if (this.phase !== 'created') throw new Error(FAIL)
      await this.durable('created')
      const { selectedSlots } = this.binding
      this.coordinator = new this.wasm.Coordinator(
        this.sessionId,
        this.roster.participants.length,
        this.roster.threshold,
        Uint8Array.from(selectedSlots),
        this.alphas.length / 32,
        this.publicKeyPackage
      )
      this.signer = new this.wasm.Signer(
        this.sessionId,
        0,
        this.roster.participants.length,
        this.keyPackage
      )
      this.keyPackage.fill(0)
      const batch = signingBatch(this.coordinator.init_all(), selectedSlots)
      const localCommitments = this.signer.init(batch.get(0)!)
      await this.durable('committed')
      this.coordinator.accept_commitments(localCommitments)
      this.commitments.add(0)
      const outbound: MultisigEnvelope[] = []
      for (const slot of selectedSlots)
        if (slot !== 0) outbound.push(await this.wrap('SIGN_INIT', slot, batch.get(slot)!))
      this.phase = 'commitments'
      this.started = cloneMessages(outbound)
      return this.progress(outbound)
    })
  }

  ingest(rawEnvelope: unknown): Promise<SigningProgress> {
    // Copy primitive fields before an await so callers cannot replace a queued payload.
    const envelope = parseEnvelope(rawEnvelope)
    return this.queue(async () => {
      if (!envelope) throw new Error(FAIL)
      assertSigningCarrierSize(envelope, this.transport)
      const slot = this.binding.selectedSlots.find(
        value => value !== 0 && envelope.sender_id === `device-${value + 1}`
      )
      if (
        slot === undefined ||
        envelope.recipient_id !== 'device-1' ||
        envelope.group_id !== this.binding.groupId ||
        envelope.session_id !== this.binding.sessionId ||
        envelope.round !== roundOf(envelope.message_type) ||
        !['SIGN_COMMITMENTS', 'SIGN_SHARE', 'SIGN_REJECT', 'SESSION_ABORT'].includes(
          envelope.message_type
        )
      )
        throw new Error(FAIL)
      const peer = parseIdentityPublicKey(this.roster.participants[slot].identityPublicKey)
      if (!peer || !(await verifyEnvelope(envelope, peer.ed25519))) throw new Error(FAIL)
      this.live()
      const key = JSON.stringify(envelope)
      const previous = this.processed.get(key)
      if (previous) return this.progress(previous)
      if (envelope.sequence <= (this.lastOuterSequence.get(slot) ?? -1) || this.phase === 'signed')
        throw new Error(FAIL)
      if (envelope.message_type === 'SESSION_ABORT') {
        this.cancel()
        return this.progress()
      }
      const inner = parseSignEnvelopePayload(JSON.parse(envelope.encrypted_payload))
      if (!inner) throw new Error(FAIL)
      const decoded = readSigningInner(this.wasm.EnvelopeCodec, inner)
      const name = {
        SIGN_COMMITMENTS: 'signCommitments',
        SIGN_SHARE: 'signShare',
        SIGN_REJECT: 'signReject'
      }[envelope.message_type as 'SIGN_COMMITMENTS' | 'SIGN_SHARE' | 'SIGN_REJECT']
      if (
        decoded.msgType !== this.wasm.EnvelopeCodec.msg_type(name) ||
        decoded.sender !== slot ||
        decoded.recipient !== this.wasm.EnvelopeCodec.coordinator_slot ||
        decoded.round !== envelope.round ||
        !equal(decoded.sessionId, this.sessionId) ||
        !this.coordinator
      )
        throw new Error(FAIL)
      this.lastOuterSequence.set(slot, envelope.sequence)
      if (envelope.message_type === 'SIGN_REJECT') {
        this.coordinator.accept_reject(inner)
        this.cancel()
        return this.progress()
      }
      let outbound: MultisigEnvelope[] = []
      if (envelope.message_type === 'SIGN_COMMITMENTS') {
        if (this.phase !== 'commitments' || this.commitments.has(slot)) throw new Error(FAIL)
        this.coordinator.accept_commitments(inner)
        this.commitments.add(slot)
        if (this.commitments.size === this.binding.selectedSlots.length)
          outbound = await this.payloads()
      } else {
        if (this.phase !== 'shares' || this.shares.has(slot)) throw new Error(FAIL)
        this.coordinator.accept_share(inner)
        this.shares.add(slot)
        if (this.shares.size === this.binding.selectedSlots.length) this.aggregate()
      }
      this.processed.set(key, cloneMessages(outbound))
      return this.progress(outbound)
    })
  }

  private async payloads(): Promise<MultisigEnvelope[]> {
    const coordinator = this.coordinator!
    const signer = this.signer!
    coordinator.prepare_payload(this.sighash, this.alphas)
    const batch = signingBatch(coordinator.payloads(), this.binding.selectedSlots)
    const material: unknown = signer.payload(batch.get(0)!)
    if (
      !Array.isArray(material) ||
      material.length !== 2 ||
      !(material[0] instanceof Uint8Array) ||
      !(material[1] instanceof Uint8Array) ||
      !equal(material[0], this.sighash) ||
      !equal(material[1], this.alphas)
    )
      throw new Error(FAIL)
    this.wasm.PcztTools.check(this.pczt)
    this.wasm.PcztTools.check_action_bindings(this.pczt, this.ak, this.alphas)
    if (bytesToHex(sha256(this.pczt)) !== this.binding.pcztDigest) throw new Error(FAIL)
    // Validate every actual signed carrier (including Noise overhead) before consuming our nonce.
    const outbound: MultisigEnvelope[] = []
    for (const slot of this.binding.selectedSlots)
      if (slot !== 0)
        outbound.push(await this.wrap('SIGN_PAYLOAD', slot, batch.get(slot)!, this.transportPczt))
    await this.durable('consumed')
    signer.approve()
    coordinator.accept_share(signer.share())
    this.shares.add(0)
    this.phase = 'shares'
    return outbound
  }

  private aggregate(): void {
    const signatures = this.coordinator!.aggregate()
    const count = this.alphas.length / 32
    if (!(signatures instanceof Uint8Array) || signatures.length !== count * 64)
      throw new Error(FAIL)
    for (let i = 0; i < count; i++)
      this.wasm.Verification.verify_spend_auth(
        this.ak,
        this.alphas.subarray(i * 32, (i + 1) * 32),
        this.sighash,
        signatures.subarray(i * 64, (i + 1) * 64)
      )
    const signed = this.wasm.PcztTools.apply_signatures(
      this.pczt,
      Uint8Array.from({ length: count }, (_, index) => index),
      signatures
    )
    this.wasm.PcztTools.check(signed)
    if (!equal(this.sighash, this.wasm.PcztTools.shielded_sighash(signed))) throw new Error(FAIL)
    this.signedPczt = signed
    this.phase = 'signed'
    this.signer?.free()
    this.signer = null
    this.disarm()
    this.pczt.fill(0)
    this.transportPczt.fill(0)
    this.keyPackage.fill(0)
  }

  /** Worker-only one-time handoff. No UI/RPC state projection may call this. */
  takeSignedPczt(): Uint8Array | null {
    if (this.phase !== 'signed') return null
    const bytes = this.signedPczt
    this.signedPczt = null
    return bytes
  }

  reportResult(
    result: 'broadcast' | 'failed' | 'unknown',
    txid?: Uint8Array
  ): Promise<MultisigEnvelope[]> {
    const txidCopy = txid?.slice()
    return this.queue(async () => {
      if (
        this.phase !== 'signed' ||
        this.resultReported ||
        !this.coordinator ||
        !['broadcast', 'failed', 'unknown'].includes(result)
      )
        throw new Error(FAIL)
      if (result === 'unknown') return []
      if ((result === 'broadcast' && txidCopy?.length !== 32) || (result === 'failed' && txidCopy))
        throw new Error(FAIL)
      const batch = signingBatch(
        this.coordinator.report_result(result === 'broadcast' ? 0 : 1, txidCopy, ''),
        this.binding.selectedSlots
      )
      const messages: MultisigEnvelope[] = []
      for (const slot of this.binding.selectedSlots)
        if (slot !== 0) messages.push(await this.wrap('SIGN_RESULT', slot, batch.get(slot)!))
      this.resultReported = true
      this.coordinator.free()
      this.coordinator = null
      return this.transport === 'ble' ? messages : []
    })
  }

  cancel(): void {
    this.disarm()
    this.closed = true
    if (this.phase !== 'signed') this.phase = 'aborted'
    this.signer?.free()
    this.signer = null
    this.coordinator?.free()
    this.coordinator = null
    this.keyPackage.fill(0)
    this.alphas?.fill(0)
    this.sighash?.fill(0)
    this.pczt.fill(0)
    this.transportPczt?.fill(0)
    this.signedPczt?.fill(0)
    this.signedPczt = null
    this.started = null
    this.processed.clear()
  }
}
