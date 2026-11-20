import { sha256 } from '@noble/hashes/sha2'
import type * as WalletWasm from '@/lib/wasm-pkg/zcash_wallet_wasm'
import { base64ToBytes, bytesToBase64, bytesToHex, hexToBytes } from '@/lib/bytes'
import { parseAccountSource, type AccountSource } from '../accounts/domain/account-source'
import { parseAccountId } from '../accounts/domain/account'
import { parseKeyDomainId } from '../keyring/domain/key-domain'
import { isDkgSessionIdText } from './dkg-protocol'
import { parseEnvelope, type MultisigEnvelope } from './messages'
import type { DeviceIdentity } from './identity'
import type { RosterManifest } from './roster'
import { parseIdentityPublicKey } from './identity'
import {
  effectiveSigningRoster,
  openVaultRecord,
  parseSealedVaultRecord,
  type SealedVaultRecord,
  type VaultRecordHeader
} from './vault-record'
import type { OpenedVaultRecord } from './vault-record'
import type { MultisigThreshold } from './types'
import {
  SigningCoordinatorSession,
  type SigningReviewBinding,
  type SigningScope,
  type SigningWasm
} from './signing-coordinator'
import {
  SigningNonceCheckpoint,
  type NoncePersistenceAcknowledgement,
  type SigningCheckpointProgress
} from './nonce-checkpoint'
import type { StoredMultisigTransaction } from './worker-transaction'
import type { ReviewedMultisigChainPolicy } from './production-review'

export interface SigningWorkerReference {
  walletId: string
  reviewId: string
  sessionId: string
}
export interface SigningTransferIntent {
  recipient: string
  amount: string
  memo: string
  marginalFeeZats: number
  feeQuoteId: string
}
export interface SigningReviewSummary {
  recipient: string
  amount: string
  memo: string
  fee: string
}
export interface SigningPrepareRequest {
  scope: SigningScope
  source: AccountSource
  sealedRecord: SealedVaultRecord
  intent: SigningTransferIntent
  selectedSlots: number[]
  transport: 'qr' | 'ble'
}
export type SigningPrepareResponse =
  | { available: false; reason: 'pczt_review_unavailable' }
  | {
      available: true
      binding: SigningReviewBinding
      threshold: MultisigThreshold
      transport: 'qr' | 'ble'
      createdAt: number
      summary: SigningReviewSummary
    }
export interface SigningWorkerProgress extends SigningCheckpointProgress {
  binding: SigningReviewBinding
}
export interface SigningWorkerSchema {
  'vault.sign.worker.prepare': { request: SigningPrepareRequest; response: SigningPrepareResponse }
  'vault.sign.worker.start': { request: SigningWorkerReference; response: SigningWorkerProgress }
  'vault.sign.worker.ingest': {
    request: SigningWorkerReference & { envelope: MultisigEnvelope }
    response: SigningWorkerProgress
  }
  'vault.sign.worker.advance': {
    request: SigningWorkerReference & { acknowledgement: NoncePersistenceAcknowledgement }
    response: SigningWorkerProgress
  }
  'vault.sign.worker.status': { request: SigningWorkerReference; response: SigningWorkerProgress }
  'vault.sign.worker.roster': { request: SigningWorkerReference; response: RosterManifest }
  'vault.sign.worker.finalize': {
    request: SigningWorkerReference & { accountId: string }
    response: StoredMultisigTransaction & { accountId: string }
  }
  'vault.sign.worker.submit': {
    request: SigningWorkerReference &
      StoredMultisigTransaction & { accountId: string; snapshotSha256: string }
    response: {
      phase: 'broadcast' | 'submission_unknown'
      txId: string
      outbound: MultisigEnvelope[]
    }
  }
  'vault.sign.worker.close': { request: SigningWorkerReference; response: true }
  'vault.sign.worker.invalidate': { request: { walletId?: string }; response: true }
}
export type SigningWorkerMethod = keyof SigningWorkerSchema
export type SigningWorkerWasm = SigningWasm & Pick<typeof WalletWasm, 'ShareBackup' | 'Keyset'>
/** The actual immutable credential object held by the Worker, not a mnemonic equality token. */
export interface SigningWorkerCredential {
  readonly keyDomainId: string
  readonly credentialGenerationId: string
  readonly globalUnlockEpoch: string
  readonly mnemonic: string
}
/** Internal capability only. There is deliberately no RPC to register prepared PCZT bytes. */
export type TrustedSigningReviewProvider =
  | { available: false }
  | {
      available: true
      prepare(input: {
        scope: SigningScope
        source: AccountSource
        header: VaultRecordHeader
        intent: SigningTransferIntent
        assertAuthorized: () => void
      }): Promise<{
        pczt: Uint8Array
        summary: SigningReviewSummary
        reviewedChainPolicy: ReviewedMultisigChainPolicy
      }>
    }
