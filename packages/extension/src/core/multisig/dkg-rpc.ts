/**
 * The `vault.dkg.*` Worker RPC: one coordinator session per DKG session id, addressed by base64
 * id, with bytes crossing as base64 and roster-slot maps as plain objects. Alongside it,
 * `vault.record.summary` is sessionless: it opens a stored record under the owner wallet's
 * mnemonic and returns only its public summary. Requests are validated here because they arrive
 * from another extension context as JSON; the coordinator underneath only ever sees well-typed
 * values.
 */
import { base64ToBytes, bytesToBase64, bytesToHex, hexToBytes } from '@/lib/bytes'
import {
  DkgCoordinatorSession,
  isOuterSessionId,
  verifyCreationConfirmations,
  type CreationEvidence,
  type MnemonicResolver
} from './dkg-coordinator'
import { parseEnvelope, type MultisigEnvelope } from './messages'
import { isBase64Text, isDkgSessionIdText, isDkgShape, type VaultWasm } from './dkg-protocol'
import {
  isVaultGroupId,
  isVaultWalletId,
  openVaultRecord,
  parseSealedVaultRecord,
  parseVaultRecordBinding,
  sealVaultRecord,
  type VaultRecordBinding,
  type SealedVaultRecord,
  type VaultRecordSummary
} from './vault-record'
import { checkRecoverRequest, sealRecoverReply } from './recover-handshake'
import { buildRestoreConfig } from './recover-config'

export type VaultDkgAcceptRequest = {
  sessionId: string
  senderSlot: number
  envelope: string
  signedEnvelope?: MultisigEnvelope
}
export type VaultDkgConfirmRequest = { sessionId: string; signedEnvelope: MultisigEnvelope }

export type VaultDkgRound1Response =
  | { complete: false }
  | { complete: true; round1Hash: string; bundles: Record<string, string> }

export type VaultDkgRound2Response =
  | { complete: false }
  | {
      complete: true
      fingerprint: string
      inboxes: Record<string, string>
      sealedQsk: Record<string, string>
      record: SealedVaultRecord
    }

export interface VaultDkgSchema {
  'vault.dkg.open': {
    request: {
      participants: 2 | 3
      threshold: 2 | 3
      mainnet: boolean
      ownerWalletId: string
      groupId: string
      sessionId?: string
      binding?: VaultRecordBinding
      outerSessionId?: string
    }
    response: { sessionId: string }
  }
  'vault.dkg.acceptRound1': { request: VaultDkgAcceptRequest; response: VaultDkgRound1Response }
  'vault.dkg.acceptRound2': { request: VaultDkgAcceptRequest; response: VaultDkgRound2Response }
  'vault.dkg.confirmRound1': { request: VaultDkgConfirmRequest; response: true }
  'vault.dkg.close': { request: { sessionId: string }; response: true }
  'vault.record.summary': {
    request: {
      record: SealedVaultRecord
      ownerWalletId: string
      creationEvidence?: CreationEvidence
    }
    response: VaultRecordSummary
  }
  'vault.record.recoverPrepare': {
    request: { record: SealedVaultRecord; ownerWalletId: string; request: string }
    response: { record: SealedVaultRecord; reply: string }
  }
}

export type VaultDkgMethod = keyof VaultDkgSchema

const METHODS: readonly VaultDkgMethod[] = [
  'vault.dkg.open',
  'vault.dkg.acceptRound1',
  'vault.dkg.acceptRound2',
  'vault.dkg.confirmRound1',
  'vault.dkg.close',
  'vault.record.summary',
  'vault.record.recoverPrepare'
]

export function isVaultDkgMethod(method: string): method is VaultDkgMethod {
  return (METHODS as readonly string[]).includes(method)
}

export interface VaultDkgRpcHandler {
  handle<M extends VaultDkgMethod>(
    method: M,
    payload: unknown
  ): Promise<VaultDkgSchema[M]['response']>
  readonly sessionCount: number
}

export interface VaultDkgRpcOptions {
  now?: () => number
  maxSessions?: number
  idleMs?: number
  /** Arms a one-shot timer and returns its cancel; defaults to setTimeout. Tests inject their own. */
  schedule?: (fn: () => void, delayMs: number) => () => void
}

