/* tslint:disable */
/* eslint-disable */
/**
 * The `ReadableStreamType` enum.
 *
 * *This API requires the following crate features to be activated: `ReadableStreamType`*
 */

export type ReadableStreamType = 'bytes'

/**
 * Configure confirmation counts for balance and status queries.
 * Input selection uses the smaller count for both trusted and untrusted funds.
 * Shielding retains the default zero-confirmation setting.
 */
export interface ConfirmationsPolicy {
  /** Positive uint32; must not exceed untrusted. */
  trusted: number
  /** Positive uint32. */
  untrusted: number
}

export interface CompactBlockCdnOptions {
  /** Root containing {network}/shielded-default/manifest.json. */
  baseUrl: string
  /** Per-request timeout. Defaults to 30000. */
  requestTimeoutMs?: number
  /** Maximum decompressed chunk size. Defaults to 128 MiB. */
  maxChunkBytes?: number
  /** Maximum concurrent CDN chunk requests. Defaults to 4; valid range is 1 through 8. */
  maxConcurrentChunkRequests?: number
}

/** Runtime Orchard broadcast and transaction lookup endpoints; supply again when restoring wallet bytes. */
export interface ZeroIndexerOptions {
  /** Ordered endpoints for Orchard transaction broadcast and status lookup. */
  urls: string[]
  /** Positive per-endpoint timeout for send and GetTransaction, in milliseconds. Defaults to 30000. */
  sendTimeoutMs?: number
}

export type TransferOverallStatus = 'success' | 'partial' | 'unknown' | 'failed'
export type TransferSubmissionStatus = 'submitted' | 'rejected' | 'unknown' | 'not_attempted'

export interface TransferTransactionResult {
  txId: string
  status: TransferSubmissionStatus
  errorCode?: number
  errorMessage?: string
}

export interface TransferResult {
  status: TransferOverallStatus
  txIds: string[]
  finalTxId: string
  transactions: TransferTransactionResult[]
}

export interface TransferEstimate {
  amountZats: string
  feeZats: string
  marginalFeeZats: string
  transactionCount: number
  stepFeesZats: string[]
}

export type VotingErrorCode =
  | 'CONFIG_FETCH_FAILED'
  | 'CONFIG_UNTRUSTED'
  | 'ROUND_UNAUTHENTICATED'
  | 'ROUND_EXPIRED'
  | 'NETWORK_MISMATCH'
  | 'WALLET_NOT_SYNCED'
  | 'NOT_ELIGIBLE'
  | 'PIR_SNAPSHOT_MISMATCH'
  | 'PROOF_FAILED'
  | 'PERSISTENCE_FAILED'
  | 'SUBMISSION_REJECTED'
  | 'SUBMISSION_UNKNOWN'
  | 'OPERATION_IN_PROGRESS'
  | 'RECOVERY_CONFLICT'
export interface VotingApiError extends Error {
  name: VotingErrorCode
}
export type VotingRoundPhase =
  | 'uninitialized'
  | 'config_authenticated'
  | 'eligible'
  | 'round_prepared'
  | 'delegation_pending'
  | 'delegation_confirmed'
  | 'vote_pending'
  | 'vote_confirmed'
  | 'shares_confirmed'
  | 'not_eligible'
  | 'round_rejected'
  | 'expired'
export interface VotingRoundSummary {
  roundId: string
  name: string
  snapshotHeight: number
  startsAt: string
  endsAt: string
  proposalCount: number
}
export interface VotingRejectedRound {
  roundId: string
  code: VotingErrorCode
  message: string
}
export interface VotingProposal {
  proposalId: number
  title: string
  options: string[]
}
export interface VotingDiscovery {
  accepted: VotingRoundSummary[]
  rejected: VotingRejectedRound[]
  configFingerprint: string
}
export type VotingEligibilityReason = 'INSUFFICIENT_SNAPSHOT_VALUE' | 'INSUFFICIENT_VOTING_POWER'
export interface VotingEligibility {
  roundId: string
  eligible: boolean
  snapshotVotingValueZats: string
  minimumRequiredZats: string
  reasonCode: VotingEligibilityReason | null
  selectedValueZats: string
  votingPower: string
  selectedNoteCount: number
  bundleCount: number
  trimmedValueZats: string
}
export interface PreparedVotingRound {
  roundId: string
  bundleCount: number
  selectedNoteCount: number
  votingPower: string
  state: VotingRoundPhase
}
export type BallotDecision =
  | { kind: 'choice'; proposalId: number; option: number }
  | { kind: 'skip'; proposalId: number }
export interface VotingActionResult {
  roundId: string
  phase: VotingRoundPhase
  completedBundles: number
  totalBundles: number
  nextAction: string
}
export interface VotingRoundStatus extends VotingActionResult {
  confirmedVotes: number
  totalVotes: number
  confirmedHelpers: number
  requiredHelpers: number
}
export type VotingCheckpoint = (bytes: Uint8Array, revision: bigint) => Promise<void>

export class BlockRange {
  private constructor()
  free(): void
  [Symbol.dispose](): void
  0: number
  1: number
}

/**
 * Canary gate. `phase` is one of `"notStarted"`, `"awaitingArrival"`, `"awaitingSpend"`,
 * `"proven"`; `allows` answers whether a deposit may be started now.
 */
export class Canary {
  free(): void
  [Symbol.dispose](): void
  allows(amount: number): boolean
  arrival_confirmed(): void
  /**
   * Register the small first deposit.
   */
  begin(amount: number): void
  constructor()
  phase(): string
  spend_confirmed(): void
}

/**
 * Coordinator side of a signing session.
 */
export class Coordinator {
  free(): void
  [Symbol.dispose](): void
  /**
   * Collect a `SIGN_COMMITMENTS` envelope from a signer.
   */
  accept_commitments(envelope: Uint8Array): void
  /**
   * Accept a signer's refusal. The session ends; one signer out means this selection no longer reaches
   * the threshold.
   */
  accept_reject(envelope: Uint8Array): Array<any>
  /**
   * Collect a `SIGN_SHARE` envelope.
   */
  accept_share(envelope: Uint8Array): void
  actions(): number
  /**
   * Aggregate once every signer has returned every share. Returns the signatures, 64 bytes each.
   */
  aggregate(): Uint8Array
  /**
   * The whole `SIGN_INIT` batch: `[[slot, envelope], ...]`. One call, because the session moves to
   * `InitSent` as a whole.
   */
  init_all(): Array<any>
  /**
   * `signers` is the selected roster slots (length must equal the threshold).
   */
  constructor(
    session_id: Uint8Array,
    participants: number,
    threshold: number,
    signers: Uint8Array,
    actions: number,
    public_key_package: Uint8Array
  )
  /**
   * The whole `SIGN_PAYLOAD` batch: `[[slot, envelope], ...]`.
   */
  payloads(): Array<any>
  phase(): string
  /**
   * Hand over the sighash and per-action alphas read from the built transaction.
   */
  prepare_payload(sighash: Uint8Array, alphas: Uint8Array): void
  /**
   * Report the outcome to every signer after aggregation.
   *
   * `status`: 0 = broadcasted (then `txid` is required), 1 = failed. Returns `[[slot, envelope], ...]`.
   */
  report_result(status: number, txid: Uint8Array | null | undefined, note: string): Array<any>
}

/**
 * Deposit denomination policy.
 */
export class Deposit {
  private constructor()
  free(): void
  [Symbol.dispose](): void
  static canary_amount(): number
  static denom_cap(): number
  static is_canonical(value: number): boolean
  /**
   * Split an amount into canonical outputs. Returns the output values (`Float64Array`) or an error
   * when the amount cannot be sent.
   */
  static plan(amount: number): Float64Array
  /**
   * Residual left behind, in zatoshi.
   */
  static residual(amount: number): number
}

/**
 * One device's participation in a distributed key generation.
 */
export class Dkg {
  free(): void
  [Symbol.dispose](): void
  constructor(participants: number, threshold: number, slot: number, session_id: Uint8Array)
  /**
   * Round 1: generate this device's contribution.
   *
   * The contribution is bound to this ceremony's session id: a later round refuses a broadcast that
   * names a different one, so a round-1 secret cannot be carried into a second ceremony.
   */
  part1(): Dkg1
  /**
   * Round 2: seal one package per peer from everyone's broadcasts.
   */
  part2(secret: Uint8Array, broadcasts: MessageSet): Dkg2
  /**
   * Round 3: finalize with the broadcasts and the packages addressed to this device.
   */
  part3(secret: Uint8Array, broadcasts: MessageSet, incoming: MessageSet): Dkg3
  slot(): number
  /**
   * The static public key carried inside a round-1 broadcast.
   *
   * A coordinator that handles one device at a time has each broadcast as bytes and needs the
   * sender's key in order to seal KEYSET_SETUP to it. Use this rather than taking the framing apart.
   */
  static static_public_of_broadcast(broadcast: Uint8Array): Uint8Array
}

/**
 * Round 1 of a distributed key generation: a secret to keep, a broadcast to send.
 */
export class Dkg1 {
  private constructor()
  free(): void
  [Symbol.dispose](): void
  /**
   * Public broadcast for every other participant.
   */
  broadcast(): Uint8Array
  /**
   * The broadcast wrapped in a `DKGR1` envelope addressed to the coordinator.
   *
   * Use this instead of shipping the raw bytes: the envelope is what binds the payload to this
   * session, this sender and this round, and what lets the relay reject replays.
   */
  broadcast_envelope(session_id: Uint8Array, sequence: number, my_slot: number): Uint8Array
  /**
   * Secret state for round 2. Persist it under the device keystore; it never leaves the device.
   */
  secret(): Uint8Array
  /**
   * This device's static public key. Publish it; peers seal later ceremony messages to it.
   */
  static_public(): Uint8Array
}

/**
 * Round 2 output: a secret to keep plus one sealed package per peer.
 */
export class Dkg2 {
  private constructor()
  free(): void
  [Symbol.dispose](): void
  /**
   * Packages to deliver, indexed by recipient slot.
   */
  outgoing(): MessageSet
  /**
   * The whole batch wrapped in a `DKGR2BATCH` envelope addressed to the coordinator.
   */
  outgoing_envelope(session_id: Uint8Array, sequence: number, my_slot: number): Uint8Array
  secret(): Uint8Array
  /**
   * Every participant's static public key, by slot, including this device's — learned from the
   * round-1 broadcasts. This is what KEYSET_SETUP seals to; there is no need to parse the broadcast
   * framing to get it.
   */
  statics(): MessageSet
}

/**
 * Round 3 output: this device's key package and the group's public package.
 */
export class Dkg3 {
  private constructor()
  free(): void
  [Symbol.dispose](): void
  /**
   * `ak`, the group's spend validating key. Every other call needs it: the keyset derivation, the
   * share backup binding and the signature verification all take it.
   */
  group_verifying_key(): Uint8Array
  /**
   * The share. Persist it as a [`ShareBackup`]; never transmit it.
   */
  key_package(): Uint8Array
  /**
   * The public group state. Safe to share; every device must end up with the same bytes.
   */
  public_key_package(): Uint8Array
  /**
   * This ceremony's static public key. Publish it (it already travels in the round-1 broadcast).
   */
  static_public(): Uint8Array
  /**
   * The matching static secret, for sealing later ceremony messages (KEYSET_SETUP) to peers.
   *
   * Keep it on the device. It cannot spend; it only lets peers send this device a message nobody
   * else can read.
   */
  static_secret(): Uint8Array
  /**
   * Every participant's static public key, by slot, including this device's own.
   */
  statics(): MessageSet
}