export interface SigningWorkerDependencies {
  credential(walletId: string): SigningWorkerCredential | null | undefined
  network(walletId: string): 'mainnet' | 'testnet' | undefined
  identity(): Promise<DeviceIdentity | null>
  reviewProvider: TrustedSigningReviewProvider
  finalize?(input: {
    binding: SigningReviewBinding
    source: AccountSource
    header: VaultRecordHeader
    signedPczt: Uint8Array
    reviewedChainPolicy: ReviewedMultisigChainPolicy
    reviewedSummary: SigningReviewSummary
    assertAuthorized: () => void
  }): Promise<StoredMultisigTransaction>
  submit?(input: {
    receipt: StoredMultisigTransaction
    binding: SigningReviewBinding
    source: AccountSource
    header: VaultRecordHeader
    reviewedChainPolicy: ReviewedMultisigChainPolicy
    assertAuthorized: () => void
  }): Promise<{
    status: 'broadcast' | 'submission_unknown'
    txId: string
  }>
  now?: () => number
  schedule?: (callback: () => void, delay: number) => () => void
}
export interface SigningWorkerRpcHandler {
  handle<M extends SigningWorkerMethod>(
    method: M,
    payload: unknown
  ): Promise<SigningWorkerSchema[M]['response']>
  invalidate(walletId?: string): void
}

const FAIL = 'Signing session is unavailable'
const INVALID = 'Invalid signing request'
const METHODS: readonly SigningWorkerMethod[] = [
  'vault.sign.worker.prepare',
  'vault.sign.worker.start',
  'vault.sign.worker.ingest',
  'vault.sign.worker.advance',
  'vault.sign.worker.status',
  'vault.sign.worker.roster',
  'vault.sign.worker.finalize',
  'vault.sign.worker.submit',
  'vault.sign.worker.close',
  'vault.sign.worker.invalidate'
]
export const isSigningWorkerMethod = (value: string): value is SigningWorkerMethod =>
  (METHODS as readonly string[]).includes(value)
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256
const units = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^(0|[1-9][0-9]{0,19})$/.test(value) &&
  BigInt(value) <= 18446744073709551615n
