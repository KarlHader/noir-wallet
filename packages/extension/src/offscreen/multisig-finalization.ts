export interface FinalizedMultisigReceipt {
  accountId: string
  txId: string
  rawTxSha256: string
  rawTxLen: number
  network: 'mainnet' | 'testnet'
}

export interface PersistedMultisigReceipt extends FinalizedMultisigReceipt {
  snapshotSha256: string
}

type Scope = { walletId: string; accountId: string; network: 'mainnet' | 'testnet' }
type Snapshot = Scope & { chunks: Uint8Array[] }
type ProtectedSnapshot = Snapshot & { txId: string }

interface FinalizationPorts<TBarrier> {
  beginBarrier(): Promise<TBarrier>
  finalize(): Promise<unknown>
  recordReceipt(receipt: FinalizedMultisigReceipt, barrier: TBarrier): Promise<void>
  snapshot(): Promise<Uint8Array[]>
  saveVerifiedSnapshot(input: ProtectedSnapshot): Promise<{ snapshotSha256: string }>
  recordProtectedSnapshot(receipt: PersistedMultisigReceipt, barrier: TBarrier): Promise<void>
  saveVerifiedMainSnapshot(input: Snapshot): Promise<void>
  assertStable(): void
  recordDurableFinalization(receipt: PersistedMultisigReceipt, barrier: TBarrier): Promise<void>
  clearBarrier(barrier: TBarrier): Promise<void>
}

export function createMultisigFinalizationExclusion() {
  const busyWallets = new Set<string>()
  return {
    isBusy(walletId: string): boolean {
      return busyWallets.has(walletId)
    },
    async run<T>(walletId: string, operation: () => Promise<T>): Promise<T> {
      if (busyWallets.has(walletId)) throw new Error('Multisig finalization already in progress')
      busyWallets.add(walletId)
      try {
        return await operation()
      } finally {
        busyWallets.delete(walletId)
      }
    }
  }
}

export async function saveAndReadbackMainWalletSnapshot(
  key: string,
  chunks: Uint8Array[],
  storage: {
    saveWalletDb(key: string, chunks: Uint8Array[]): Promise<void>
    loadWalletDb(key: string): Promise<Uint8Array | null>
  }
): Promise<void> {
  await storage.saveWalletDb(key, chunks)
  const stored = await storage.loadWalletDb(key)
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  if (!stored || stored.byteLength !== length)
    throw new Error('Multisig main wallet snapshot readback failed')
  let position = 0
  for (const chunk of chunks)
    for (const byte of chunk)
      if (stored[position++] !== byte)
        throw new Error('Multisig main wallet snapshot readback failed')
}

export async function submitMultisigOnce<T>(ports: {
  submit(): Promise<T>
  saveMainSnapshot(): Promise<void>
}): Promise<T> {
  const result = await ports.submit()
  await ports.saveMainSnapshot()
  return result
}

const HEX_32 = /^[0-9a-f]{64}$/

function parseReceipt(value: unknown, scope: Scope): FinalizedMultisigReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid multisig finalization receipt')
  const receipt = value as Record<string, unknown>
  if (
    Object.keys(receipt).length !== 5 ||
    receipt.accountId !== scope.accountId ||
    !HEX_32.test(String(receipt.txId)) ||
    !HEX_32.test(String(receipt.rawTxSha256)) ||
    !Number.isSafeInteger(receipt.rawTxLen) ||
    (receipt.rawTxLen as number) < 1 ||
    (receipt.rawTxLen as number) > 16 * 1024 * 1024 ||
    receipt.network !== scope.network
  )
    throw new Error('Invalid multisig finalization receipt')
  return receipt as unknown as FinalizedMultisigReceipt
}

/** The caller owns the wallet exclusion and failure quarantine. */
export async function finalizeMultisigWithSnapshot<TBarrier>(
  scope: Scope,
  ports: FinalizationPorts<TBarrier>
): Promise<PersistedMultisigReceipt> {
  const barrier = await ports.beginBarrier()
  const receipt = parseReceipt(await ports.finalize(), scope)
  await ports.recordReceipt(receipt, barrier)
  const chunks = await ports.snapshot()
  if (
    !Array.isArray(chunks) ||
    chunks.length === 0 ||
    chunks.some(chunk => !(chunk instanceof Uint8Array) || chunk.length === 0)
  )
    throw new Error('Invalid multisig wallet snapshot')
  const { snapshotSha256 } = await ports.saveVerifiedSnapshot({
    ...scope,
    txId: receipt.txId,
    chunks
  })
  if (!HEX_32.test(snapshotSha256)) throw new Error('Invalid multisig wallet snapshot digest')
  const persisted = { ...receipt, snapshotSha256 }
  await ports.recordProtectedSnapshot(persisted, barrier)
  await ports.saveVerifiedMainSnapshot({ ...scope, chunks })
  ports.assertStable()
  await ports.recordDurableFinalization(persisted, barrier)
  ports.assertStable()
  await ports.clearBarrier(barrier)
  return persisted
}
