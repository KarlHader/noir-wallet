import type { FinalizationBarrierRecord } from '@/lib/multisig-finalization-barrier'
import { MULTISIG_FINALIZATION_BRIDGE_TYPE } from '@/background/multisig-finalization-bridge'

type Scope = { network: 'mainnet' | 'testnet'; walletId: string }
type Ref = Scope & { accountId: string; reviewId: string; sessionId: string }
type Receipt = { txId: string; rawTxSha256: string; rawTxLen: number }
type Snapshot = { txId: string; snapshotSha256: string }
type Send = (message: unknown) => Promise<unknown>

const runtimeSend: Send = message => chrome.runtime.sendMessage(message)

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
  )
}

function parseBarrier(value: unknown, ref: Ref): FinalizationBarrierRecord {
  if (
    !exact(value, [
      'version',
      'network',
      'walletId',
      'accountId',
      'reviewId',
      'sessionId',
      'token'
    ]) ||
    value.version !== 1 ||
    value.network !== ref.network ||
    value.walletId !== ref.walletId ||
    value.accountId !== ref.accountId ||
    value.reviewId !== ref.reviewId ||
    value.sessionId !== ref.sessionId ||
    typeof value.token !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.token)
  )
    throw new Error('Multisig finalization persistence unavailable')
  return value as unknown as FinalizationBarrierRecord
}

export function createMultisigFinalizationBridgeClient(send: Send = runtimeSend) {
  async function request(operation: string, payload: object): Promise<unknown> {
    const response = await send({ type: MULTISIG_FINALIZATION_BRIDGE_TYPE, operation, payload })
    if (!exact(response, ['result']))
      throw new Error('Multisig finalization persistence unavailable')
    return response.result
  }
  async function requireSaved(operation: string, payload: object): Promise<void> {
    if ((await request(operation, payload)) !== true)
      throw new Error('Multisig finalization persistence unavailable')
  }
  return {
    async hasBarrier(scope: Scope): Promise<boolean> {
      const result = await request('barrier.has', scope)
      if (typeof result !== 'boolean')
        throw new Error('Multisig finalization persistence unavailable')
      return result
    },
    async beginBarrier(ref: Ref): Promise<FinalizationBarrierRecord> {
      return parseBarrier(await request('barrier.begin', ref), ref)
    },
    async clearBarrier(ref: Ref, marker: FinalizationBarrierRecord): Promise<void> {
      await requireSaved('barrier.clear', { ...ref, token: marker.token })
    },
    async recordReceipt(
      ref: Ref,
      marker: FinalizationBarrierRecord,
      receipt: Receipt
    ): Promise<void> {
      await requireSaved('receipt', { ...ref, token: marker.token, ...receipt })
    },
    async recordProtected(
      ref: Ref,
      marker: FinalizationBarrierRecord,
      snapshot: Snapshot
    ): Promise<void> {
      await requireSaved('protected', { ...ref, token: marker.token, ...snapshot })
    },
    async recordDurable(
      ref: Ref,
      marker: FinalizationBarrierRecord,
      snapshot: Snapshot
    ): Promise<void> {
      await requireSaved('durable', { ...ref, token: marker.token, ...snapshot })
    }
  }
}
