import type { Network, SyncReason } from '@/types'
import { WALLET_CONFIG } from '@/config/wallet'

export interface SyncJob {
  walletId: string
  accountId: string
  network: Network
  targetHeight: number
  lastPersistedHeight: number
  status: 'running' | 'interrupted' | 'completed' | 'failed'
  updatedAt: number
  startedAt: number
  batchCount: number
  persistFailures: string[]
  reason?: SyncReason
  resumeOnStartup?: boolean
}

export interface SyncJobCompletionState {
  snapshotFailed: boolean
  flushFailed: boolean
  finalPersistFailed: boolean
  skippedFinalPersist: boolean
  hasPendingJournal: boolean
  hasPendingBalanceSettlement: boolean
}

export function shouldMarkSyncJobInterrupted(state: SyncJobCompletionState): boolean {
  return (
    state.snapshotFailed ||
    state.flushFailed ||
    state.finalPersistFailed ||
    (state.skippedFinalPersist && state.hasPendingJournal)
  )
}

const STORAGE_KEY = 'sync_jobs'
const MAX_PERSIST_FAILURES = 20

function jobKey(walletId: string, network: Network): string {
  return `${network}_${walletId}`
}

async function loadAll(): Promise<Record<string, SyncJob>> {
  const data = await chrome.storage.local.get(STORAGE_KEY)
  return (data[STORAGE_KEY] as Record<string, SyncJob>) || {}
}

async function saveAll(jobs: Record<string, SyncJob>): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: jobs })
}

export const syncJobStore = {
  async get(walletId: string, network: Network): Promise<SyncJob | null> {
    const jobs = await loadAll()
    return jobs[jobKey(walletId, network)] || null
  },

  async upsert(walletId: string, network: Network, patch: Partial<SyncJob>): Promise<SyncJob> {
    const jobs = await loadAll()
    const key = jobKey(walletId, network)
    const existing = jobs[key]
    const updated: SyncJob = {
      walletId,
      accountId: patch.accountId || existing?.accountId || '',
      network,
      targetHeight: patch.targetHeight ?? existing?.targetHeight ?? 0,
      lastPersistedHeight: patch.lastPersistedHeight ?? existing?.lastPersistedHeight ?? 0,
      status: patch.status ?? existing?.status ?? 'running',
      updatedAt: Date.now(),
      startedAt: patch.startedAt ?? existing?.startedAt ?? Date.now(),
      batchCount: patch.batchCount ?? existing?.batchCount ?? 0,
      persistFailures: patch.persistFailures ?? existing?.persistFailures ?? [],
      reason: patch.reason ?? existing?.reason,
      resumeOnStartup: patch.resumeOnStartup ?? existing?.resumeOnStartup
    }
    jobs[key] = updated
    await saveAll(jobs)
    return updated
  },

  async markRunning(
    walletId: string,
    accountId: string,
    network: Network,
    targetHeight: number,
    lastPersistedHeight: number,
    resumeOnStartup = true
  ): Promise<SyncJob> {
    return this.upsert(walletId, network, {
      accountId,
      targetHeight,
      lastPersistedHeight,
      status: 'running',
      startedAt: Date.now(),
      batchCount: 0,
      persistFailures: [],
      resumeOnStartup
    })
  },

  async checkpoint(
    walletId: string,
    network: Network,
    lastPersistedHeight: number,
    batchCount: number
  ): Promise<void> {
    await this.upsert(walletId, network, {
      lastPersistedHeight,
      batchCount,
      status: 'running'
    })
  },

  async markCompleted(
    walletId: string,
    network: Network,
    scannedHeight?: number,
    targetHeight?: number
  ): Promise<void> {
    const threshold = WALLET_CONFIG.SYNC.SILENT_SYNC_THRESHOLD_BLOCKS
    if (scannedHeight != null && targetHeight != null && scannedHeight < targetHeight - threshold) {
      await this.markInterrupted(walletId, network, scannedHeight)
      return
    }
    await this.upsert(walletId, network, {
      status: 'completed',
      ...(scannedHeight != null ? { lastPersistedHeight: scannedHeight } : {}),
      ...(targetHeight != null ? { targetHeight } : {})
    })
  },

  async markInterrupted(
    walletId: string,
    network: Network,
    lastPersistedHeight?: number
  ): Promise<void> {
    const job = await this.get(walletId, network)
    if (job && (job.status === 'running' || job.status === 'completed')) {
      await this.upsert(walletId, network, {
        status: 'interrupted',
        ...(lastPersistedHeight != null ? { lastPersistedHeight } : {})
      })
    }
  },

  async markFailed(walletId: string, network: Network): Promise<void> {
    await this.upsert(walletId, network, { status: 'failed' })
  },

  async recordPersistFailure(walletId: string, network: Network, error: string): Promise<void> {
    const job = await this.get(walletId, network)
    const failures = job?.persistFailures ?? []
    failures.push(`[${new Date().toISOString()}] ${error}`)
    if (failures.length > MAX_PERSIST_FAILURES) {
      failures.splice(0, failures.length - MAX_PERSIST_FAILURES)
    }
    await this.upsert(walletId, network, { persistFailures: failures })
  },

  async getInterrupted(network: Network): Promise<SyncJob[]> {
    const jobs = await loadAll()
    return Object.values(jobs).filter(j => j.network === network && j.status === 'interrupted')
  },

  async remove(walletId: string, network: Network): Promise<void> {
    const jobs = await loadAll()
    delete jobs[jobKey(walletId, network)]
    await saveAll(jobs)
  }
}