/**
 * The coordinator's side of the DKG message flow.
 *
 * Signers send `DKGR1` / `DKGR2BATCH` envelopes; the coordinator validates who sent them and in what
 * order, then forwards a `DKGR1BUNDLE` / `DKGR2INBOX` to each peer. This type exists so that the
 * session binding, roster check and replay rejection are not left to the app to reimplement.
 *
 * Round-2 packages are sealed to their recipient inside the DKG implementation (Noise, single
 * message, ceremony as prologue), so a relay can forward them but cannot read them.
 */
export class DkgRelay {
  free(): void
  [Symbol.dispose](): void
  /**
   * Validate an envelope from a signer and return `[senderSlot, payload]`.
   *
   * `expected` is the message type name (`"dkgR1"` or `"dkgR2Batch"`). Anything that is not from a
   * roster slot, not addressed to the coordinator, not the expected type, or not newer than the
   * last message from that sender is refused.
   */
  accept(envelope: Uint8Array, expected: string): Array<any>
  /**
   * Forward a bundle to one recipient: `DKGR1BUNDLE` in round 1, `DKGR2INBOX` in round 2.
   */
  bundle(round: number, recipient: number, messages: MessageSet): Uint8Array
  constructor(session_id: Uint8Array, participants: number)
}

/**
 * Encode/decode an envelope. The frontend may treat envelopes as opaque bytes, but exposing the codec
 * lets it validate framing before spending a QR frame on it.
 */
export class EnvelopeCodec {
  private constructor()
  free(): void
  [Symbol.dispose](): void
  /**
   * Build a `SIGN_INIT`-shaped envelope. Mostly useful for transport tests.
   */
  static build(
    msg_type: number,
    round: number,
    sender: number,
    recipient: number,
    sequence: number,
    session_id: Uint8Array,
    payload: Uint8Array
  ): Uint8Array
  /**
   * Build a `SIGN_REJECT` envelope. `code`: 1 user declined, 2 verification failed, 3 malformed, 4 expired.
   */
  static buildSignReject(
    session_id: Uint8Array,
    sender: number,
    recipient: number,
    sequence: number,
    code: number,
    note: string
  ): Uint8Array
  /**
   * Build a `SIGN_RESULT` envelope. `status`: 0 broadcasted (txid required), 1 failed (no txid).
   */
  static buildSignResult(
    session_id: Uint8Array,
    sender: number,
    recipient: number,
    sequence: number,
    status: number,
    txid: Uint8Array | null | undefined,
    note: string
  ): Uint8Array
  /**
   * Build a signing-session envelope; the round comes from the message type.
   *
   * Use this instead of `build` for signing messages: `build` takes the round as an argument, which is
   * how a caller ends up sending a round the receiver refuses.
   */
  static buildSigning(
    msg_type: number,
    sender: number,
    recipient: number,
    sequence: number,
    session_id: Uint8Array,
    payload: Uint8Array
  ): Uint8Array
  /**
   * Decode an envelope into a JSON-ish object: `{ msgType, round, sender, recipient, sequence,
   * sessionId: Uint8Array, payload: Uint8Array }` as a JS array, to keep the surface primitive.
   */
  static decode(bytes: Uint8Array): Array<any>
  /**
   * The type names that have a defined payload.
   */
  static defined_msg_types(): Array<any>
  /**
   * Wire value of a message type **whose payload this crate defines**.
   *
   * Eight types qualify today: the four signing messages, whose payloads the session produces, and
   * the four DKG messages, whose payloads are this crate's own DKG bytes and packed batches.
   *
   * The protocol table also reserves numbers for messages that have no payload format yet —
   * `PAIR_INVITE`, `ROSTER_LOCK`, `KEYSET_SETUP` and others. Those are deliberately refused here so
   * that an undefined type cannot become a de-facto contract by accident; use
   * [`Self::reserved_msg_type`] if you genuinely need the number, and know that nothing defines
   * what goes in it.
   */
  static msg_type(name: string): number
  /**
   * A fresh 16-byte session id, from this module's OS-backed entropy.
   *
   * Use this rather than a counter or a timestamp: a repeated id would make a stale session
   * marker look like the current session after a restart, which is exactly the case the marker
   * exists to catch.
   */
  static new_session_id(): Uint8Array
  /**
   * Decode a `SIGN_REJECT` envelope into `[sender, sequence, sessionId, code, note]`.
   */
  static readSignReject(bytes: Uint8Array): Array<any>
  /**
   * Decode a `SIGN_RESULT` envelope into `[sender, sequence, sessionId, status, txid|null, note]`.
   */
  static readSignResult(bytes: Uint8Array): Array<any>
  /**
   * Read a signing-session envelope, refusing a type outside the signing set and a round that disagrees
   * with its type. Returns the same shape as `decode`.
   */
  static readSigning(bytes: Uint8Array): Array<any>
  /**
   * Wire value of a reject code, by the name the phone uses.
   */
  static rejectCode(name: string): number
  /**
   * Wire value of a **reserved** type: the number exists in the protocol table, but no payload
   * format is defined for it. Prefer [`Self::msg_type`]; this exists so a caller can decode a
   * message it received rather than invent one it should not send.
   */
  static reserved_msg_type(name: string): number
  /**
   * The type names that are reserved without a payload format.
   */
  static reserved_msg_types(): Array<any>
  /**
   * The `round` a message type belongs to, per the spec's message table.
   *
   * The value is enforced only inside a session: `readSigning` and the signing sessions refuse an
   * envelope whose round disagrees with its type. Nothing checks the DKG rounds, so this is a lookup
   * for callers that fill the field themselves — a wrong value produces a message the peer refuses,
   * not a local error.
   */
  static round_of(name: string): number
  /**
   * The slot reserved for the coordinator, which may hold no share.
   */
  static readonly coordinator_slot: number
}

export class IntoUnderlyingByteSource {
  private constructor()
  free(): void
  [Symbol.dispose](): void
  cancel(): void
  pull(controller: ReadableByteStreamController): Promise<any>
  start(controller: ReadableByteStreamController): void
  readonly autoAllocateChunkSize: number
  readonly type: ReadableStreamType
}

export class IntoUnderlyingSink {
  private constructor()
  free(): void
  [Symbol.dispose](): void
  abort(reason: any): Promise<any>
  close(): Promise<any>
  write(chunk: any): Promise<any>
}

export class IntoUnderlyingSource {
  private constructor()
  free(): void
  [Symbol.dispose](): void
  cancel(): void
  pull(controller: ReadableStreamDefaultController): Promise<any>
}

/**
 * Keyset setup: `ak` plus the recovery key to a receiving address.
 */
export class Keyset {
  private constructor()
  free(): void
  [Symbol.dispose](): void
  /**
   * Whether the derived address carries only an Orchard receiver. Must always be true; the
   * frontend should refuse to show an address where it is not.
   */
  static address_is_shielded_only(address: string): boolean
  /**
   * Returns `[fvk(96), ufvk, address, rawAddress(43), fingerprint(32)]`.
   */
  static derive(
    group_verifying_key: Uint8Array,
    qsk: Uint8Array,
    mainnet: boolean,
    diversifier_index: number
  ): Array<any>
  /**
   * The keyset fingerprint, recomputed from an FVK: `SHA-256(domain ‖ network_tag ‖ fvk)`.
   *
   * Recovery needs this: a device keeps the FVK but not the `qsk`, so [`Self::derive`] is not
   * available to it, and the fingerprint is what the user compares against an independent device to
   * detect a coordinator handing over a viewing key with a real `ak` and attacker-chosen
   * `nk`/`rivk`.
   *
   * Do not reimplement this hash elsewhere: the domain tag and network tag are part of the preimage,
   * and a one-byte difference makes two implementations disagree forever.
   */
  static fingerprint_from_fvk(fvk: Uint8Array, mainnet: boolean): Uint8Array
  /**
   * `fingerprint_from_fvk` for callers holding the encoded UFVK.
   */
  static fingerprint_from_ufvk(ufvk: string, mainnet: boolean): Uint8Array
  /**
   * The 96-byte FVK inside a UFVK string.
   *
   * A recovering device receives a viewing key but not the `qsk` behind it, so it cannot re-derive
   * anything with [`Self::derive`]. This reads the key back out.
   */
  static fvk_from_ufvk(ufvk: string): Uint8Array
  /**
   * A fresh `qsk`: the `nk`/`rivk` source, and the ZIP-2005 recovery candidate.
   *
   * Generate it **once**, on one device, then deliver it to every other device over a
   * confidential, authenticated channel — the same one the DKG round-2 packages need. Every
   * device must pass the identical `qsk` to [`Self::derive`] or they will land on different
   * addresses for the same group.
   *
   * It cannot spend: spend authorization is `ak`, which lives only in the FROST shares. Holding
   * `qsk` does not weaken the threshold, which is why backing it up is cheap insurance.
   */
  static generate_qsk(): Uint8Array
  /**
   * Whether a UFVK was derived from this group key.
   *
   * Run this before trusting a viewing key handed to you by a coordinator or a peer: `ak` is the
   * first 32 bytes of the FVK, and a mismatch would restore the device into a different, empty
   * wallet.
   */
  static ufvk_matches_ak(ufvk: string, group_verifying_key: Uint8Array): boolean
}

/**
 * A set of messages indexed by peer slot.
 *
 * The frontend fills this with whatever its transport received, and reads it back after a round.
 * Exists so the wire format of a message batch stays inside the wasm.
 */
export class MessageSet {
  free(): void
  [Symbol.dispose](): void
  /**
   * Unpack an envelope payload back into a set.
   */
  static from_bytes(bytes: Uint8Array): MessageSet
  get(slot: number): Uint8Array | undefined
  is_empty(): boolean
  len(): number
  constructor()
  /**
   * Add or replace the payload for a peer.
   */
  set(slot: number, bytes: Uint8Array): void
  slots(): Uint8Array
  /**
   * Pack for transport as one envelope payload.
   */
  to_bytes(): Uint8Array
}

/**
 * The Noise XX channel used under BLE.
 *
 * WebCrypto has no BLAKE2s, so this cannot be written in the extension: a hand-rolled Noise state
 * machine in JavaScript would be a third implementation of a security-critical protocol. GATT reads and
 * writes stay in the host — this only turns plaintext into bytes and back.
 *
 * XX is three messages: initiator writes, responder replies, initiator finishes. After that both sides
 * can `encrypt`/`decrypt`.
 *
 * **Message 1's payload is plaintext.** Noise has no key before the first DH, so nothing that matters may
 * be carried there; the initiator's static key is only revealed and proved in message 3. Use message 1
 * for nothing, or for data you would be happy to see forged.
 */
export class NoiseXx {
  private constructor()
  free(): void
  [Symbol.dispose](): void
  /**
   * Decrypt one payload from the peer.
   */
  decrypt(ciphertext: Uint8Array): Uint8Array
  /**
   * Encrypt one payload. Completes the handshake first if it is finished but not yet converted.
   */
  encrypt(plaintext: Uint8Array): Uint8Array
  /**
   * The handshake hash. Both ends must agree; unavailable until the handshake completes.
   */
  handshake_hash(): Uint8Array
  /**
   * Start the channel as the connecting side.
   */
  static initiator(static_private: Uint8Array, prologue: Uint8Array): NoiseXx
  is_handshake_finished(): boolean
  /**
   * Whether the channel is dead after an authentication failure.
   *
   * Noise advances the nonce before verifying the tag, so one bad message leaves the two sides out of
   * step permanently. When this is true the host must drop the channel and handshake again — every
   * later call returns an error.
   */
  is_poisoned(): boolean
  /**
   * Read a handshake message from the peer, returning its payload.
   */
  read_handshake(message: Uint8Array): Uint8Array
  /**
   * Rotate the sending and receiving keys, as Noise's `rekey` specifies.
   */
  rekey(): void
  /**
   * The peer's static public key, once the handshake has revealed it.
   */
  remote_static(): Uint8Array | undefined
  /**
   * Start the channel as the accepting side.
   */
  static responder(static_private: Uint8Array, prologue: Uint8Array): NoiseXx
  /**
   * The X25519 public key belonging to a static private key.
   */
  static static_public_from(private_key: Uint8Array): Uint8Array
  /**
   * Write the next handshake message for this side.
   */
  write_handshake(payload: Uint8Array): Uint8Array
}

