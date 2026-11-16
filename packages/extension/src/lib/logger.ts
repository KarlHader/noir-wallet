import { formatWalletLogPrefix } from './log-format'
import type { DiagnosticLogDraft, DiagnosticLogLevel, DiagnosticLogSource } from './diagnostic-log'
import { sanitizeDiagnosticMessage, serializeDiagnosticArgs } from './diagnostic-log'
import { formatDiagnosticContext } from './diagnostic-log-store'

const isServiceWorker =
  typeof self !== 'undefined' &&
  'ServiceWorkerGlobalScope' in self &&
  self instanceof (self as any).ServiceWorkerGlobalScope
const debugLogsEnabled = typeof __DEBUG_LOGS__ !== 'boolean' || __DEBUG_LOGS__
const diagnosticContextId =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `context-${Date.now()}`
const diagnosticSource: DiagnosticLogSource = isServiceWorker
  ? 'background'
  : typeof location !== 'undefined' && location.pathname.includes('/offscreen/')
    ? 'offscreen'
    : 'popup'
interface WalletLogMetadata {
  readonly id: string
  readonly name: string
  readonly accounts: ReadonlyArray<{ readonly id: string }>
}

class WalletLogger {
  private accountWalletCache = new Map<string, string>()
  private walletNameCache = new Map<string, string>()
  private diagnosticSequence = 0
  private diagnosticWriter: ((entry: DiagnosticLogDraft) => Promise<void>) | null = null

  configureDiagnostics(write: ((entry: DiagnosticLogDraft) => Promise<void>) | null): void {
    this.diagnosticWriter = write
  }

  private persist(
    level: DiagnosticLogLevel,
    message: string,
    walletId?: string,
    accountId?: string,
    error?: unknown
  ): void {
    if (!this.diagnosticWriter && typeof chrome === 'undefined') return
    const entry = {
      source: diagnosticSource,
      level,
      message: serializeDiagnosticArgs(error === undefined ? [message] : [message, error]),
      timestamp: Date.now(),
      contextId: diagnosticContextId,
      sequence: this.diagnosticSequence++
    }
    void formatDiagnosticContext(walletId, accountId)
      .then(context => {
        entry.message = [entry.message, context].filter(Boolean).join(' ')
        return this.diagnosticWriter
          ? this.diagnosticWriter(entry)
          : chrome.runtime.sendMessage({ type: 'APPEND_DIAGNOSTIC_LOG', entry })
      })
      .catch(() => {})
  }

  log(msg: string, walletId?: string, accountId?: string, error?: unknown): void {
    this.persist('debug', msg, walletId, accountId, error)
    if (!debugLogsEnabled) return
    const prefix = this.getPrefix(walletId, accountId)
    console.log(prefix, sanitizeDiagnosticMessage(msg))
  }

  info(msg: string, walletId?: string, accountId?: string, error?: unknown): void {
    this.persist('info', msg, walletId, accountId, error)
    if (!debugLogsEnabled) return
    const prefix = this.getPrefix(walletId, accountId)
    console.info(prefix, sanitizeDiagnosticMessage(msg))
  }

  warn(msg: string, walletId?: string, accountId?: string, error?: unknown): void {
    this.persist('warn', msg, walletId, accountId, error)
    if (!debugLogsEnabled) return
    const prefix = this.getPrefix(walletId, accountId)
    console.warn(prefix, sanitizeDiagnosticMessage(msg))
  }

  error(msg: string, walletId?: string, accountId?: string, error?: unknown): void {
    this.persist('error', msg, walletId, accountId, error)
    if (!debugLogsEnabled) return
    const prefix = this.getPrefix(walletId, accountId)
    if (isServiceWorker) {
      console.warn(prefix, '[ERROR]', sanitizeDiagnosticMessage(msg))
    } else {
      console.error(prefix, sanitizeDiagnosticMessage(msg))
    }
  }

  getPrefix(walletId?: string, accountId?: string): string {
    if (!walletId) return '[Log]'

    if (accountId) {
      return this.formatPrefix(this.accountWalletCache.get(accountId) ?? walletId, accountId)
    }

    return this.formatPrefix(walletId)
  }

  getSyncPrefix(walletId: string, accountId: string): string {
    return this.formatPrefix(this.accountWalletCache.get(accountId) ?? walletId, accountId)
  }

  getWalletLabel(walletId: string): string {
    return this.walletNameCache.get(walletId) || walletId.slice(0, 6)
  }

  private formatPrefix(walletId: string, accountId?: string): string {
    const walletName = this.walletNameCache.get(walletId) || walletId.slice(0, 6)
    return formatWalletLogPrefix(walletName, accountId)
  }

  refreshCache(wallets: readonly WalletLogMetadata[]): void {
    if (!wallets.length) return

    this.accountWalletCache.clear()
    this.walletNameCache.clear()

    for (let i = 0; i < wallets.length; i++) {
      const wallet = wallets[i]
      const displayName =
        wallet.name.match(/^Wallet \d+$/) && wallet.name.length > 15
          ? `Wallet ${i + 1}`
          : wallet.name
      this.walletNameCache.set(wallet.id, displayName)

      for (const account of wallet.accounts) {
        this.accountWalletCache.set(account.id, wallet.id)
      }
    }
  }

  clearCache(): void {
    this.accountWalletCache.clear()
    this.walletNameCache.clear()
  }
}

export const logger = new WalletLogger()
