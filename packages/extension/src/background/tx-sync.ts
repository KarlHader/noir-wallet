import { backgroundZcashWalletRuntime } from './zcash-wallet-runtime'
import { syncScheduler } from './sync-scheduler'
import { syncJobStore } from '@/lib/sync-job-store'
import { logger } from '@/lib/logger'
import { useWalletStore } from '@/store/wallet-store'

// accountKey format from buildAccountKey: `${network}_${walletId}_${accountId}`
// (network and UUIDs never contain underscores)
export function parseAccountKey(
  accountKey: string
): { walletId: string; accountId: string } | null {
  const parts = accountKey.split('_')
  if (parts.length < 3) return null
  return { walletId: parts[1], accountId: parts[2] }
}

export function isForegroundWallet(walletId: string): boolean {
  const { currentWalletId } = useWalletStore.getState()
  const fg = syncScheduler.getForegroundWalletId() || currentWalletId
  return fg === walletId
}

// Persist the catch-up request before scheduling work so a service-worker
// restart can still resume it from the wallet snapshot.
export async function markWalletNeedsCatchUp(walletId: string, accountId?: string): Promise<void> {
  const network = backgroundZcashWalletRuntime.getNetwork()
  const wallet = useWalletStore.getState().getWallet(walletId)
  const resolvedAccountId =
    accountId || wallet?.accounts[0]?.id || useWalletStore.getState().currentAccountId

  const scannedHeight = backgroundZcashWalletRuntime.getWalletScannedHeight(walletId)

  await syncJobStore.upsert(walletId, network, {
    accountId: resolvedAccountId || '',
    status: 'interrupted',
    resumeOnStartup: true,
    ...(scannedHeight > 0 ? { lastPersistedHeight: scannedHeight } : {})
  })

  logger.log(
    'Marked wallet for catch-up on next foreground sync',
    walletId,
    resolvedAccountId ?? undefined
  )
}

/** Refreshes the pending balance produced by WASM without forcing chain settlement. */
export async function refreshAfterOnChainBroadcast(walletId: string): Promise<void> {
  await backgroundZcashWalletRuntime.refreshBalances(walletId, true)
}

export async function catchUpAfterOnChainTx(walletId: string, accountId: string): Promise<boolean> {
  await markWalletNeedsCatchUp(walletId, accountId)
  const status = await syncScheduler.runTransactionCatchUp(walletId, accountId)
  if (status !== 'completed') {
    logger.warn(`Tx catch-up sync ${status}, scheduling retry`, walletId, accountId)
    await markWalletNeedsCatchUp(walletId, accountId)
    backgroundZcashWalletRuntime.requestSync()
  }

  await backgroundZcashWalletRuntime.refreshBalances(walletId, true)
  await backgroundZcashWalletRuntime
    .refreshTransactionHistoryFromWasm(walletId, accountId)
    .catch(() => {})
  return status === 'completed'
}

export async function finalizeTxCatchUp(accountKey: string): Promise<boolean> {
  const parsed = parseAccountKey(accountKey)
  if (!parsed) return false

  const { walletId, accountId } = parsed

  if (isForegroundWallet(walletId)) {
    try {
      return await catchUpAfterOnChainTx(walletId, accountId)
    } catch (err) {
      logger.warn('Foreground catch-up after tx confirm failed', walletId, accountId)
      console.error('[TxSync] catch-up failed:', err)
      await markWalletNeedsCatchUp(walletId, accountId)
      backgroundZcashWalletRuntime.requestSync()
    }
    return false
  }

  await markWalletNeedsCatchUp(walletId, accountId)
  return false
}