export class PaymentRequest {
  free(): void
  [Symbol.dispose](): void
  amount(): bigint
  label(): string | undefined
  memo(): Uint8Array | undefined
  message(): string | undefined
  constructor(
    recipient_address: string,
    amount: bigint,
    memo: Uint8Array | null | undefined,
    label: string | null | undefined,
    message: string | null | undefined,
    other_params: any
  )
  other_params(): any
  recipient_address(): string
  static simple_payment(recipient_address: string, amount: bigint): PaymentRequest
}

export class Pczt {
  private constructor()
  free(): void
  [Symbol.dispose](): void
  /**
   * Verifies and applies signatures returned by Ledger's PCZT signer.
   */
  apply_ledger_signatures(value: any, account_index: number): Pczt
  /**
   * Combines this PCZT with another representing the same transaction.
   *
   * Used after external signing: `self` is the full PCZT kept by the wallet
   * (with witnesses) and `other` is the redacted PCZT returned by the signer
   * (with signatures). The result carries both, ready for proving and
   * extraction.
   */
  combine(other: Pczt): Pczt
  /**
   * Deserialize to a Pczt from postcard bytes.
   */
  static from_bytes(bytes: Uint8Array): Pczt
  /**
   * Returns a Pczt from a JSON object
   */
  static from_json(s: any): Pczt
  /**
   * Strips prover-only data so the PCZT is small enough to transport to an
   * external signer (e.g. Keystone) as an animated QR.
   *
   * Mirrors the "redact for signer" role used by Zashi: removes spend
   * witnesses (the per-note Merkle authentication paths that dominate the
   * serialized size) and the `zcash_client_backend` proprietary metadata.
   * The signer only needs the spend randomizers, values and derivation
   * paths, so the redacted PCZT still produces valid signatures. The
   * original (full) PCZT must be retained and merged back with [`combine`]
   * after signing to restore the witnesses required for proving.
   *
   * [`combine`]: Pczt::combine
   */
  redact_for_signer(): Pczt
  /**
   * Returns the postcard serialization of the Pczt.
   */
  serialize(): Uint8Array
  /**
   * Returns a JSON object with the details of the Pczt.
   */
  to_json(): any
  /**
   * Produces the structured transaction consumed by Ledger's Zcash signer.
   * The returned action-index arrays are retained by the wallet and bind the
   * device's compact signature result back to the original PCZT actions.
   */
  to_ledger_signing_payload(account_index: number): any
}

/**
 * PCZT handling the frontend needs around a signing session: shrink the request, read what to sign,
 * put the signatures back.
 *
 * Deliberately no proving: building and proving belongs to the wallet's own transaction path, and
 * linking Halo2 here would double the module size for something already present.
 */
export class PcztTools {
  private constructor()
  free(): void
  [Symbol.dispose](): void
  /**
   * Every Ironwood action's `alpha`, 32 bytes each, in action order. This is what the coordinator
   * hands to the signers, and what `Verification::rk` needs.
   */
  static action_alphas(bytes: Uint8Array): Uint8Array
  /**
   * Every Ironwood action's `rk`, 32 bytes each, in action order.
   */
  static action_rks(bytes: Uint8Array): Uint8Array
  /**
   * Write signatures back. `signatures` is 64 bytes per action, positionally matching `indices`.
   */
  static apply_signatures(
    bytes: Uint8Array,
    indices: Uint8Array,
    signatures: Uint8Array
  ): Uint8Array
  /**
   * Fail unless this transaction is one the vault is allowed to sign (V6, Ironwood only, no
   * transparent or Sapling part).
   */
  static check(bytes: Uint8Array): void
  /**
   * Whether every action's `rk` equals `ak + alpha·G`. Run this on the signer before approving.
   */
  static check_action_bindings(
    bytes: Uint8Array,
    group_verifying_key: Uint8Array,
    alphas: Uint8Array
  ): void
  /**
   * The signer's own reading of the transaction: every output (recipient, amount, change, memo) and
   * every spend, with the totals and the fee.
   *
   * Returns `[reviewedPcztSha256, outputs, spends, sentTotal, changeTotal, fee, header]` where:
   *
   * * `reviewedPcztSha256` — SHA-256 of **the bytes passed in**, so a caller can persist "this is the
   *   transaction I reviewed" and compare it later. Compute it on the PCZT the user was shown, not on a
   *   later, proved copy: proving changes the bytes.
   * * `outputs` — array of `[recipient(43), value, isChange, memoOrNull]`. `memoOrNull` is either the
   *   exact 512-byte memo (ZIP-302 marker and padding included) or `null` for "could not verify"; the
   *   two must never be conflated, so a caller that needs a memo must reject `null`.
   * * `spends` — array of `[actionIndex, nullifier(32), value]`, one per spend that belongs to this
   *   viewing key. The first element is the position **inside the bundle**, which is what signature
   *   write-back needs; filler actions shift it, so it is not the position in this array.
   * * `sentTotal` / `changeTotal` / `fee` — in zats, as JS `Number`s. ZEC has 8 decimals, so every valid
   *   amount (≤ 21e6 ZEC = 2.1e15 zats) is well inside `Number.MAX_SAFE_INTEGER`; callers should still
   *   reject anything above that rather than trust the conversion.
   * * `header` — `{ txVersion, versionGroupId, consensusBranchId, expiryHeight, coinType }`, read from the
   *   PCZT's global section. `coinType` is the builder's claim (0 mainnet, 1 testnet), not a proof of
   *   network; compare it with the wallet's configuration.
   *
   * Fails wholesale if any check fails: there is no "partially reviewed" result to approve.
   */
  static review(bytes: Uint8Array, fvk: Uint8Array): Array<any>
  /**
   * The shielded sighash, recomputed from the PCZT. Signers must use this value, never one handed
   * to them by the coordinator.
   */
  static shielded_sighash(bytes: Uint8Array): Uint8Array
  /**
   * The action indices this signer must produce signatures for, in bundle order.
   *
   * A bundle has one spend and one output per action, so a transaction that pays two addresses carries a
   * zero-value filler spend that belongs to nobody. Those actions must be excluded from signing — their
   * `rk` is not the group key — while their original `action_index` values are what signature write-back
   * needs. Signing the position in this array instead of the index is the bug this returns indices to
   * prevent.
   *
   * Fails if an action is neither ours nor a valid filler: a non-zero spend whose `rk` is not
   * `ak + alpha·G`, or a zero-value one that arrives unsigned.
   */
  static signingSet(bytes: Uint8Array, group_verifying_key: Uint8Array): Uint8Array
  /**
   * Drop the zk proof: the transport copy. The coordinator keeps its own proven copy for applying
   * signatures.
   */
  static strip_proofs(bytes: Uint8Array): Uint8Array
}

export class ProofGenerationKey {
  private constructor()
  free(): void
  [Symbol.dispose](): void
}

export class Proposal {
  private constructor()
  free(): void
  [Symbol.dispose](): void
}

/**
 * The roster hash, computed here so no other language keeps its own copy of the encoding.
 *
 * The wire format is fixed by agreement with the mobile client; the domain tag is concatenated raw,
 * every field carries a 4-byte big-endian length, and numbers are canonical decimal text. A different
 * encoding produces a different hash, and two devices that disagree on the roster hash will refuse to
 * proceed — which is the point, but makes a silent drift expensive to debug.
 */
export class RosterManifest {
  free(): void
  [Symbol.dispose](): void
  /**
   * Add a participant. Call order does not matter: the encoding sorts by slot.
   */
  add_participant(
    slot: number,
    identity_public_key: Uint8Array,
    transport_public_key: Uint8Array
  ): void
  /**
   * The exact bytes that are hashed. For test vectors and debugging.
   */
  canonical_bytes(): Uint8Array
  /**
   * `SHA-256(canonical_bytes)`.
   */
  hash(): Uint8Array
  /**
   * Lowercase hex of the hash, for comparing against the agreed vectors.
   */
  hash_hex(): string
  constructor(
    group_id: string,
    protocol_version: number,
    ciphersuite: string,
    threshold: number,
    participants: number
  )
}

/**
 * Sealed, authenticated messages between ceremony participants.
 *
 * The DKG needs this for its round-2 packages (handled internally), and KEYSET_SETUP needs it for
 * the `qsk`, which is the `nk`/`rivk` source and therefore a scanning secret: whoever relays it must
 * not read it.
 *
 * Both parties' static keys are known from the DKG, so sealing is a single message with no round
 * trip. `prologue` binds the participant set: a device that is shown a different roster derives a
 * different key schedule and cannot open the message.
 */
export class Sealed {
  private constructor()
  free(): void
  [Symbol.dispose](): void
  /**
   * Open a message from `sender_public`. Fails if the pair, the ceremony or the bytes are wrong.
   */
  static open(
    recipient_secret: Uint8Array,
    sender_public: Uint8Array,
    prologue: Uint8Array,
    ciphertext: Uint8Array
  ): Uint8Array
  /**
   * The prologue for a participant set, given their static public keys by slot.
   */
  static prologue(statics: MessageSet): Uint8Array
  /**
   * The prologue with the round-1 transcript folded in: the roster plus what each participant said.
   *
   * Use this instead of `prologue` once round-1 broadcasts exist. A coordinator that relays a different
   * round-1 set to different devices then cannot have its round-2 packages opened, because each device
   * seals under the transcript it was actually shown.
   */
  static prologueWithTranscript(statics: MessageSet, round1: MessageSet): Uint8Array
  /**
   * Seal `plaintext` so only the holder of `recipient_public` can read it.
   */
  static seal(
    sender_secret: Uint8Array,
    recipient_public: Uint8Array,
    prologue: Uint8Array,
    plaintext: Uint8Array
  ): Uint8Array
}

export class SeedFingerprint {
  free(): void
  [Symbol.dispose](): void
  static from_bytes(bytes: Uint8Array): SeedFingerprint
  constructor(seed: Uint8Array)
  to_bytes(): Uint8Array
}

/**
 * Session marker helpers: what the host persists to know a session was in flight.
 */
export class SessionMarker {
  private constructor()
  free(): void
  [Symbol.dispose](): void
  /**
   * Advance a marker once commitments have left the device.
   */
  static committed(session_id: Uint8Array): Uint8Array
  /**
   * Build the marker to persist right after a session starts.
   */
  static created(session_id: Uint8Array): Uint8Array
  /**
   * What to do about a persisted marker: `"clean"`, `"discardable"` or `"burned"`.
   */
  static recover(marker?: Uint8Array | null): string
  /**
   * The session a marker refers to, as 16 bytes, or `None` when clean.
   */
  static session_id(marker?: Uint8Array | null): Uint8Array | undefined
}

/**
 * A device's key share, bound to a group and slot.
 */