function fields(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = []
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    keys.every(key => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every(key => keys.includes(key) || optional.includes(key))
  )
}
function parsePrepare(value: unknown): SigningPrepareRequest {
  if (
    !fields(value, ['scope', 'source', 'sealedRecord', 'intent', 'selectedSlots', 'transport']) ||
    !fields(value.scope, ['walletId', 'accountId', 'network', 'groupId', 'rosterVersion']) ||
    !fields(value.intent, ['recipient', 'amount', 'memo', 'marginalFeeZats', 'feeQuoteId'])
  )
    throw new Error(INVALID)
  const scope = value.scope,
    intent = value.intent
  const walletId = parseKeyDomainId(scope.walletId)
  const accountId = parseAccountId(scope.accountId)
  if (
    !text(scope.groupId) ||
    !['mainnet', 'testnet'].includes(String(scope.network)) ||
    scope.rosterVersion !== 1 ||
    typeof intent.recipient !== 'string' ||
    intent.recipient.length < 1 ||
    intent.recipient.length > 2048 ||
    !units(intent.amount) ||
    intent.amount === '0' ||
    typeof intent.memo !== 'string' ||
    new TextEncoder().encode(intent.memo).length > 512 ||
    !Number.isSafeInteger(intent.marginalFeeZats) ||
    Number(intent.marginalFeeZats) <= 0 ||
    !text(intent.feeQuoteId) ||
    !Array.isArray(value.selectedSlots) ||
    value.selectedSlots.length < 2 ||
    value.selectedSlots.length > 3 ||
    value.selectedSlots.some(
      (slot, i, slots) =>
        !Number.isInteger(slot) || slot < 0 || slot > 2 || (i > 0 && slot <= slots[i - 1])
    ) ||
    value.selectedSlots[0] !== 0 ||
    (value.transport !== 'qr' && value.transport !== 'ble')
  )
    throw new Error(INVALID)
  const source = parseAccountSource(value.source)
  const record = parseSealedVaultRecord(value.sealedRecord)
  if (
    !record ||
    record.version !== 2 ||
    source.network !== scope.network ||
    source.groupId !== scope.groupId ||
    record.network !== scope.network ||
    record.groupId !== scope.groupId ||
    record.ownerWalletId !== scope.walletId ||
    record.accountId !== scope.accountId
  )
    throw new Error(INVALID)
  return {
    scope: {
      walletId,
      accountId,
      groupId: scope.groupId,
      network: scope.network as 'mainnet' | 'testnet',
      rosterVersion: 1
    },
    source,
    sealedRecord: record,
    intent: {
      recipient: intent.recipient,
      amount: intent.amount,
      memo: intent.memo,
      marginalFeeZats: intent.marginalFeeZats as number,
      feeQuoteId: intent.feeQuoteId
    },
    selectedSlots: [...value.selectedSlots] as number[],
    transport: value.transport
  }
}
function reference(
  value: unknown,
  extra: readonly string[] = []
): SigningWorkerReference & Record<string, unknown> {
  if (
    !fields(value, ['walletId', 'reviewId', 'sessionId', ...extra]) ||
    !text(value.reviewId) ||
    !isDkgSessionIdText(value.sessionId)
  )
    throw new Error(INVALID)
  return {
    ...value,
    walletId: parseKeyDomainId(value.walletId),
    reviewId: value.reviewId,
    sessionId: value.sessionId
  }
}
type Authority = { credential: SigningWorkerCredential; revision: number; scope: SigningScope }
interface Entry {
  request: SigningPrepareRequest
  binding: SigningReviewBinding
  threshold: MultisigThreshold
  createdAt: number
  summary: SigningReviewSummary
  roster: RosterManifest
  header: VaultRecordHeader
  reviewedChainPolicy: Readonly<ReviewedMultisigChainPolicy>
  authority: Authority
  pczt: Uint8Array
  engine: SigningCoordinatorSession | null
  checkpoint: SigningNonceCheckpoint | null
  opening: Promise<SigningWorkerProgress> | null
  aborted: boolean
  finalized: StoredMultisigTransaction | null
  finalizing: Promise<StoredMultisigTransaction> | null
  submissionAttempted: boolean
  disarm: () => void
}
const bindingCopy = (binding: SigningReviewBinding): SigningReviewBinding => ({
  ...binding,
  selectedSlots: [...binding.selectedSlots]
})