function scheduleWithTimeout(fn: () => void, delayMs: number): () => void {
  const id = setTimeout(fn, delayMs)
  // Under Node (tests) a pending timer would keep the process alive for idleMs; a Worker has no
  // unref and needs none.
  ;(id as { unref?: () => void }).unref?.()
  return () => clearTimeout(id)
}

const INVALID_REQUEST = 'Invalid vault DKG request'
const UNKNOWN_SESSION = 'Unknown vault DKG session'
const RECORD_UNOPENABLE = 'Vault record cannot be opened'
const DEFAULT_MAX_SESSIONS = 4
const DEFAULT_IDLE_MS = 30 * 60_000

interface Entry {
  session: DkgCoordinatorSession
  lastUsed: number
  disarm: () => void
}

function hasKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const actual = Object.keys(value)
  return (
    required.every(key => Object.prototype.hasOwnProperty.call(value, key)) &&
    actual.every(key => required.includes(key) || optional.includes(key))
  )
}

function parseOpen(payload: unknown): VaultDkgSchema['vault.dkg.open']['request'] {
  if (
    !hasKeys(
      payload,
      ['participants', 'threshold', 'mainnet', 'ownerWalletId', 'groupId'],
      ['sessionId', 'binding', 'outerSessionId']
    )
  ) {
    throw new Error(INVALID_REQUEST)
  }
  const shape = { participants: payload.participants, threshold: payload.threshold }
  if (
    !isDkgShape(shape) ||
    typeof payload.mainnet !== 'boolean' ||
    !isVaultWalletId(payload.ownerWalletId) ||
    !isVaultGroupId(payload.groupId) ||
    (payload.sessionId !== undefined && !isDkgSessionIdText(payload.sessionId))
  ) {
    throw new Error(INVALID_REQUEST)
  }
  const binding =
    payload.binding === undefined ? undefined : parseVaultRecordBinding(payload.binding)
  if (
    binding === null ||
    (binding &&
      (!isOuterSessionId(payload.outerSessionId) ||
        binding.roster.groupId !== payload.groupId ||
        binding.roster.threshold !== shape.threshold ||
        binding.roster.participants.length !== shape.participants))
  ) {
    throw new Error(INVALID_REQUEST)
  }
  return {
    participants: shape.participants,
    threshold: shape.threshold,
    mainnet: payload.mainnet,
    ownerWalletId: payload.ownerWalletId,
    groupId: payload.groupId,
    ...(binding ? { binding } : {}),
    ...(binding ? { outerSessionId: payload.outerSessionId as string } : {}),
    ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId })
  }
}

function parseAccept(payload: unknown): VaultDkgAcceptRequest {
  if (
    !hasKeys(payload, ['sessionId', 'senderSlot', 'envelope'], ['signedEnvelope']) ||
    !isBase64Text(payload.sessionId) ||
    typeof payload.senderSlot !== 'number' ||
    !Number.isInteger(payload.senderSlot) ||
    !isBase64Text(payload.envelope)
  ) {
    throw new Error(INVALID_REQUEST)
  }
  return {
    sessionId: payload.sessionId,
    senderSlot: payload.senderSlot,
    envelope: payload.envelope,
    ...(payload.signedEnvelope === undefined
      ? {}
      : { signedEnvelope: parseSignedEnvelope(payload.signedEnvelope) })
  }
}

function parseSignedEnvelope(value: unknown): MultisigEnvelope {
  const envelope = parseEnvelope(value)
  if (!envelope) throw new Error(INVALID_REQUEST)
  return envelope
}

function parseConfirm(payload: unknown): VaultDkgConfirmRequest {
  if (!hasKeys(payload, ['sessionId', 'signedEnvelope']) || !isDkgSessionIdText(payload.sessionId))
    throw new Error(INVALID_REQUEST)
  return {
    sessionId: payload.sessionId,
    signedEnvelope: parseSignedEnvelope(payload.signedEnvelope)
  }
}