export class ShareBackup {
  free(): void
  [Symbol.dispose](): void
  device_id(): Uint8Array
  /**
   * Load and validate against the expected group and slot.
   */
  static from_bytes(
    bytes: Uint8Array,
    group_verifying_key: Uint8Array,
    expected_slot: number
  ): ShareBackup
  /**
   * Rebuild a share from a 32-byte signing scalar plus the group's public data.
   *
   * This is the 24-word path: a BIP39 mnemonic carries 256 bits, which fits the scalar and nothing
   * else. The identifier and verifying share are derived from `slot` and the scalar, and `ak` /
   * `min_signers` come from the group's public state, which is not secret.
   *
   * **Pass `publicKeyPackage` whenever you have it.** With it, the reconstructed share is checked
   * against the group's record for this slot, so a wrong scalar fails here instead of producing
   * signature shares that never aggregate.
   */
  static from_scalar(
    signing_scalar: Uint8Array,
    group_verifying_key: Uint8Array,
    slot: number,
    min_signers: number,
    device_id: Uint8Array,
    vault_id: Uint8Array,
    public_key_package?: Uint8Array | null
  ): ShareBackup
  group_verifying_key(): Uint8Array
  /**
   * The key package, for handing to a [`SignerSession`]. Kept out of `to_bytes` on purpose: the
   * backup blob is what the host stores, not what it needs in memory.
   */
  key_package(): Uint8Array
  /**
   * Wrap a key package for storage. `device_id` and `vault_id` are opaque to the wasm and must be
   * stable across restores.
   */
  constructor(
    key_package: Uint8Array,
    slot: number,
    device_id: Uint8Array,
    vault_id: Uint8Array,
    group_verifying_key: Uint8Array
  )
  /**
   * The 32-byte signing scalar, for a 24-word backup.
   *
   * This is all a BIP39 mnemonic can carry (256 bits); `from_scalar` rebuilds the rest from public
   * data. **Drop the reference as soon as the words are encoded** — do not keep it, return it, or log
   * it.
   */
  signing_scalar(): Uint8Array
  slot(): number
  /**
   * Bytes for the host to seal and store. The wasm does not encrypt.
   */
  to_bytes(): Uint8Array
  vault_id(): Uint8Array
}

/**
 * Signer side of a signing session. Holds the key share and the nonces.
 */
export class Signer {
  free(): void
  [Symbol.dispose](): void
  /**
   * Record that the user approved. Only after this can a share exist.
   */
  approve(): void
  /**
   * Consume `SIGN_INIT`, produce the `SIGN_COMMITMENTS` envelope to send back.
   */
  init(envelope: Uint8Array): Uint8Array
  constructor(
    session_id: Uint8Array,
    my_slot: number,
    participants: number,
    key_package: Uint8Array
  )
  /**
   * `"committed"` / `"consumed"` per action, so the host can persist the nonce state.
   */
  nonce_states(): Uint8Array
  /**
   * Accept the coordinator's outcome report: `[status, txid | null, note]`.
   */
  on_result(envelope: Uint8Array): Array<any>
  /**
   * Consume `SIGN_PAYLOAD`. Returns `[sighash: Uint8Array, alphas: Uint8Array]` for the caller to
   * verify against the PCZT **before** approving.
   */
  payload(envelope: Uint8Array): Array<any>
  phase(): string
  /**
   * Refuse to sign, and end the session. `code`: 1 = user declined, 2 = verification failed,
   * 3 = malformed payload, 4 = expired.
   */
  reject(code: number, note: string): Uint8Array
  /**
   * Produce the `SIGN_SHARE` envelope. Consumes the nonces.
   */
  share(): Uint8Array
}

export class TransactionRequest {
  free(): void
  [Symbol.dispose](): void
  static empty(): TransactionRequest
  static from_uri(uri: string): TransactionRequest
  constructor(payments: PaymentRequest[])
  payment_requests(): PaymentRequest[]
  to_uri(): string
  total(): bigint
}

/**
 * A Zcash viewing key
 *
 * This is a wrapper around the `zcash_keys::keys::ViewingKey` type.
 * UFVKs should be generated from a spending key by calling `to_unified_full_viewing_key`
 * They can also be encoded and decoded to a canonical string representation
 */
export class UnifiedFullViewingKey {
  free(): void
  [Symbol.dispose](): void
  encode(network: string): string
  constructor(network: string, encoding: string)
}

export class UnifiedSpendingKey {
  free(): void
  [Symbol.dispose](): void
  /**
   * Construct a new UnifiedSpendingKey
   *
   * # Arguments
   *
   * * `network` - Must be either "main" or "test"
   * * `seed` - At least 32 bytes of entry. Care should be taken as to how this is derived
   * * `hd_index` - [ZIP32](https://zips.z.cash/zip-0032) hierarchical deterministic index of the account
   */
  constructor(network: string, seed: Uint8Array, hd_index: number)
  to_sapling_proof_generation_key(): ProofGenerationKey
  /**
   * Obtain the UFVK corresponding to this spending key
   */
  to_unified_full_viewing_key(): UnifiedFullViewingKey
}

/**
 * Verification helpers the frontend needs before it broadcasts anything.
 */
export class Verification {
  private constructor()
  free(): void
  [Symbol.dispose](): void
  /**
   * `rk = ak + alpha·G`, as the transaction carries it.
   */
  static rk(group_verifying_key: Uint8Array, alpha: Uint8Array): Uint8Array
  /**
   * Check an aggregated spend authorization signature. Run this before broadcasting.
   */
  static verify_spend_auth(
    group_verifying_key: Uint8Array,
    alpha: Uint8Array,
    message: Uint8Array,
    signature: Uint8Array
  ): void
}

export class WalletSummary {
  private constructor()
  /**
   ** Return copy of self without private attributes.
   */
  toJSON(): Object
  /**
   * Return stringified version of self.
   */
  toString(): string
  free(): void
  [Symbol.dispose](): void
  chain_tip_height: number
  fully_scanned_height: number
  next_ironwood_subtree_index: bigint
  next_orchard_subtree_index: bigint
  next_sapling_subtree_index: bigint
  readonly account_balances: any
}

export class WebVotingSession {
  free(): void
  [Symbol.dispose](): void
  checkEligibility(round_id: string): Promise<VotingEligibility>
  /**
   * The host obtains explicit user confirmation naming this round before calling.
   */
  clearRound(round_id: string): Promise<void>
  discoverRounds(): Promise<VotingDiscovery>
  exportState(): Uint8Array
  constructor(
    wallet: WebWallet,
    account_id: number,
    voting_db_bytes: Uint8Array | null | undefined,
    persist_checkpoint: VotingCheckpoint
  )
  prepareRound(round_id: string): Promise<PreparedVotingRound>
  resumeRound(round_id: string): Promise<VotingActionResult>
  roundProposals(round_id: string): Promise<VotingProposal[]>
  roundStatus(round_id: string): Promise<VotingRoundStatus>
  submitBallot(round_id: string, decisions: BallotDecision[]): Promise<VotingActionResult>
  submitDelegation(
    round_id: string,
    usk: UnifiedSpendingKey,
    seed_fingerprint: SeedFingerprint
  ): Promise<VotingActionResult>
  readonly storageKey: string
}