export function createSigningWorkerRpcHandler(
  wasm: SigningWorkerWasm,
  deps: SigningWorkerDependencies
): SigningWorkerRpcHandler {
  const now = deps.now ?? Date.now
  const entries = new Map<string, Entry>()
  const active = new Set<string>()
  const revisions = new Map<string, number>()
  const preparing = new Set<string>()
  const scopeKey = (scope: SigningScope) =>
    JSON.stringify([scope.network, scope.walletId, scope.accountId])
  const schedule =
    deps.schedule ??
    ((callback: () => void, delay: number) => {
      const timer = setTimeout(callback, delay)
      ;(timer as { unref?: () => void }).unref?.()
      return () => clearTimeout(timer)
    })
  function capture(scope: SigningScope): Authority {
    const credential = deps.credential(scope.walletId)
    if (
      !credential ||
      credential.keyDomainId !== scope.walletId ||
      !text(credential.credentialGenerationId) ||
      !text(credential.globalUnlockEpoch) ||
      deps.network(scope.walletId) !== scope.network
    )
      throw new Error(FAIL)
    return { credential, revision: revisions.get(scope.walletId) ?? 0, scope: { ...scope } }
  }
  function check(authority: Authority): void {
    const current = capture(authority.scope)
    if (
      current.credential !== authority.credential ||
      current.revision !== authority.revision ||
      current.credential.credentialGenerationId !== authority.credential.credentialGenerationId ||
      current.credential.globalUnlockEpoch !== authority.credential.globalUnlockEpoch
    )
      throw new Error(FAIL)
  }
  function abort(entry: Entry): void {
    entry.aborted = true
    entry.disarm()
    entry.engine?.cancel()
    entry.checkpoint?.cancel()
    entry.pczt.fill(0)
    active.delete(scopeKey(entry.request.scope))
  }
  function invalidate(walletId?: string): void {
    const ids = new Set([
      ...revisions.keys(),
      ...Array.from(entries.values(), entry => entry.request.scope.walletId),
      ...preparing
    ])
    if (walletId) ids.add(walletId)
    for (const id of ids)
      if (!walletId || id === walletId) revisions.set(id, (revisions.get(id) ?? 0) + 1)
    for (const entry of entries.values())
      if (!walletId || entry.request.scope.walletId === walletId) abort(entry)
  }
  async function identity(
    authority: Authority,
    header: VaultRecordHeader
  ): Promise<DeviceIdentity> {
    const value = await deps.identity()
    check(authority)
    if (
      !value ||
      header.version !== 2 ||
      header.roster.participants[0].identityPublicKey !== bytesToBase64(value.publicKey)
    )
      throw new Error(FAIL)
    const parsed = parseIdentityPublicKey(value.publicKey)
    const signing = value.signingKeys,
      agreement = value.agreementKeys
    if (
      !parsed ||
      signing.privateKey.extractable ||
      agreement.privateKey.extractable ||
      signing.privateKey.algorithm.name !== 'Ed25519' ||
      agreement.privateKey.algorithm.name !== 'X25519' ||
      !signing.privateKey.usages.includes('sign') ||
      !agreement.privateKey.usages.includes('deriveBits')
    )
      throw new Error(FAIL)
    const signingPublic = new Uint8Array(await crypto.subtle.exportKey('raw', signing.publicKey))
    check(authority)
    const agreementPublic = new Uint8Array(
      await crypto.subtle.exportKey('raw', agreement.publicKey)
    )
    check(authority)
    if (
      bytesToHex(signingPublic) !== bytesToHex(parsed.ed25519) ||
      bytesToHex(agreementPublic) !== bytesToHex(parsed.x25519)
    )
      throw new Error(FAIL)
    const challenge = new Uint8Array(32)
    const signature = await crypto.subtle.sign('Ed25519', signing.privateKey, challenge)
    check(authority)
    if (!(await crypto.subtle.verify('Ed25519', signing.publicKey, signature, challenge)))
      throw new Error(FAIL)
    check(authority)
    return { ...value, publicKey: value.publicKey.slice() }
  }
  function keyset(
    header: VaultRecordHeader,
    share: Uint8Array,
    request: SigningPrepareRequest
  ): void {
    if (
      header.version !== 2 ||
      header.rosterVersion !== request.scope.rosterVersion ||
      header.roster.participants.length !== header.participants ||
      request.selectedSlots.length !== header.threshold ||
      request.selectedSlots.some(slot => slot >= header.participants)
    )
      throw new Error(FAIL)
    const ak = hexToBytes(header.groupVerifyingKey)
    const backup = wasm.ShareBackup.from_bytes(share, ak, 0)
    try {
      if (
        backup.slot() !== 0 ||
        new TextDecoder().decode(backup.device_id()) !== 'device-1' ||
        new TextDecoder().decode(backup.vault_id()) !== header.groupId ||
        bytesToHex(backup.group_verifying_key()) !== header.groupVerifyingKey
      )
        throw new Error(FAIL)
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
      throw new Error(FAIL)
  }
  async function prepare(raw: unknown): Promise<SigningPrepareResponse> {
    const request = parsePrepare(raw)
    if (!deps.reviewProvider.available)
      return { available: false, reason: 'pczt_review_unavailable' }
    for (const [id, entry] of entries)
      if (now() >= entry.binding.expiresAt && entry.engine?.status().phase !== 'signed') {
        abort(entry)
        entries.delete(id)
      }
    const key = scopeKey(request.scope)
    if (active.has(key) || preparing.has(request.scope.walletId) || entries.size >= 128)
      throw new Error(FAIL)
    const authority = capture(request.scope)
    preparing.add(request.scope.walletId)
    const createdAt = now()
    let bytes: Uint8Array | null = null
    let participants: 2 | 3 = 2
    let roster: RosterManifest
    try {
      const opened = await openVaultRecord(request.sealedRecord, authority.credential.mnemonic, {
        ...request.scope,
        ownerWalletId: request.scope.walletId
      })
      let prepared: {
        pczt: Uint8Array
        summary: SigningReviewSummary
        reviewedChainPolicy: ReviewedMultisigChainPolicy
      }
      try {
        check(authority)
        keyset(opened.header, opened.share, request)
        if (opened.header.version !== 2) throw new Error(FAIL)
        roster = structuredClone(effectiveSigningRoster(opened.header))
        participants = opened.header.participants
        await identity(authority, opened.header)
        check(authority)
        prepared = await deps.reviewProvider.prepare({
          scope: { ...request.scope },
          source: request.source,
          header: opened.header,
          intent: { ...request.intent },
          assertAuthorized: () => check(authority)
        })
        if (!(prepared.pczt instanceof Uint8Array)) throw new Error(FAIL)
        bytes = prepared.pczt.slice()
        prepared.pczt.fill(0)
        check(authority)
        if (
          !fields(prepared.summary, ['recipient', 'amount', 'memo', 'fee']) ||
          prepared.summary.recipient !== request.intent.recipient ||
          prepared.summary.amount !== request.intent.amount ||
          prepared.summary.memo !== request.intent.memo ||
          !units(prepared.summary.fee) ||
          !prepared.reviewedChainPolicy ||
          !Number.isSafeInteger(prepared.reviewedChainPolicy.expiryHeight) ||
          prepared.reviewedChainPolicy.expiryHeight <= 0 ||
          prepared.reviewedChainPolicy.expiryHeight > 0xffffffff ||
          !Number.isSafeInteger(prepared.reviewedChainPolicy.consensusBranchId) ||
          prepared.reviewedChainPolicy.consensusBranchId <= 0 ||
          prepared.reviewedChainPolicy.consensusBranchId > 0xffffffff ||
          now() >= createdAt + 300000
        )
          throw new Error(FAIL)
        wasm.PcztTools.check(bytes)
        wasm.PcztTools.check_action_bindings(
          bytes,
          hexToBytes(opened.header.groupVerifyingKey),
          wasm.PcztTools.action_alphas(bytes)
        )
      } finally {
        opened.share.fill(0)
      }
      const binding: SigningReviewBinding = {
        ...request.scope,
        reviewId: crypto.randomUUID(),
        sessionId: bytesToBase64(wasm.EnvelopeCodec.new_session_id()),
        pcztDigest: bytesToHex(sha256(bytes)),
        expiresAt: createdAt + 300000,
        selectedSlots: [...request.selectedSlots]
      }
      const threshold = `${request.selectedSlots.length}-of-${participants}` as MultisigThreshold
      check(authority)
      const entry: Entry = {
        request,
        binding,
        threshold,
        createdAt,
        summary: { ...prepared.summary },
        roster,
        header: structuredClone(opened.header),
        reviewedChainPolicy: Object.freeze({ ...prepared.reviewedChainPolicy }),
        authority,
        pczt: bytes,
        engine: null,
        checkpoint: null,
        opening: null,
        aborted: false,
        finalized: null,
        finalizing: null,
        submissionAttempted: false,
        disarm: () => {}
      }
      entries.set(binding.reviewId, entry)
      active.add(key)
      entry.disarm = schedule(() => abort(entry), binding.expiresAt - now())
      bytes = null
      return {
        available: true,
        binding: bindingCopy(binding),
        threshold,
        createdAt,
        transport: request.transport,
        summary: { ...entry.summary }
      }
    } catch {
      throw new Error(FAIL)
    } finally {
      bytes?.fill(0)
      preparing.delete(request.scope.walletId)
    }
  }
  function get(ref: SigningWorkerReference): Entry {
    const entry = entries.get(ref.reviewId)
    if (
      !entry ||
      entry.binding.walletId !== ref.walletId ||
      entry.binding.sessionId !== ref.sessionId
    )
      throw new Error(FAIL)
    if (
      entry.aborted ||
      (now() >= entry.binding.expiresAt && entry.engine?.status().phase !== 'signed')
    ) {
      abort(entry)
      throw new Error(FAIL)
    }
    try {
      check(entry.authority)
    } catch {
      abort(entry)
      throw new Error(FAIL)
    }
    return entry
  }
  const progress = (entry: Entry, value: SigningCheckpointProgress): SigningWorkerProgress => {
    try {
      check(entry.authority)
      if (entry.aborted) throw new Error(FAIL)
      if (value.status.phase === 'signed') entry.disarm()
      return { ...value, binding: bindingCopy(entry.binding) }
    } catch {
      abort(entry)
      throw new Error(FAIL)
    }
  }
  async function start(entry: Entry): Promise<SigningWorkerProgress> {
    if (entry.opening) return entry.opening
    if (entry.engine && entry.checkpoint)
      return progress(entry, await entry.checkpoint.run('start', () => entry.engine!.start()))
    const opening = (async () => {
      let opened: OpenedVaultRecord | null = null
      let key: Uint8Array | null = null
      try {
        opened = await openVaultRecord(
          entry.request.sealedRecord,
          entry.authority.credential.mnemonic,
          { ...entry.request.scope, ownerWalletId: entry.binding.walletId }
        )
        check(entry.authority)
        if (entry.aborted) throw new Error(FAIL)
        keyset(opened.header, opened.share, entry.request)
        if (opened.header.version !== 2) throw new Error(FAIL)
        const device = await identity(entry.authority, opened.header)
        check(entry.authority)
        const backup = wasm.ShareBackup.from_bytes(
          opened.share,
          hexToBytes(opened.header.groupVerifyingKey),
          0
        )
        try {
          key = backup.key_package()
        } finally {
          backup.free()
        }
        const engine = await SigningCoordinatorSession.open(wasm, {
          scope: entry.request.scope,
          binding: entry.binding,
          roster: effectiveSigningRoster(opened.header),
          identity: device,
          keyPackage: key,
          publicKeyPackage: base64ToBytes(opened.header.publicKeyPackage),
          groupVerifyingKey: hexToBytes(opened.header.groupVerifyingKey),
          keysetFingerprint: opened.header.fingerprint,
          pczt: entry.pczt,
          transport: entry.request.transport,
          persistNoncePhase: phase => {
            check(entry.authority)
            if (entry.aborted) throw new Error(FAIL)
            return entry.checkpoint!.persist(phase)
          },
          now,
          schedule
        })
        if (entry.aborted) {
          engine.cancel()
          throw new Error(FAIL)
        }
        entry.engine = engine
        check(entry.authority)
        entry.pczt.fill(0)
        entry.checkpoint = new SigningNonceCheckpoint(() => engine.status())
        return progress(entry, await entry.checkpoint.run('start', () => engine.start()))
      } catch {
        abort(entry)
        throw new Error(FAIL)
      } finally {
        opened?.share.fill(0)
        key?.fill(0)
      }
    })()
    entry.opening = opening
    try {
      return await opening
    } finally {
      entry.opening = null
    }
  }
  async function finalize(entry: Entry): Promise<StoredMultisigTransaction> {
    if (entry.finalized) return { ...entry.finalized }
    if (entry.finalizing) return { ...(await entry.finalizing) }
    if (!deps.finalize || entry.engine?.status().phase !== 'signed') throw new Error(FAIL)
    const signedPczt = entry.engine.takeSignedPczt()
    if (!signedPczt) throw new Error(FAIL)
    const finalizing = (async () => {
      try {
        check(entry.authority)
        const receipt = await deps.finalize!({
          binding: bindingCopy(entry.binding),
          source: entry.request.source,
          header: structuredClone(entry.header),
          signedPczt,
          reviewedChainPolicy: { ...entry.reviewedChainPolicy },
          reviewedSummary: { ...entry.summary },
          assertAuthorized: () => {
            if (entry.aborted) throw new Error(FAIL)
            check(entry.authority)
          }
        })
        check(entry.authority)
        if (
          entry.aborted ||
          !/^[0-9a-f]{64}$/.test(receipt.txId) ||
          !/^[0-9a-f]{64}$/.test(receipt.rawTxSha256) ||
          !Number.isSafeInteger(receipt.rawTxLen) ||
          receipt.rawTxLen < 1 ||
          receipt.network !== entry.binding.network
        )
          throw new Error(FAIL)
        entry.finalized = Object.freeze({ ...receipt })
        return entry.finalized
      } catch {
        abort(entry)
        throw new Error(FAIL)
      } finally {
        signedPczt.fill(0)
      }
    })()
    entry.finalizing = finalizing
    try {
      return { ...(await finalizing) }
    } finally {
      entry.finalizing = null
    }
  }
  async function submit(
    entry: Entry,
    input: SigningWorkerReference & Record<string, unknown>
  ): Promise<SigningWorkerSchema['vault.sign.worker.submit']['response']> {
    const receipt = entry.finalized
    const engine = entry.engine
    if (
      !deps.submit ||
      !receipt ||
      entry.submissionAttempted ||
      input.txId !== receipt.txId ||
      input.accountId !== entry.binding.accountId ||
      input.rawTxSha256 !== receipt.rawTxSha256 ||
      input.rawTxLen !== receipt.rawTxLen ||
      input.network !== receipt.network ||
      !/^[0-9a-f]{64}$/.test(String(input.snapshotSha256)) ||
      engine?.status().phase !== 'signed'
    )
      throw new Error(FAIL)
    entry.submissionAttempted = true
    try {
      check(entry.authority)
      const result = await deps.submit({
        receipt,
        binding: bindingCopy(entry.binding),
        source: entry.request.source,
        header: structuredClone(entry.header),
        reviewedChainPolicy: { ...entry.reviewedChainPolicy },
        assertAuthorized: () => {
          if (entry.aborted) throw new Error(FAIL)
          check(entry.authority)
        }
      })
      check(entry.authority)
      if (result.status !== 'broadcast' || result.txId !== receipt.txId)
        return { phase: 'submission_unknown', txId: receipt.txId, outbound: [] }
      let outbound: MultisigEnvelope[] = []
      try {
        outbound = await engine.reportResult('broadcast', hexToBytes(receipt.txId).reverse())
      } catch {
        // A phone-result delivery failure cannot turn an accepted network submission into a retry.
      }
      return { phase: 'broadcast', txId: receipt.txId, outbound }
    } catch {
      return { phase: 'submission_unknown', txId: receipt.txId, outbound: [] }
    }
  }
  async function dispatch(method: SigningWorkerMethod, raw: unknown): Promise<unknown> {
    if (method === 'vault.sign.worker.prepare') return prepare(raw)
    if (method === 'vault.sign.worker.invalidate') {
      if (!fields(raw, [], ['walletId'])) throw new Error(INVALID)
      invalidate(raw.walletId === undefined ? undefined : parseKeyDomainId(raw.walletId))
      return true
    }
    const ref = reference(
      raw,
      method === 'vault.sign.worker.ingest'
        ? ['envelope']
        : method === 'vault.sign.worker.advance'
          ? ['acknowledgement']
          : method === 'vault.sign.worker.finalize'
            ? ['accountId']
            : method === 'vault.sign.worker.submit'
              ? ['accountId', 'txId', 'rawTxSha256', 'rawTxLen', 'network', 'snapshotSha256']
              : []
    )
    if (method === 'vault.sign.worker.close') {
      const entry = entries.get(ref.reviewId)
      if (
        entry &&
        (entry.binding.walletId !== ref.walletId || entry.binding.sessionId !== ref.sessionId)
      )
        throw new Error(FAIL)
      if (entry) abort(entry)
      return true
    }
    const entry = get(ref)
    if (method === 'vault.sign.worker.roster') return structuredClone(entry.roster)
    if (method === 'vault.sign.worker.finalize') {
      if (ref.accountId !== entry.binding.accountId) throw new Error(FAIL)
      return { ...(await finalize(entry)), accountId: entry.binding.accountId }
    }
    if (method === 'vault.sign.worker.submit') return submit(entry, ref)
    if (method === 'vault.sign.worker.start') return start(entry)
    if (method === 'vault.sign.worker.status')
      return progress(
        entry,
        entry.checkpoint?.progress() ?? {
          status: {
            sessionId: entry.binding.sessionId,
            phase: 'created',
            selectedSlots: [...entry.binding.selectedSlots],
            committedSlots: [],
            sharedSlots: []
          },
          outbound: []
        }
      )
    if (!entry.engine || !entry.checkpoint) throw new Error(FAIL)
    if (method === 'vault.sign.worker.ingest') {
      const envelope = parseEnvelope(ref.envelope)
      if (!envelope) throw new Error(INVALID)
      try {
        return progress(
          entry,
          await entry.checkpoint.run(JSON.stringify(envelope), () => entry.engine!.ingest(envelope))
        )
      } catch {
        abort(entry)
        throw new Error(FAIL)
      }
    }
    if (method === 'vault.sign.worker.advance') {
      const ack = ref.acknowledgement
      if (
        !fields(ack, ['ackId', 'phase', 'persisted']) ||
        !text(ack.ackId) ||
        !['created', 'committed', 'consumed'].includes(String(ack.phase)) ||
        typeof ack.persisted !== 'boolean'
      )
        throw new Error(INVALID)
      try {
        return progress(
          entry,
          await entry.checkpoint.advance(ack as unknown as NoncePersistenceAcknowledgement)
        )
      } catch {
        abort(entry)
        throw new Error(FAIL)
      }
    }
    throw new Error(INVALID)
  }
  return {
    handle: <M extends SigningWorkerMethod>(method: M, payload: unknown) =>
      dispatch(method, payload) as Promise<SigningWorkerSchema[M]['response']>,
    invalidate
  }
}