function parseClose(payload: unknown): { sessionId: string } {
  if (!hasKeys(payload, ['sessionId']) || !isBase64Text(payload.sessionId)) {
    throw new Error(INVALID_REQUEST)
  }
  return { sessionId: payload.sessionId }
}

function parseSummary(payload: unknown): VaultDkgSchema['vault.record.summary']['request'] {
  if (
    !hasKeys(payload, ['record', 'ownerWalletId'], ['creationEvidence']) ||
    !isVaultWalletId(payload.ownerWalletId)
  ) {
    throw new Error(INVALID_REQUEST)
  }
  const record = parseSealedVaultRecord(payload.record)
  if (!record) throw new Error(INVALID_REQUEST)
  let creationEvidence: CreationEvidence | undefined
  if (payload.creationEvidence !== undefined) {
    const value = payload.creationEvidence
    if (
      !hasKeys(value, ['outerSessionId', 'confirmations']) ||
      !isOuterSessionId(value.outerSessionId) ||
      !Array.isArray(value.confirmations) ||
      value.confirmations.length > 3
    )
      throw new Error(INVALID_REQUEST)
    creationEvidence = {
      outerSessionId: value.outerSessionId,
      confirmations: value.confirmations.map(parseSignedEnvelope)
    }
  }
  return {
    record,
    ownerWalletId: payload.ownerWalletId,
    ...(creationEvidence ? { creationEvidence } : {})
  }
}

function parseRecoverPrepare(
  payload: unknown
): VaultDkgSchema['vault.record.recoverPrepare']['request'] {
  if (
    !hasKeys(payload, ['record', 'ownerWalletId', 'request']) ||
    !isVaultWalletId(payload.ownerWalletId) ||
    !isBase64Text(payload.request)
  )
    throw new Error(INVALID_REQUEST)
  const record = parseSealedVaultRecord(payload.record)
  if (!record || record.version !== 2) throw new Error(INVALID_REQUEST)
  const bytes = base64ToBytes(payload.request)
  if (bytesToBase64(bytes) !== payload.request) throw new Error(INVALID_REQUEST)
  return { record, ownerWalletId: payload.ownerWalletId, request: payload.request }
}

function encodeBySlot(map: ReadonlyMap<number, Uint8Array>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [slot, bytes] of map) out[String(slot)] = bytesToBase64(bytes)
  return out
}