export class WebWallet {
  free(): void
  [Symbol.dispose](): void
  /**
   * Benchmark helper: download a block range over gRPC-web without scanning.
   * Returns the number of blocks fetched. Used to probe download throughput.
   */
  bench_download_range(start_height: number, count: number): Promise<number>
  /**
   * Benchmark helper: one baseline journal batch with per-stage timings (ms)
   * as JSON `{"subtree","setup","download","scan"}`, or undefined when synced.
   * When `refresh` is false, session setup is skipped (call
   * `sync_session_setup` once first).
   */
  bench_prepare_sync_batch_timed(
    batch_size: number | null | undefined,
    refresh: boolean
  ): Promise<string | undefined>
  create_account(
    account_name: string,
    seed_phrase: string,
    account_hd_index: number,
    birthday_height?: number | null,
    passphrase?: string | null
  ): Promise<number>
  /**
   * Import a watch-only spending account from an encoded UFVK (hardware wallet flow).
   *
   * # Arguments
   * * `account_name` - Display name for the account
   * * `ufvk` - The encoded Unified Full Viewing Key exported by the device
   * * `seed_fingerprint` - 32-byte ZIP-32 seed fingerprint exported by the device
   * * `account_hd_index` - ZIP-32 account index on the device
   * * `birthday_height` - Block height to start scanning from
   * * `key_source` - Optional tag describing the key origin (e.g. "keystone")
   *
   * # Returns
   * The new account id
   */
  create_account_ufvk(
    account_name: string,
    ufvk: string,
    seed_fingerprint: Uint8Array,
    account_hd_index: number,
    birthday_height?: number | null,
    key_source?: string | null
  ): Promise<number>
  /**
   * Create an unsigned, unproven PCZT for a transfer (hardware wallet flow).
   *
   * The returned PCZT carries ZIP-32 derivation metadata so an external signer
   * (e.g. Keystone) can locate its keys. Serialize it with `Pczt.serialize()`
   * before transporting via QR. `marginal_fee_zats` selects the ZIP-317 fee
   * tier so hardware sends honor the same dynamic-fee tiers as software sends.
   * Import a spending account from a UFVK with no ZIP-32 derivation (FROST vault flow).
   *
   * Use this for a vault whose FVK was produced by a DKG rather than a seed. Unlike
   * [`Self::create_account_ufvk`] there is no `seed_fingerprint`/`account_hd_index` to pass, and
   * none is invented: the account is recorded as having no derivation.
   */
  create_account_ufvk_external(
    account_name: string,
    ufvk: string,
    birthday_height?: number | null,
    key_source?: string | null
  ): Promise<number>
  db_to_bytes(): Promise<Uint8Array>
  /**
   * The callback must complete synchronously; returned Promises are not awaited.
   * A thrown value rejects this call unchanged.
   */
  db_to_bytes_chunked(callback: Function): Promise<void>
  estimate_orchard_migration_fee(
    account_id: number,
    to_address: string,
    memo: Uint8Array | null | undefined,
    marginal_fee_zats: bigint
  ): Promise<bigint>
  estimate_pczt_max_transfer(
    account_id: number,
    to_address: string,
    memo: Uint8Array | null | undefined,
    marginal_fee_zats: bigint
  ): Promise<any>
  estimate_pczt_max_transparent_transfer(
    account_id: number,
    to_address: string,
    memo: Uint8Array | null | undefined,
    marginal_fee_zats: bigint
  ): Promise<any>
  estimate_pczt_shield_fee(account_id: number, marginal_fee_zats: bigint): Promise<bigint>
  estimate_pczt_transfer_fee(
    account_id: number,
    to_address: string,
    value: bigint,
    memo: Uint8Array | null | undefined,
    marginal_fee_zats: bigint
  ): Promise<bigint>
  estimate_pczt_transparent_transfer_fee(
    account_id: number,
    to_address: string,
    value: bigint,
    memo: Uint8Array | null | undefined,
    marginal_fee_zats: bigint
  ): Promise<bigint>
  estimate_transfer(
    account_id: number,
    to_address: string,
    value: bigint,
    funding_source: 'shielded' | 'transparent',
    memo?: Uint8Array | null,
    marginal_fee_zats?: bigint | null,
    expiry_delta_blocks?: number | null
  ): Promise<TransferEstimate>
  /**
   * Get the birthday height for a specific account
   *
   * # Arguments
   *
   * * `account_id` - The account ID to get the birthday height for
   *
   * # Returns
   *
   * The birthday height (block height) for the specified account
   *
   * # Example
   *
   * ```javascript
   * const accountId = 0;
   * const birthdayHeight = await wallet.get_account_birthday(accountId);
   * console.log(`Account ${accountId} birthday height: ${birthdayHeight}`);
   * ```
   */
  get_account_birthday(account_id: number): Promise<number>
  /**
   * Get the HD account index for an account.
   *
   * This returns the ZIP-32 account index that was used to derive this account's keys.
   * Returns None if the account was imported and doesn't have derivation info.
   *
   * # Arguments
   *
   * * `account_id` - The account ID
   *
   * # Returns
   *
   * The HD account index (u32), or None if not available
   */
  get_account_hd_index(account_id: number): Promise<number | undefined>
  /**
   * Get account ID by account name
   *
   * # Arguments
   *
   * * `account_name` - The name of the account to find
   *
   * # Returns
   *
   * Returns the account ID as u32 if found
   *
   * # Example
   *
   * ```javascript
   * const accountId = await wallet.get_account_id_by_name("MyAccount");
   * console.log("Account ID:", accountId);
   * ```
   */
  get_account_id_by_name(account_name: string): Promise<number>
  /**
   * Find the block height closest to a given Unix timestamp
   *
   * Uses binary search to efficiently locate the block height corresponding
   * to a specific time. Useful for determining wallet birthday heights based
   * on dates.
   *
   * # Arguments
   *
   * * `time` - Unix timestamp (seconds since epoch)
   *
   * # Returns
   *
   * Block height closest to the given timestamp (within ~1000 blocks precision)
   *
   * # Example
   *
   * ```javascript
   * // Find block height for January 1, 2024
   * const timestamp = Math.floor(new Date('2024-01-01').getTime() / 1000);
   * const height = await wallet.get_block_by_time(timestamp);
   * console.log(`Block height at 2024-01-01: ${height}`);
   *
   * // Use as birthday height when importing a wallet
   * const birthdayTimestamp = Math.floor(new Date('2023-06-15').getTime() / 1000);
   * const birthdayHeight = await wallet.get_block_by_time(birthdayTimestamp);
   * ```
   */
  get_block_by_time(time: number): Promise<number>
  /**
   * Get the Unix timestamp of a block at a given height
   *
   * # Arguments
   *
   * * `height` - The block height
   *
   * # Returns
   *
   * Unix timestamp (seconds since epoch) when the block was mined
   *
   * # Example
   *
   * ```javascript
   * const height = 2855000;
   * const timestamp = await wallet.get_block_time(height);
   * const date = new Date(timestamp * 1000);
   * console.log(`Block ${height} was mined at: ${date}`);
   * ```
   */
  get_block_time(height: number): Promise<number>
  /**
   * Returns the configured NU6.3 activation height for the selected network.
   */
  get_ironwood_activation_height(): number | undefined
  get_latest_block(): Promise<bigint>
  /**
   * Get the latest block height from the blockchain
   *
   * # Returns
   *
   * The current chain tip height
   *
   * # Example
   *
   * ```javascript
   * const latestHeight = await wallet.get_latest_height();
   * console.log(`Current blockchain height: ${latestHeight}`);
   * ```
   */
  get_latest_height(): Promise<number>
  /**
   * Generate and persist the next shielded receiving address for an account.
   *
   * This returns a unified address containing the account's available shielded receivers
   * (Orchard/Sapling) and no transparent receiver. It advances the wallet's stored address
   * position, so callers should persist the wallet DB after using this method.
   *
   * # Arguments
   *
   * * `account_id` - The account ID to generate the next shielded address for
   *
   * # Returns
   *
   * Returns a UnifiedAddresses object. `transparent` and `address_index` will be null.
   */
  get_next_shielded_address(account_id: number): Promise<any>
  /**
   * The raw bytes of a stored transaction, or `undefined` when the wallet has no record of it.
   *
   * Lets a caller persist the exact transaction next to its own intent record rather than depending on
   * the wallet database alone.
   */
  get_stored_transaction_bytes(txid: string): Promise<Uint8Array | undefined>
  get_transaction_history(account_id: number): Promise<any>
  /**
   * Get addresses for an account
   *
   * # Arguments
   *
   * * `account_id` - The account ID to get addresses for
   *
   * # Returns
   *
   * Returns a UnifiedAddresses object containing:
   * - unified: The shielded unified address (u1 format with Orchard/Sapling receivers only)
   * - orchard: Orchard-only unified address (if available)
   * - sapling: Sapling-only unified address (u1 format, if available)
   * - sapling_zs: Sapling traditional address (zs format, if available)
   * - transparent: Transparent P2PKH address (if available)
   *
   * # Example
   *
   * ```javascript
   * const addresses = await wallet.get_unified_addresses(accountId);
   * // Display the selected address in the wallet UI; avoid logging account addresses.
   * ```
   */
  get_unified_addresses(account_id: number): Promise<any>
  get_wallet_summary(): Promise<WalletSummary | undefined>
  /**
   * List the user-facing shielded receiving addresses generated for an account.
   *
   * The wallet database also stores Unified Addresses used to discover transparent
   * receivers. Those internal records are excluded unless they are the account's default
   * address. Results are ordered by diversifier index from oldest to newest.
   */
  list_shielded_addresses(account_id: number): Promise<any>
  /**
   * The policy is runtime configuration. Supply it again when restoring db_bytes.
   * Omitting it or passing null uses ConfirmationsPolicy::default().
   */
  constructor(
    network: string,
    lightwalletd_url: string,
    db_bytes?: Uint8Array | null,
    confirmations_policy?: ConfirmationsPolicy | null,
    compact_block_cdn?: CompactBlockCdnOptions | null,
    zero_indexer_options?: ZeroIndexerOptions | null
  )
  oneclick_pczt_orchard_migration(
    account_id: number,
    to_address: string,
    usk: UnifiedSpendingKey,
    seed_fp: SeedFingerprint,
    sapling_proof_gen_key: ProofGenerationKey | null | undefined,
    memo: Uint8Array | null | undefined,
    marginal_fee_zats: bigint,
    expiry_delta_blocks?: number | null
  ): Promise<string>
  oneclick_pczt_shield(
    account_id: number,
    usk: UnifiedSpendingKey,
    seed_fp: SeedFingerprint,
    sapling_proof_gen_key?: ProofGenerationKey | null
  ): Promise<string>
  oneclick_pczt_shield_dynamic_fee(
    account_id: number,
    usk: UnifiedSpendingKey,
    seed_fp: SeedFingerprint,
    sapling_proof_gen_key: ProofGenerationKey | null | undefined,
    marginal_fee_zats: bigint,
    expiry_delta_blocks?: number | null
  ): Promise<string>
  oneclick_pczt_transfer(
    account_id: number,
    to_address: string,
    value: bigint,
    usk: UnifiedSpendingKey,
    seed_fp: SeedFingerprint,
    sapling_proof_gen_key?: ProofGenerationKey | null,
    memo?: Uint8Array | null
  ): Promise<string>
  oneclick_pczt_transfer_dynamic_fee(
    account_id: number,
    to_address: string,
    value: bigint,
    usk: UnifiedSpendingKey,
    seed_fp: SeedFingerprint,
    sapling_proof_gen_key: ProofGenerationKey | null | undefined,
    memo: Uint8Array | null | undefined,
    marginal_fee_zats: bigint,
    expiry_delta_blocks?: number | null
  ): Promise<string>
  oneclick_pczt_transparent_transfer(
    account_id: number,
    to_address: string,
    value: bigint,
    usk: UnifiedSpendingKey,
    seed_fp: SeedFingerprint,
    sapling_proof_gen_key?: ProofGenerationKey | null,
    memo?: Uint8Array | null
  ): Promise<string>
  oneclick_pczt_transparent_transfer_dynamic_fee(
    account_id: number,
    to_address: string,
    value: bigint,
    usk: UnifiedSpendingKey,
    seed_fp: SeedFingerprint,
    sapling_proof_gen_key: ProofGenerationKey | null | undefined,
    memo: Uint8Array | null | undefined,
    marginal_fee_zats: bigint,
    expiry_delta_blocks?: number | null
  ): Promise<string>
  oneclick_transfer(
    account_id: number,
    to_address: string,
    value: bigint,
    usk: UnifiedSpendingKey,
    funding_source: 'shielded' | 'transparent',
    memo?: Uint8Array | null,
    marginal_fee_zats?: bigint | null,
    expiry_delta_blocks?: number | null
  ): Promise<TransferResult>
  pczt_create(
    account_id: number,
    to_address: string,
    value: bigint,
    memo: Uint8Array | null | undefined,
    marginal_fee_zats: bigint
  ): Promise<Pczt>
  /**
   * Create an unsigned, unproven PCZT funded only by transparent inputs.
   * `marginal_fee_zats` selects the ZIP-317 fee tier, matching software sends.
   */
  pczt_create_transparent(
    account_id: number,
    to_address: string,
    value: bigint,
    memo: Uint8Array | null | undefined,
    marginal_fee_zats: bigint
  ): Promise<Pczt>
  /**
   * Create a V6 PCZT that sweeps spendable Orchard funds to this account's Ironwood pool.
   */
  pczt_orchard_migration_create(
    account_id: number,
    to_address: string,
    memo: Uint8Array | null | undefined,
    marginal_fee_zats: bigint,
    expiry_delta_blocks?: number | null
  ): Promise<Pczt>
  /**
   * Prove an externally signed PCZT **without sending it**.
   *
   * Hardware-wallet and vault accounts never hold Sapling notes, so no Sapling proof generation key is
   * needed.
   *
   * # Returns
   * The proved PCZT, ready for `pczt_store`
   */
  pczt_prove(pczt: Pczt): Promise<Pczt>
  /**
   * Prove and broadcast an externally signed PCZT (hardware wallet flow).
   *
   * Hardware-wallet accounts never hold Sapling notes (Keystone supports
   * transparent + Orchard only), so no Sapling proof generation key is needed.
   *
   * # Returns
   * Transaction ID string on success
   */
  pczt_prove_and_send(pczt: Pczt): Promise<string>
  /**
   * Create an unsigned, unproven shielding PCZT (transparent -> Orchard) for
   * external signing (hardware wallet flow). `marginal_fee_zats` selects the
   * ZIP-317 fee tier so hardware shields honor the dynamic-fee tiers too.
   */
  pczt_shield_create(account_id: number, marginal_fee_zats: bigint): Promise<Pczt>
  /**
   * Finalize a proved PCZT and store the transaction, **without broadcasting**.
   *
   * This is the point where a caller can obtain a stable transaction id and the transaction itself
   * before anything reaches the network. After it returns, the transaction is in the wallet database
   * and can be submitted later by txid with `send_authorized_transactions` — including after a restart,
   * if the database itself survived.
   *
   * # Returns
   * Transaction ID string (lowercase hex, display order — the same order as `txid` on explorers)
   */
  pczt_store(pczt: Pczt): Promise<string>
  /**
   * Finalize a proved PCZT, store it, and return everything a caller must persist before submitting.
   *
   * Returns `{ txId, rawTxSha256, rawTxLen, network }`:
   *
   * * `txId` — display-order lowercase hex, the same id explorers show.
   * * `rawTxSha256` — SHA-256 of the stored transaction bytes, lowercase hex. It identifies *the bytes you
   *   stored*: finalizing the same PCZT twice yields the same `txId` and different bytes, so this digest
   *   cannot be compared across two separate finalizations.
   * * `rawTxLen` — byte length of the stored transaction.
   * * `network` — the wallet's configured network (`"mainnet"` / `"testnet"`). This is configuration, not a
   *   proof read out of the transaction.
   *
   * The account id is deliberately absent: the PCZT's proposal metadata that records it is private to the
   * wallet backend, so we cannot read it back. A caller that needs the binding must keep its own record.
   */
  pczt_store_detailed(pczt: Pczt): Promise<any>
  /**
   * Journal-aware sync: download + scan one batch, return journal data for persistence.
   * Returns null if fully synced, or Uint8Array with journal entry data.
   * When `refresh` is false, session setup is skipped (call `sync_session_setup`
   * once at the start of the catch-up session first).
   */
  prepare_sync_batch(
    batch_size: number | null | undefined,
    refresh: boolean
  ): Promise<Uint8Array | undefined>
  /**
   * Optimized journal-aware sync: same as [`prepare_sync_batch`] but uses
   * External-only IVK scanning for contiguous forward ranges.
   */
  prepare_sync_batch_optimized(batch_size?: number | null): Promise<Uint8Array | undefined>
  /**
   * Replay multiple journal entries in sequence (for recovery).
   */
  replay_journal_entries(entries: Uint8Array[]): Promise<void>
  /**
   * Scan a journal entry for recovery (replay from base snapshot + journal).
   * Returns true if more scan ranges remain.
   */
  scan_journal_entry(journal_data: Uint8Array): Promise<boolean>
  send_authorized_transactions(txids: Uint8Array): Promise<TransferResult>
  set_zero_indexer_options(options: ZeroIndexerOptions | null): void
  sync(): Promise<void>
  /**
   * Runs a single batch of the sync process without looping.
   * Returns `true` if a scan range was processed, `false` if no scan ranges were suggested.
   */
  sync_next_batch(batch_size?: number | null): Promise<boolean>
  /**
   * Runs a single batch using the optimized scanning strategy.
   * Returns `true` if a scan range was processed, `false` if no scan ranges were suggested.
   */
  sync_next_batch_optimized(batch_size?: number | null): Promise<boolean>
  /**
   * Run session-level setup (subtree roots, chain tip, transparent UTXOs)
   * once before a multi-batch catch-up so subsequent batches can skip it.
   */
  sync_session_setup(): Promise<void>
}

