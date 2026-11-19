import { parseAccountId } from '@/core/accounts/domain/account'
import { parseKeyDomainId } from '@/core/keyring/domain'
import { parseSigningSessionId } from '@/core/multisig/signing-journal'
import type { OwnExtensionSenderContext } from '@/lib/runtime-message-security'
import type { FinalizationBarrierRecord } from '@/lib/multisig-finalization-barrier'

export const MULTISIG_FINALIZATION_BRIDGE_TYPE = 'MULTISIG_FINALIZATION_BRIDGE'

type Network = 'mainnet' | 'testnet'
type Scope = { network: Network; walletId: string }
type Ref = Scope & { accountId: string; reviewId: string; sessionId: string }
type OwnedRef = Ref & { token: string }
type Receipt = OwnedRef & { txId: string; rawTxSha256: string; rawTxLen: number }
type Snapshot = OwnedRef & { txId: string; snapshotSha256: string }
type Operation =
  | 'barrier.has'
  | 'barrier.begin'
  | 'barrier.clear'
  | 'receipt'
  | 'protected'
  | 'durable'

export interface MultisigFinalizationBridgePorts {
  listRecovery(): Promise<readonly { binding: Ref; phase: string }[]>
  hasBarrier(scope: Scope): Promise<boolean>
  beginBarrier(scope: Ref, token: string): Promise<FinalizationBarrierRecord>
  assertBarrierOwned(marker: FinalizationBarrierRecord): Promise<void>
  clearBarrier(marker: FinalizationBarrierRecord): Promise<void>
  recordReceipt(input: Omit<Receipt, 'token'>, now: number): Promise<unknown>
  recordProtected(input: Omit<Snapshot, 'token'>, now: number): Promise<unknown>
  recordDurable(input: Omit<Snapshot, 'token'>, now: number): Promise<unknown>
  randomToken(): string
  now(): number
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
  )
}

function id(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value
  )
    throw new Error('Invalid multisig finalization bridge request')
  return value
}

function scope(value: Record<string, unknown>): Scope {
  if (value.network !== 'mainnet' && value.network !== 'testnet')
    throw new Error('Invalid multisig finalization bridge request')
  return { network: value.network, walletId: parseKeyDomainId(value.walletId) }
}

function ref(value: Record<string, unknown>): Ref {
  return {
    ...scope(value),
    accountId: parseAccountId(value.accountId),
    reviewId: id(value.reviewId),
    sessionId: parseSigningSessionId(value.sessionId)
  }
}

function owned(value: Record<string, unknown>): OwnedRef {
  return { ...ref(value), token: id(value.token) }
}

function hex(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
    throw new Error('Invalid multisig finalization bridge request')
  return value
}

function parseRequest(
  value: unknown
):
  | { operation: 'barrier.has'; payload: Scope }
  | { operation: 'barrier.begin'; payload: Ref }
  | { operation: 'barrier.clear'; payload: OwnedRef }
  | { operation: 'receipt'; payload: Receipt }
  | { operation: 'protected' | 'durable'; payload: Snapshot } {
  if (
    !exact(value, ['type', 'operation', 'payload']) ||
    value.type !== MULTISIG_FINALIZATION_BRIDGE_TYPE
  )
    throw new Error('Invalid multisig finalization bridge request')
  const operation = value.operation as Operation
  const payload = value.payload
  const base = ['network', 'walletId']
  const binding = [...base, 'accountId', 'reviewId', 'sessionId']
  const withToken = [...binding, 'token']
  if (operation === 'barrier.has' && exact(payload, base))
    return { operation, payload: scope(payload) }
  if (operation === 'barrier.begin' && exact(payload, binding))
    return { operation, payload: ref(payload) }
  if (operation === 'barrier.clear' && exact(payload, withToken))
    return { operation, payload: owned(payload) }
  if (
    operation === 'receipt' &&
    exact(payload, [...withToken, 'txId', 'rawTxSha256', 'rawTxLen'])
  ) {
    if (
      !Number.isSafeInteger(payload.rawTxLen) ||
      (payload.rawTxLen as number) < 1 ||
      (payload.rawTxLen as number) > 16 * 1024 * 1024
    )
      throw new Error('Invalid multisig finalization bridge request')
    return {
      operation,
      payload: {
        ...owned(payload),
        txId: hex(payload.txId),
        rawTxSha256: hex(payload.rawTxSha256),
        rawTxLen: payload.rawTxLen as number
      }
    }
  }
  if (
    (operation === 'protected' || operation === 'durable') &&
    exact(payload, [...withToken, 'txId', 'snapshotSha256'])
  )
    return {
      operation,
      payload: {
        ...owned(payload),
        txId: hex(payload.txId),
        snapshotSha256: hex(payload.snapshotSha256)
      }
    }
  throw new Error('Invalid multisig finalization bridge request')
}

function marker(input: OwnedRef): FinalizationBarrierRecord {
  return {
    version: 1,
    network: input.network,
    walletId: input.walletId,
    accountId: input.accountId,
    reviewId: input.reviewId,
    sessionId: input.sessionId,
    token: input.token
  }
}

async function assertRecoveryPhase(
  input: Ref,
  expected: string,
  ports: MultisigFinalizationBridgePorts
): Promise<void> {
  const matches = (await ports.listRecovery()).filter(record => {
    const binding = record.binding
    return (
      binding.network === input.network &&
      binding.walletId === input.walletId &&
      binding.accountId === input.accountId &&
      binding.reviewId === input.reviewId &&
      binding.sessionId === input.sessionId
    )
  })
  if (matches.length !== 1 || matches[0].phase !== expected)
    throw new Error('Multisig finalization recovery phase mismatch')
}

export async function handleMultisigFinalizationBridge(
  message: unknown,
  senderContext: OwnExtensionSenderContext | null,
  ports: MultisigFinalizationBridgePorts
): Promise<boolean | FinalizationBarrierRecord> {
  if (senderContext !== 'offscreen-document')
    throw new Error('Unauthorized multisig finalization bridge sender')
  let request: ReturnType<typeof parseRequest>
  try {
    request = parseRequest(message)
  } catch {
    throw new Error('Invalid multisig finalization bridge request')
  }
  const { operation, payload } = request
  if (operation === 'barrier.has') return ports.hasBarrier(payload)
  if (operation === 'barrier.begin') {
    await assertRecoveryPhase(payload, 'prepared', ports)
    return ports.beginBarrier(payload, ports.randomToken())
  }
  const owner = marker(payload)
  await ports.assertBarrierOwned(owner)
  if (operation === 'barrier.clear') {
    await assertRecoveryPhase(payload, 'durable_finalization', ports)
    await ports.clearBarrier(owner)
    return true
  }
  if (operation === 'receipt') {
    await assertRecoveryPhase(payload, 'prepared', ports)
    const { token: _token, ...input } = payload
    await ports.recordReceipt(input, ports.now())
    return true
  }
  if (operation === 'protected') {
    await assertRecoveryPhase(payload, 'receipt', ports)
    const { token: _token, ...input } = payload
    await ports.recordProtected(input, ports.now())
    return true
  }
  await assertRecoveryPhase(payload, 'protected_snapshot_verified', ports)
  const { token: _token, ...input } = payload
  await ports.recordDurable(input, ports.now())
  return true
}