export function createVaultDkgRpcHandler(
  wasm: VaultWasm,
  resolveMnemonic: MnemonicResolver,
  options: VaultDkgRpcOptions = {}
): VaultDkgRpcHandler {
  const now = options.now ?? (() => Date.now())
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS
  const schedule = options.schedule ?? scheduleWithTimeout
  const sessions = new Map<string, Entry>()

  function drop(id: string): void {
    const entry = sessions.get(id)
    if (!entry) return
    sessions.delete(id)
    entry.disarm()
    entry.session.close()
  }

  // A tab that is closed mid-ceremony never sends vault.dkg.close, and no later call may come at
  // all, so each session carries its own timer. Every use re-arms it; when it fires, the session
  // has been idle for idleMs by construction, and nothing else is needed to decide.
  function arm(id: string, entry: Entry, at: number): void {
    entry.lastUsed = at
    entry.disarm()
    entry.disarm = schedule(() => {
      entry.disarm = () => {}
      if (sessions.get(id) === entry) drop(id)
    }, idleMs)
  }

  // Fallback sweep on every call, for a timer source that was paused or dropped.
  function expireIdle(at: number): void {
    for (const [id, entry] of sessions) {
      if (at - entry.lastUsed >= idleMs) drop(id)
    }
  }

  function evictOldest(): void {
    let oldest: [string, Entry] | null = null
    for (const candidate of sessions) {
      if (!oldest || candidate[1].lastUsed < oldest[1].lastUsed) oldest = candidate
    }
    if (oldest) drop(oldest[0])
  }

  function take(id: string, at: number): Entry {
    const entry = sessions.get(id)
    if (!entry) throw new Error(UNKNOWN_SESSION)
    arm(id, entry, at)
    return entry
  }

  async function accept<T>(
    payload: unknown,
    at: number,
    run: (
      session: DkgCoordinatorSession,
      senderSlot: number,
      envelope: Uint8Array,
      signedEnvelope?: MultisigEnvelope
    ) => Promise<T>
  ): Promise<T> {
    const request = parseAccept(payload)
    const entry = take(request.sessionId, at)
    try {
      return await run(
        entry.session,
        request.senderSlot,
        base64ToBytes(request.envelope),
        request.signedEnvelope
      )
    } catch (error) {
      // The coordinator has already voided itself; the table must not keep a dead session.
      drop(request.sessionId)
      throw error
    }
  }

  /**
   * Opens a stored record and re-checks it against the WASM before vouching for it. Every failure
   * gives the same message: the caller learns nothing about why, and no error can carry the share.
   */
  async function summarize(
    request: VaultDkgSchema['vault.record.summary']['request']
  ): Promise<VaultRecordSummary> {
    let share: Uint8Array | null = null
    try {
      const opened = await openVaultRecord(request.record, resolveMnemonic(request.ownerWalletId))
      share = opened.share
      const { header } = opened
      if (header.version === 2 && header.ownerWalletId !== request.ownerWalletId)
        throw new Error('owner mismatch')
      const ak = hexToBytes(header.groupVerifyingKey)
      wasm.ShareBackup.from_bytes(share, ak, 0).free()
      const mainnet = header.network === 'mainnet'
      const fvk = base64ToBytes(header.fvk)
      if (bytesToHex(wasm.Keyset.fingerprint_from_fvk(fvk, mainnet)) !== header.fingerprint) {
        throw new Error('fingerprint mismatch')
      }
      if (!wasm.Keyset.ufvk_matches_ak(header.ufvk, ak)) throw new Error('ufvk mismatch')
      if (request.creationEvidence) {
        if (header.version !== 2) throw new Error('legacy creation evidence')
        await verifyCreationConfirmations(
          header.roster,
          header.fingerprint,
          request.creationEvidence
        )
      }
      return {
        fingerprint: header.fingerprint,
        address: header.address,
        participants: header.participants,
        threshold: header.threshold,
        ...(header.version === 2
          ? {
              authenticated: {
                accountId: header.accountId,
                ownerWalletId: header.ownerWalletId,
                birthdayHeight: header.birthdayHeight,
                rosterVersion: header.rosterVersion,
                rosterHash: header.roster.rosterHash,
                ...(request.creationEvidence ? { creationConfirmed: true as const } : {})
              }
            }
          : {})
      }
    } catch {
      throw new Error(RECORD_UNOPENABLE)
    } finally {
      share?.fill(0)
    }
  }

  async function recoverPrepare(
    request: VaultDkgSchema['vault.record.recoverPrepare']['request']
  ): Promise<VaultDkgSchema['vault.record.recoverPrepare']['response']> {
    let share: Uint8Array | null = null
    let config: Uint8Array | null = null
    try {
      const mnemonic = resolveMnemonic(request.ownerWalletId)
      const opened = await openVaultRecord(request.record, mnemonic)
      share = opened.share
      const { header } = opened
      if (
        header.version !== 2 ||
        header.ownerWalletId !== request.ownerWalletId ||
        header.participants !== 2 ||
        header.threshold !== 2
      )
        throw new Error('unsupported recovery')
      const ak = hexToBytes(header.groupVerifyingKey)
      const backup = wasm.ShareBackup.from_bytes(share, ak, 0)
      try {
        if (backup.slot() !== 0) throw new Error('invalid share')
      } finally {
        backup.free()
      }
      if (
        !wasm.Keyset.ufvk_matches_ak(header.ufvk, ak) ||
        bytesToHex(wasm.Keyset.fvk_from_ufvk(header.ufvk)) !==
          bytesToHex(base64ToBytes(header.fvk)) ||
        bytesToHex(wasm.Keyset.fingerprint_from_ufvk(header.ufvk, header.network === 'mainnet')) !==
          header.fingerprint
      )
        throw new Error('invalid keyset')
      const bytes = base64ToBytes(request.request)
      const checked = checkRecoverRequest(bytes, {
        publicKeyPackage: base64ToBytes(header.publicKeyPackage),
        nowSeconds: Math.floor(Date.now() / 1000),
        expectedSlot: 1
      })
      if (!checked.ok) throw new Error('invalid phone proof')
      const phoneIdentity = bytesToBase64(checked.request.identityPublicKey)
      if (phoneIdentity === header.roster.participants[0].identityPublicKey)
        throw new Error('duplicate identity')
      config = buildRestoreConfig({
        publicKeyPackage: header.publicKeyPackage,
        ufvk: header.ufvk,
        fingerprint: header.fingerprint,
        participants: header.participants,
        owner: {
          identityPublicKey: base64ToBytes(header.roster.participants[0].identityPublicKey),
          name: 'Noir Wallet'
        },
        phoneName: 'iPhone',
        phoneIdentityPublicKey: checked.request.identityPublicKey
      })
      const reply = await sealRecoverReply(bytes, config)
      const record = await sealVaultRecord(
        { ...header, recoveredPhoneIdentityPublicKey: phoneIdentity },
        share,
        mnemonic
      )
      if (resolveMnemonic(request.ownerWalletId) !== mnemonic)
        throw new Error('Wallet credential session changed')
      return { record, reply: bytesToBase64(reply) }
    } catch {
      throw new Error(RECORD_UNOPENABLE)
    } finally {
      share?.fill(0)
      config?.fill(0)
    }
  }

  async function dispatch(method: VaultDkgMethod, payload: unknown): Promise<unknown> {
    // Not a ceremony call: it neither uses nor sweeps the session table.
    if (method === 'vault.record.summary') return summarize(parseSummary(payload))
    if (method === 'vault.record.recoverPrepare')
      return recoverPrepare(parseRecoverPrepare(payload))
    const at = now()
    expireIdle(at)
    switch (method) {
      case 'vault.dkg.open': {
        const { ownerWalletId, sessionId: wanted, ...rest } = parseOpen(payload)
        if (wanted !== undefined && sessions.has(wanted)) {
          throw new Error('Vault DKG session already exists')
        }
        if (sessions.size >= maxSessions) evictOldest()
        const session = DkgCoordinatorSession.open(
          wasm,
          { ...rest, walletId: ownerWalletId },
          resolveMnemonic,
          undefined,
          wanted === undefined ? undefined : base64ToBytes(wanted)
        )
        const id = bytesToBase64(session.sessionId)
        const entry: Entry = { session, lastUsed: at, disarm: () => {} }
        sessions.set(id, entry)
        arm(id, entry, at)
        return { sessionId: id }
      }
      case 'vault.dkg.acceptRound1':
        return accept(payload, at, async (session, senderSlot, envelope, signed) => {
          const outcome = await session.acceptRound1(senderSlot, envelope, signed)
          return outcome.complete
            ? {
                complete: true,
                round1Hash: outcome.round1Hash,
                bundles: encodeBySlot(outcome.bundles)
              }
            : { complete: false }
        })
      case 'vault.dkg.acceptRound2':
        return accept(payload, at, async (session, senderSlot, envelope, signed) => {
          const outcome = await session.acceptRound2(senderSlot, envelope, signed)
          return outcome.complete
            ? {
                complete: true,
                fingerprint: outcome.fingerprint,
                inboxes: encodeBySlot(outcome.inboxes),
                sealedQsk: encodeBySlot(outcome.sealedQsk),
                record: outcome.record
              }
            : { complete: false }
        })
      case 'vault.dkg.confirmRound1': {
        const request = parseConfirm(payload)
        const entry = take(request.sessionId, at)
        try {
          await entry.session.confirmRound1(request.signedEnvelope)
          return true
        } catch (error) {
          drop(request.sessionId)
          throw error
        }
      }
      case 'vault.dkg.close': {
        drop(parseClose(payload).sessionId)
        return true
      }
      default:
        throw new Error(INVALID_REQUEST)
    }
  }

  return {
    handle<M extends VaultDkgMethod>(method: M, payload: unknown) {
      return dispatch(method, payload) as Promise<VaultDkgSchema[M]['response']>
    },
    get sessionCount() {
      return sessions.size
    }
  }
}