/**
 * Generate a new 24-word BIP-39 mnemonic phrase.
 *
 * # Arguments
 *
 * * `word_count` - Number of words in the mnemonic. Must be 24 for new wallet generation.
 *
 * # Returns
 *
 * A string containing the mnemonic phrase
 *
 * # Example
 *
 * ```javascript
 * const mnemonic = generate_mnemonic(24);
 * // Show the phrase only in the wallet's protected backup flow; never log it.
 * ```
 */
export function generate_mnemonic(word_count: number): string

export function initThreadPool(num_threads: number): Promise<any>

/**
 * Get all addresses (shielded unified, orchard, sapling, transparent) from a mnemonic phrase.
 *
 * # Arguments
 *
 * * `network` - Network name ("main" or "test")
 * * `phrase` - The mnemonic phrase
 * * `passphrase` - Optional passphrase (use empty string "" if none)
 * * `account_index` - The account index for HD derivation (usually 0)
 *
 * # Returns
 *
 * A JSON object containing all address types
 *
 * # Example
 *
 * ```javascript
 * const mnemonic = generate_mnemonic(24);
 * const addresses = mnemonic_to_addresses(
 *     "main",
 *     mnemonic,
 *     "",  // no passphrase
 *     0    // first account
 * );
 * // Display the selected receiver in the wallet UI; avoid logging account addresses.
 * ```
 */
export function mnemonic_to_addresses(
  network: string,
  phrase: string,
  passphrase: string,
  account_index: number
): any

/**
 * Convert a mnemonic phrase to a seed with an optional passphrase.
 *
 * # Arguments
 *
 * * `phrase` - The mnemonic phrase
 * * `passphrase` - Optional passphrase (use empty string for no passphrase)
 *
 * # Returns
 *
 * A 64-byte seed that can be used for key derivation
 *
 * # Example
 *
 * ```javascript
 * const seed = mnemonic_to_seed("abandon abandon abandon ... art", "");
 * // Use the seed for local key derivation; never log or persist it as plaintext.
 * ```
 */
export function mnemonic_to_seed(phrase: string, passphrase: string): Uint8Array

/**
 * Generate a SeedFingerprint from a mnemonic phrase.
 *
 * # Arguments
 *
 * * `phrase` - The mnemonic phrase
 * * `passphrase` - Optional passphrase (use empty string "" if none)
 *
 * # Returns
 *
 * A SeedFingerprint that can be used for key derivation path identification
 *
 * # Example
 *
 * ```javascript
 * const mnemonic = generate_mnemonic(24);
 * const seed_fp = mnemonic_to_seed_fingerprint(
 *     mnemonic,
 *     ""  // no passphrase
 * );
 * ```
 */
export function mnemonic_to_seed_fingerprint(phrase: string, passphrase: string): SeedFingerprint

/**
 * Generate a UnifiedSpendingKey from a mnemonic phrase.
 *
 * # Arguments
 *
 * * `network` - Network name ("main" or "test")
 * * `phrase` - The mnemonic phrase
 * * `passphrase` - Optional passphrase (use empty string "" if none)
 * * `account_index` - The account index for HD derivation (usually 0)
 *
 * # Returns
 *
 * A UnifiedSpendingKey that can be used for signing transactions
 *
 * # Example
 *
 * ```javascript
 * const mnemonic = generate_mnemonic(24);
 * const usk = mnemonic_to_spending_key(
 *     "main",
 *     mnemonic,
 *     "",  // no passphrase
 *     0    // first account
 * );
 * ```
 */
export function mnemonic_to_spending_key(
  network: string,
  phrase: string,
  passphrase: string,
  account_index: number
): UnifiedSpendingKey

/**
 * Get a transparent address and public key from a mnemonic at a specific external address index.
 *
 * # Arguments
 *
 * * `network` - Network name ("main" or "test")
 * * `phrase` - The mnemonic phrase
 * * `passphrase` - Optional passphrase (use empty string "" if none)
 * * `account_index` - The account index for HD derivation (usually 0)
 * * `address_index` - The external transparent child address index
 */
export function mnemonic_to_transparent_address(
  network: string,
  phrase: string,
  passphrase: string,
  account_index: number,
  address_index: number
): any

/**
 * Parse a unified address string and extract individual receiver addresses.
 *
 * # Arguments
 *
 * * `network` - Network name ("main" or "test")
 * * `unified_address` - The unified address string to parse
 *
 * # Returns
 *
 * A JSON object containing individual address types extracted from the unified address
 *
 * # Example
 *
 * ```javascript
 * const addresses = parse_unified_address(
 *     "main",
 *     "u1..." // unified address string
 * );
 * // Select the receiver needed by the payment flow; avoid logging addresses.
 * ```
 */
export function parse_unified_address(network: string, unified_address: string): any

/**
 * Sign a message with the transparent address private key
 *
 * This implements the Bitcoin/Zcash message signing convention compatible with
 * the `signmessage` RPC call.
 *
 * # Arguments
 *
 * * `network` - Network type ("main" or "test")
 * * `usk` - The Unified Spending Key
 * * `message` - The message to sign
 * * `address_index` - Optional external transparent address index to sign with. If omitted, the default full unified address index is used.
 *
 * # Returns
 *
 * Returns a JSON object with:
 * - signature: Hex-encoded signature (65 bytes: recovery_id + r + s)
 * - pubkey: Hex-encoded uncompressed public key (65 bytes: 04 + x + y)
 * - address: The transparent address used for signing
 *
 * # Example
 *
 * ```javascript
 * const result = await sign_message_with_transparent("main", usk, "Hello Zcash!", undefined);
 * // Return the signature to the requesting flow; avoid logging account identifiers.
 * ```
 */
export function sign_message_with_transparent(
  network: string,
  usk: UnifiedSpendingKey,
  message: string,
  address_index?: number | null
): any

/**
 * Which signing phase a session is in, for logging.
 */
export function signing_phases(): Array<any>

export function start(): void

/**
 * Entry point invoked by JavaScript in a worker.
 */
export function task_worker_entry_point(ptr: number): void

/**
 * Validate a BIP-39 mnemonic phrase.
 *
 * # Arguments
 *
 * * `phrase` - The mnemonic phrase to validate
 *
 * # Returns
 *
 * Returns Ok(()) if valid, or an error if invalid
 *
 * # Example
 *
 * ```javascript
 * try {
 *     validate_mnemonic("abandon abandon abandon ... art");
 *     console.log("Valid mnemonic");
 * } catch (e) {
 *     console.error("Invalid mnemonic:", e);
 * }
 * ```
 */
export function validate_mnemonic(phrase: string): void

export class wbg_rayon_PoolBuilder {
  private constructor()
  free(): void
  [Symbol.dispose](): void
  build(): void
  numThreads(): number
  receiver(): number
}

export function wbg_rayon_start_worker(receiver: number): void

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module

