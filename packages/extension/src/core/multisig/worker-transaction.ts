import { sha256 } from '@noble/hashes/sha2'
import type * as WalletWasm from '@/lib/wasm-pkg/zcash_wallet_wasm'
import { bytesToHex, hexToBytes } from '@/lib/bytes'
import { parseTransferResult } from '@/core/zcash/transfer-result'

export interface StoredMultisigTransaction {
  txId: string
  rawTxSha256: string
  rawTxLen: number
  network: 'mainnet' | 'testnet'
}

type TransactionWallet = Pick<
  WalletWasm.WebWallet,
  | 'pczt_prove'
  | 'pczt_store_detailed'
  | 'get_stored_transaction_bytes'
  | 'send_authorized_transactions'
>

const FAIL = 'Stored multisig transaction does not match the signed transaction'
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

function parseReceipt(value: unknown, network: 'mainnet' | 'testnet'): StoredMultisigTransaction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(FAIL)
  const raw = value as Record<string, unknown>
  if (
    Object.keys(raw).length !== 4 ||
    !digest(raw.txId) ||
    !digest(raw.rawTxSha256) ||
    !Number.isSafeInteger(raw.rawTxLen) ||
    Number(raw.rawTxLen) < 1 ||
    Number(raw.rawTxLen) > 16 * 1024 * 1024 ||
    raw.network !== network
  )
    throw new Error(FAIL)
  return {
    txId: raw.txId,
    rawTxSha256: raw.rawTxSha256,
    rawTxLen: raw.rawTxLen as number,
    network
  }
}

async function verifyStoredBytes(
  wallet: Pick<TransactionWallet, 'get_stored_transaction_bytes'>,
  receipt: StoredMultisigTransaction
): Promise<void> {
  const bytes = await wallet.get_stored_transaction_bytes(receipt.txId)
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length !== receipt.rawTxLen ||
    bytesToHex(sha256(bytes)) !== receipt.rawTxSha256
  )
    throw new Error(FAIL)
}

/** Only the Worker calls this with the one-time signed PCZT retained by its coordinator. */
export async function finalizeSignedPczt(
  wasm: Pick<typeof WalletWasm, 'Pczt' | 'PcztTools'>,
  wallet: TransactionWallet,
  signedBytes: Uint8Array,
  network: 'mainnet' | 'testnet',
  assertAuthorized: () => void,
  assertFreshBeforeStore: () => Promise<void>
): Promise<StoredMultisigTransaction> {
  assertAuthorized()
  const signedSighash = wasm.PcztTools.shielded_sighash(signedBytes)
  if (!(signedSighash instanceof Uint8Array) || signedSighash.length !== 32) throw new Error(FAIL)
  const signed = wasm.Pczt.from_bytes(signedBytes)
  assertAuthorized()
  const proved = await wallet.pczt_prove(signed)
  assertAuthorized()
  const provedSighash = wasm.PcztTools.shielded_sighash(proved.serialize())
  if (
    !(provedSighash instanceof Uint8Array) ||
    provedSighash.length !== signedSighash.length ||
    !provedSighash.every((byte, index) => byte === signedSighash[index])
  )
    throw new Error(FAIL)
  await assertFreshBeforeStore()
  assertAuthorized()
  const receipt = parseReceipt(await wallet.pczt_store_detailed(proved), network)
  assertAuthorized()
  await verifyStoredBytes(wallet, receipt)
  assertAuthorized()
  return receipt
}

/** A caller may attempt this once, only after the durable unknown marker is acknowledged. */
export async function submitStoredTransaction(
  wallet: Pick<TransactionWallet, 'get_stored_transaction_bytes' | 'send_authorized_transactions'>,
  receipt: StoredMultisigTransaction,
  assertAuthorized: () => void
): Promise<{ status: 'broadcast' | 'submission_unknown'; txId: string }> {
  assertAuthorized()
  await verifyStoredBytes(wallet, receipt)
  assertAuthorized()
  const internalTxId = hexToBytes(receipt.txId).reverse()
  const response = parseTransferResult(await wallet.send_authorized_transactions(internalTxId))
  return {
    status:
      response.status === 'success' &&
      response.txIds.length === 1 &&
      response.txIds[0] === receipt.txId &&
      response.transactions.length === 1 &&
      response.transactions[0].status === 'submitted'
        ? 'broadcast'
        : 'submission_unknown',
    txId: receipt.txId
  }
}