export interface InitOutput {
  readonly __wbg_blockrange_free: (a: number, b: number) => void
  readonly __wbg_get_blockrange_0: (a: number) => number
  readonly __wbg_get_blockrange_1: (a: number) => number
  readonly __wbg_get_walletsummary_chain_tip_height: (a: number) => number
  readonly __wbg_get_walletsummary_fully_scanned_height: (a: number) => number
  readonly __wbg_get_walletsummary_next_ironwood_subtree_index: (a: number) => bigint
  readonly __wbg_get_walletsummary_next_orchard_subtree_index: (a: number) => bigint
  readonly __wbg_get_walletsummary_next_sapling_subtree_index: (a: number) => bigint
  readonly __wbg_paymentrequest_free: (a: number, b: number) => void
  readonly __wbg_pczt_free: (a: number, b: number) => void
  readonly __wbg_proofgenerationkey_free: (a: number, b: number) => void
  readonly __wbg_proposal_free: (a: number, b: number) => void
  readonly __wbg_seedfingerprint_free: (a: number, b: number) => void
  readonly __wbg_set_blockrange_0: (a: number, b: number) => void
  readonly __wbg_set_blockrange_1: (a: number, b: number) => void
  readonly __wbg_set_walletsummary_chain_tip_height: (a: number, b: number) => void
  readonly __wbg_set_walletsummary_fully_scanned_height: (a: number, b: number) => void
  readonly __wbg_set_walletsummary_next_ironwood_subtree_index: (a: number, b: bigint) => void
  readonly __wbg_set_walletsummary_next_orchard_subtree_index: (a: number, b: bigint) => void
  readonly __wbg_set_walletsummary_next_sapling_subtree_index: (a: number, b: bigint) => void
  readonly __wbg_transactionrequest_free: (a: number, b: number) => void
  readonly __wbg_unifiedfullviewingkey_free: (a: number, b: number) => void
  readonly __wbg_unifiedspendingkey_free: (a: number, b: number) => void
  readonly __wbg_walletsummary_free: (a: number, b: number) => void
  readonly __wbg_webvotingsession_free: (a: number, b: number) => void
  readonly __wbg_webwallet_free: (a: number, b: number) => void
  readonly generate_mnemonic: (a: number, b: number) => void
  readonly mnemonic_to_addresses: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number
  ) => void
  readonly mnemonic_to_seed: (a: number, b: number, c: number, d: number, e: number) => void
  readonly mnemonic_to_seed_fingerprint: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number
  ) => void
  readonly mnemonic_to_spending_key: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number
  ) => void
  readonly mnemonic_to_transparent_address: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
    i: number
  ) => void
  readonly parse_unified_address: (a: number, b: number, c: number, d: number, e: number) => void
  readonly paymentrequest_amount: (a: number) => bigint
  readonly paymentrequest_label: (a: number, b: number) => void
  readonly paymentrequest_memo: (a: number, b: number) => void
  readonly paymentrequest_message: (a: number, b: number) => void
  readonly paymentrequest_new: (
    a: number,
    b: number,
    c: number,
    d: bigint,
    e: number,
    f: number,
    g: number,
    h: number,
    i: number,
    j: number,
    k: number
  ) => void
  readonly paymentrequest_other_params: (a: number, b: number) => void
  readonly paymentrequest_recipient_address: (a: number, b: number) => void
  readonly paymentrequest_simple_payment: (a: number, b: number, c: number, d: bigint) => void
  readonly pczt_apply_ledger_signatures: (a: number, b: number, c: number, d: number) => void
  readonly pczt_combine: (a: number, b: number, c: number) => void
  readonly pczt_from_bytes: (a: number, b: number, c: number) => void
  readonly pczt_from_json: (a: number, b: number) => void
  readonly pczt_redact_for_signer: (a: number) => number
  readonly pczt_serialize: (a: number, b: number) => void
  readonly pczt_to_json: (a: number, b: number) => void
  readonly pczt_to_ledger_signing_payload: (a: number, b: number, c: number) => void
  readonly seedfingerprint_from_bytes: (a: number, b: number, c: number) => void
  readonly seedfingerprint_new: (a: number, b: number, c: number) => void
  readonly seedfingerprint_to_bytes: (a: number, b: number) => void
  readonly sign_message_with_transparent: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number
  ) => void
  readonly start: () => void
  readonly transactionrequest_empty: () => number
  readonly transactionrequest_from_uri: (a: number, b: number, c: number) => void
  readonly transactionrequest_new: (a: number, b: number, c: number) => void
  readonly transactionrequest_payment_requests: (a: number, b: number) => void
  readonly transactionrequest_to_uri: (a: number, b: number) => void
  readonly transactionrequest_total: (a: number, b: number) => void
  readonly unifiedfullviewingkey_encode: (a: number, b: number, c: number, d: number) => void
  readonly unifiedfullviewingkey_new: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number
  ) => void
  readonly unifiedspendingkey_new: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number
  ) => void
  readonly unifiedspendingkey_to_sapling_proof_generation_key: (a: number) => number
  readonly unifiedspendingkey_to_unified_full_viewing_key: (a: number) => number
  readonly validate_mnemonic: (a: number, b: number, c: number) => void
  readonly walletsummary_account_balances: (a: number, b: number) => void
  readonly webvotingsession_checkEligibility: (a: number, b: number, c: number) => number
  readonly webvotingsession_clearRound: (a: number, b: number, c: number) => number
  readonly webvotingsession_discoverRounds: (a: number) => number
  readonly webvotingsession_exportState: (a: number, b: number) => void
  readonly webvotingsession_new: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number
  ) => void
  readonly webvotingsession_prepareRound: (a: number, b: number, c: number) => number
  readonly webvotingsession_resumeRound: (a: number, b: number, c: number) => number
  readonly webvotingsession_roundProposals: (a: number, b: number, c: number) => number
  readonly webvotingsession_roundStatus: (a: number, b: number, c: number) => number
  readonly webvotingsession_storageKey: (a: number, b: number) => void
  readonly webvotingsession_submitBallot: (a: number, b: number, c: number, d: number) => number
  readonly webvotingsession_submitDelegation: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number
  ) => number
  readonly webwallet_bench_download_range: (a: number, b: number, c: number) => number
  readonly webwallet_bench_prepare_sync_batch_timed: (a: number, b: number, c: number) => number
  readonly webwallet_create_account: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
    i: number
  ) => number
  readonly webwallet_create_account_ufvk: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
    i: number,
    j: number,
    k: number
  ) => number
  readonly webwallet_create_account_ufvk_external: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number
  ) => number
  readonly webwallet_db_to_bytes: (a: number) => number
  readonly webwallet_db_to_bytes_chunked: (a: number, b: number) => number
  readonly webwallet_estimate_orchard_migration_fee: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: bigint
  ) => number
  readonly webwallet_estimate_pczt_max_transfer: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: bigint
  ) => number
  readonly webwallet_estimate_pczt_max_transparent_transfer: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: bigint
  ) => number
  readonly webwallet_estimate_pczt_shield_fee: (a: number, b: number, c: bigint) => number
  readonly webwallet_estimate_pczt_transfer_fee: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: bigint,
    f: number,
    g: number,
    h: bigint
  ) => number
  readonly webwallet_estimate_pczt_transparent_transfer_fee: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: bigint,
    f: number,
    g: number,
    h: bigint
  ) => number
  readonly webwallet_estimate_transfer: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: bigint,
    f: number,
    g: number,
    h: number,
    i: number,
    j: number,
    k: bigint,
    l: number
  ) => number
  readonly webwallet_get_account_birthday: (a: number, b: number) => number
  readonly webwallet_get_account_hd_index: (a: number, b: number) => number
  readonly webwallet_get_account_id_by_name: (a: number, b: number, c: number) => number
  readonly webwallet_get_block_by_time: (a: number, b: number) => number
  readonly webwallet_get_block_time: (a: number, b: number) => number
  readonly webwallet_get_ironwood_activation_height: (a: number) => number
  readonly webwallet_get_latest_block: (a: number) => number
  readonly webwallet_get_latest_height: (a: number) => number
  readonly webwallet_get_next_shielded_address: (a: number, b: number) => number
  readonly webwallet_get_stored_transaction_bytes: (a: number, b: number, c: number) => number
  readonly webwallet_get_transaction_history: (a: number, b: number) => number
  readonly webwallet_get_unified_addresses: (a: number, b: number) => number
  readonly webwallet_get_wallet_summary: (a: number) => number
  readonly webwallet_list_shielded_addresses: (a: number, b: number) => number
  readonly webwallet_new: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
    i: number,
    j: number
  ) => void
  readonly webwallet_oneclick_pczt_orchard_migration: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
    i: number,
    j: bigint,
    k: number
  ) => number
  readonly webwallet_oneclick_pczt_shield: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number
  ) => number
  readonly webwallet_oneclick_pczt_shield_dynamic_fee: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: bigint,
    g: number
  ) => number
  readonly webwallet_oneclick_pczt_transfer: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: bigint,
    f: number,
    g: number,
    h: number,
    i: number,
    j: number
  ) => number
  readonly webwallet_oneclick_pczt_transfer_dynamic_fee: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: bigint,
    f: number,
    g: number,
    h: number,
    i: number,
    j: number,
    k: bigint,
    l: number
  ) => number
  readonly webwallet_oneclick_pczt_transparent_transfer: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: bigint,
    f: number,
    g: number,
    h: number,
    i: number,
    j: number
  ) => number
  readonly webwallet_oneclick_pczt_transparent_transfer_dynamic_fee: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: bigint,
    f: number,
    g: number,
    h: number,
    i: number,
    j: number,
    k: bigint,
    l: number
  ) => number
  readonly webwallet_oneclick_transfer: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: bigint,
    f: number,
    g: number,
    h: number,
    i: number,
    j: number,
    k: number,
    l: bigint,
    m: number
  ) => number
  readonly webwallet_pczt_create: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: bigint,
    f: number,
    g: number,
    h: bigint
  ) => number
  readonly webwallet_pczt_create_transparent: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: bigint,
    f: number,
    g: number,
    h: bigint
  ) => number
  readonly webwallet_pczt_orchard_migration_create: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: bigint,
    h: number
  ) => number
  readonly webwallet_pczt_prove: (a: number, b: number) => number
  readonly webwallet_pczt_prove_and_send: (a: number, b: number) => number
  readonly webwallet_pczt_shield_create: (a: number, b: number, c: bigint) => number
  readonly webwallet_pczt_store: (a: number, b: number) => number
  readonly webwallet_pczt_store_detailed: (a: number, b: number) => number
  readonly webwallet_prepare_sync_batch: (a: number, b: number, c: number) => number
  readonly webwallet_prepare_sync_batch_optimized: (a: number, b: number) => number
  readonly webwallet_replay_journal_entries: (a: number, b: number, c: number) => number
  readonly webwallet_scan_journal_entry: (a: number, b: number, c: number) => number
  readonly webwallet_send_authorized_transactions: (a: number, b: number, c: number) => number
  readonly webwallet_set_zero_indexer_options: (a: number, b: number, c: number) => void
  readonly webwallet_sync: (a: number) => number
  readonly webwallet_sync_next_batch: (a: number, b: number) => number
  readonly webwallet_sync_next_batch_optimized: (a: number, b: number) => number
  readonly webwallet_sync_session_setup: (a: number) => number
  readonly task_worker_entry_point: (a: number, b: number) => void
  readonly __wbg_canary_free: (a: number, b: number) => void
  readonly __wbg_coordinator_free: (a: number, b: number) => void
  readonly __wbg_deposit_free: (a: number, b: number) => void
  readonly __wbg_dkg1_free: (a: number, b: number) => void
  readonly __wbg_dkg2_free: (a: number, b: number) => void
  readonly __wbg_dkg3_free: (a: number, b: number) => void
  readonly __wbg_dkg_free: (a: number, b: number) => void
  readonly __wbg_dkgrelay_free: (a: number, b: number) => void
  readonly __wbg_messageset_free: (a: number, b: number) => void
  readonly __wbg_noisexx_free: (a: number, b: number) => void
  readonly __wbg_rostermanifest_free: (a: number, b: number) => void
  readonly __wbg_sharebackup_free: (a: number, b: number) => void
  readonly __wbg_signer_free: (a: number, b: number) => void
  readonly canary_allows: (a: number, b: number) => number
  readonly canary_arrival_confirmed: (a: number, b: number) => void
  readonly canary_begin: (a: number, b: number, c: number) => void
  readonly canary_new: () => number
  readonly canary_phase: (a: number, b: number) => void
  readonly canary_spend_confirmed: (a: number, b: number) => void
  readonly coordinator_accept_commitments: (a: number, b: number, c: number, d: number) => void
  readonly coordinator_accept_reject: (a: number, b: number, c: number, d: number) => void
  readonly coordinator_accept_share: (a: number, b: number, c: number, d: number) => void
  readonly coordinator_actions: (a: number) => number
  readonly coordinator_aggregate: (a: number, b: number) => void
  readonly coordinator_init_all: (a: number, b: number) => void
  readonly coordinator_new: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
    i: number,
    j: number
  ) => void
  readonly coordinator_payloads: (a: number, b: number) => void
  readonly coordinator_phase: (a: number, b: number) => void
  readonly coordinator_prepare_payload: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number
  ) => void
  readonly coordinator_report_result: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number
  ) => void
  readonly deposit_canary_amount: () => number
  readonly deposit_denom_cap: () => number
  readonly deposit_is_canonical: (a: number) => number
  readonly deposit_plan: (a: number, b: number) => void
  readonly deposit_residual: (a: number, b: number) => void
  readonly dkg1_broadcast: (a: number) => number
  readonly dkg1_broadcast_envelope: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number
  ) => void
  readonly dkg1_secret: (a: number) => number
  readonly dkg1_static_public: (a: number) => number
  readonly dkg2_outgoing: (a: number) => number
  readonly dkg2_outgoing_envelope: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number
  ) => void
  readonly dkg2_secret: (a: number) => number
  readonly dkg2_statics: (a: number) => number
  readonly dkg3_group_verifying_key: (a: number, b: number) => void
  readonly dkg3_key_package: (a: number) => number
  readonly dkg3_public_key_package: (a: number) => number
  readonly dkg3_static_public: (a: number) => number
  readonly dkg3_static_secret: (a: number) => number
  readonly dkg3_statics: (a: number) => number
  readonly dkg_new: (a: number, b: number, c: number, d: number, e: number, f: number) => void
  readonly dkg_part1: (a: number, b: number) => void
  readonly dkg_part2: (a: number, b: number, c: number, d: number, e: number) => void
  readonly dkg_part3: (a: number, b: number, c: number, d: number, e: number, f: number) => void
  readonly dkg_slot: (a: number) => number
  readonly dkg_static_public_of_broadcast: (a: number, b: number, c: number) => void
  readonly dkgrelay_accept: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number
  ) => void
  readonly dkgrelay_bundle: (a: number, b: number, c: number, d: number, e: number) => void
  readonly dkgrelay_new: (a: number, b: number, c: number, d: number) => void
  readonly envelopecodec_build: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
    i: number,
    j: number
  ) => void
  readonly envelopecodec_buildSignReject: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
    i: number
  ) => void
  readonly envelopecodec_buildSignResult: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
    i: number,
    j: number,
    k: number
  ) => void
  readonly envelopecodec_buildSigning: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
    i: number
  ) => void
  readonly envelopecodec_coordinator_slot: () => number
  readonly envelopecodec_decode: (a: number, b: number, c: number) => void
  readonly envelopecodec_defined_msg_types: () => number
  readonly envelopecodec_msg_type: (a: number, b: number, c: number) => void
  readonly envelopecodec_readSignReject: (a: number, b: number, c: number) => void
  readonly envelopecodec_readSignResult: (a: number, b: number, c: number) => void
  readonly envelopecodec_readSigning: (a: number, b: number, c: number) => void
  readonly envelopecodec_rejectCode: (a: number, b: number, c: number) => void
  readonly envelopecodec_reserved_msg_type: (a: number, b: number, c: number) => void
  readonly envelopecodec_reserved_msg_types: () => number
  readonly envelopecodec_round_of: (a: number, b: number, c: number) => void
  readonly keyset_address_is_shielded_only: (a: number, b: number) => number
  readonly keyset_derive: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number
  ) => void
  readonly keyset_fingerprint_from_fvk: (a: number, b: number, c: number, d: number) => void
  readonly keyset_fingerprint_from_ufvk: (a: number, b: number, c: number, d: number) => void
  readonly keyset_fvk_from_ufvk: (a: number, b: number, c: number) => void
  readonly keyset_generate_qsk: () => number
  readonly keyset_ufvk_matches_ak: (a: number, b: number, c: number, d: number, e: number) => void
  readonly messageset_from_bytes: (a: number, b: number, c: number) => void
  readonly messageset_get: (a: number, b: number) => number
  readonly messageset_is_empty: (a: number) => number
  readonly messageset_len: (a: number) => number
  readonly messageset_new: () => number
  readonly messageset_set: (a: number, b: number, c: number, d: number) => void
  readonly messageset_slots: (a: number, b: number) => void
  readonly messageset_to_bytes: (a: number, b: number) => void
  readonly noisexx_decrypt: (a: number, b: number, c: number, d: number) => void
  readonly noisexx_encrypt: (a: number, b: number, c: number, d: number) => void
  readonly noisexx_handshake_hash: (a: number, b: number) => void
  readonly noisexx_initiator: (a: number, b: number, c: number, d: number, e: number) => void
  readonly noisexx_is_handshake_finished: (a: number) => number
  readonly noisexx_is_poisoned: (a: number) => number
  readonly noisexx_read_handshake: (a: number, b: number, c: number, d: number) => void
  readonly noisexx_rekey: (a: number, b: number) => void
  readonly noisexx_remote_static: (a: number) => number
  readonly noisexx_responder: (a: number, b: number, c: number, d: number, e: number) => void
  readonly noisexx_static_public_from: (a: number, b: number, c: number) => void
  readonly noisexx_write_handshake: (a: number, b: number, c: number, d: number) => void
  readonly pczttools_action_alphas: (a: number, b: number, c: number) => void
  readonly pczttools_action_rks: (a: number, b: number, c: number) => void
  readonly pczttools_apply_signatures: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number
  ) => void
  readonly pczttools_check: (a: number, b: number, c: number) => void
  readonly pczttools_check_action_bindings: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number
  ) => void
  readonly pczttools_review: (a: number, b: number, c: number, d: number, e: number) => void
  readonly pczttools_shielded_sighash: (a: number, b: number, c: number) => void
  readonly pczttools_signingSet: (a: number, b: number, c: number, d: number, e: number) => void
  readonly pczttools_strip_proofs: (a: number, b: number, c: number) => void
  readonly rostermanifest_add_participant: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number
  ) => void
  readonly rostermanifest_canonical_bytes: (a: number, b: number) => void
  readonly rostermanifest_hash: (a: number, b: number) => void
  readonly rostermanifest_hash_hex: (a: number, b: number) => void
  readonly rostermanifest_new: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number
  ) => void
  readonly sealed_open: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
    i: number
  ) => void
  readonly sealed_prologue: (a: number, b: number) => void
  readonly sealed_prologueWithTranscript: (a: number, b: number, c: number) => void
  readonly sealed_seal: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
    i: number
  ) => void
  readonly sessionmarker_committed: (a: number, b: number, c: number) => void
  readonly sessionmarker_created: (a: number, b: number, c: number) => void
  readonly sessionmarker_recover: (a: number, b: number, c: number) => void
  readonly sessionmarker_session_id: (a: number, b: number, c: number) => void
  readonly sharebackup_device_id: (a: number) => number
  readonly sharebackup_from_bytes: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number
  ) => void
  readonly sharebackup_from_scalar: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
    i: number,
    j: number,
    k: number,
    l: number,
    m: number
  ) => void
  readonly sharebackup_group_verifying_key: (a: number) => number
  readonly sharebackup_key_package: (a: number, b: number) => void
  readonly sharebackup_new: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
    i: number,
    j: number
  ) => void
  readonly sharebackup_signing_scalar: (a: number, b: number) => void
  readonly sharebackup_slot: (a: number) => number
  readonly sharebackup_to_bytes: (a: number, b: number) => void
  readonly sharebackup_vault_id: (a: number) => number
  readonly signer_approve: (a: number, b: number) => void
  readonly signer_init: (a: number, b: number, c: number, d: number) => void
  readonly signer_new: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number
  ) => void
  readonly signer_nonce_states: (a: number, b: number) => void
  readonly signer_on_result: (a: number, b: number, c: number, d: number) => void
  readonly signer_payload: (a: number, b: number, c: number, d: number) => void
  readonly signer_phase: (a: number, b: number) => void
  readonly signer_reject: (a: number, b: number, c: number, d: number, e: number) => void
  readonly signer_share: (a: number, b: number) => void
  readonly signing_phases: () => number
  readonly verification_rk: (a: number, b: number, c: number, d: number, e: number) => void
  readonly verification_verify_spend_auth: (
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
    g: number,
    h: number,
    i: number
  ) => void
  readonly envelopecodec_new_session_id: () => number
  readonly __wbg_envelopecodec_free: (a: number, b: number) => void
  readonly __wbg_keyset_free: (a: number, b: number) => void
  readonly __wbg_pczttools_free: (a: number, b: number) => void
  readonly __wbg_sealed_free: (a: number, b: number) => void
  readonly __wbg_sessionmarker_free: (a: number, b: number) => void
  readonly __wbg_verification_free: (a: number, b: number) => void
  readonly __wbg_wbg_rayon_poolbuilder_free: (a: number, b: number) => void
  readonly initThreadPool: (a: number) => number
  readonly wbg_rayon_poolbuilder_build: (a: number) => void
  readonly wbg_rayon_poolbuilder_numThreads: (a: number) => number
  readonly wbg_rayon_poolbuilder_receiver: (a: number) => number
  readonly wbg_rayon_start_worker: (a: number) => void
  readonly rust_sqlite_wasm_abort: () => void
  readonly rust_sqlite_wasm_assert_fail: (a: number, b: number, c: number, d: number) => void
  readonly rust_sqlite_wasm_calloc: (a: number, b: number) => number
  readonly rust_sqlite_wasm_free: (a: number) => void
  readonly rust_sqlite_wasm_getentropy: (a: number, b: number) => number
  readonly rust_sqlite_wasm_localtime: (a: number) => number
  readonly rust_sqlite_wasm_malloc: (a: number) => number
  readonly rust_sqlite_wasm_realloc: (a: number, b: number) => number
  readonly sqlite3_os_end: () => number
  readonly sqlite3_os_init: () => number
  readonly __wbg_intounderlyingbytesource_free: (a: number, b: number) => void
  readonly __wbg_intounderlyingsink_free: (a: number, b: number) => void
  readonly __wbg_intounderlyingsource_free: (a: number, b: number) => void
  readonly intounderlyingbytesource_autoAllocateChunkSize: (a: number) => number
  readonly intounderlyingbytesource_cancel: (a: number) => void
  readonly intounderlyingbytesource_pull: (a: number, b: number) => number
  readonly intounderlyingbytesource_start: (a: number, b: number) => void
  readonly intounderlyingbytesource_type: (a: number) => number
  readonly intounderlyingsink_abort: (a: number, b: number) => number
  readonly intounderlyingsink_close: (a: number) => number
  readonly intounderlyingsink_write: (a: number, b: number) => number
  readonly intounderlyingsource_cancel: (a: number) => void
  readonly intounderlyingsource_pull: (a: number, b: number) => number
  readonly rustsecp256k1_v0_14_default_error_callback_fn: (a: number, b: number) => void
  readonly rustsecp256k1_v0_14_default_illegal_callback_fn: (a: number, b: number) => void
  readonly rustsecp256k1_v0_14_context_create: (a: number) => number
  readonly rustsecp256k1_v0_14_context_destroy: (a: number) => void
  readonly __wasm_bindgen_func_elem_16707: (a: number, b: number, c: number, d: number) => void
  readonly __wasm_bindgen_func_elem_16724: (a: number, b: number, c: number, d: number) => void
  readonly __wasm_bindgen_func_elem_12601: (a: number, b: number, c: number) => void
  readonly __wasm_bindgen_func_elem_16709: (a: number, b: number, c: number) => void
  readonly __wasm_bindgen_func_elem_12524: (a: number, b: number) => void
  readonly memory: WebAssembly.Memory
  readonly __wbindgen_export: (a: number, b: number) => number
  readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number
  readonly __wbindgen_export3: (a: number) => void
  readonly __wbindgen_export4: (a: number, b: number, c: number) => void
  readonly __wbindgen_export5: (a: number, b: number) => void
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number
  readonly __wbindgen_thread_destroy: (a?: number, b?: number, c?: number) => void
  readonly __wbindgen_start: (a: number) => void
}

export type SyncInitInput = BufferSource | WebAssembly.Module

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number }} module - Passing `SyncInitInput` directly is deprecated.
 * @param {WebAssembly.Memory} memory - Deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(
  module:
    | { module: SyncInitInput; memory?: WebAssembly.Memory; thread_stack_size?: number }
    | SyncInitInput,
  memory?: WebAssembly.Memory
): InitOutput

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number }} module_or_path - Passing `InitInput` directly is deprecated.
 * @param {WebAssembly.Memory} memory - Deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init(
  module_or_path?:
    | {
        module_or_path: InitInput | Promise<InitInput>
        memory?: WebAssembly.Memory
        thread_stack_size?: number
      }
    | InitInput
    | Promise<InitInput>,
  memory?: WebAssembly.Memory
): Promise<InitOutput>
