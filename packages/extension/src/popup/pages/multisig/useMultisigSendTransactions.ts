import { useEffect, useRef, useState } from 'react'
import {
  listMultisigSendTransactions,
  readMultisigSendRecovery
} from '@/popup/services/multisig-send-client'
import { mergeMultisigSendTransactions } from './send-model'
import type { VaultSendTransaction } from '@/core/multisig/send-rpc'
import type { MultisigGroupScope } from '@/lib/multisig-group-storage'

type LoadStatus = 'loading' | 'ready' | 'error'

/** Read the local journal; network confirmation monitoring remains Background-owned. */
export function useMultisigSendTransactions(scope: MultisigGroupScope) {
  const scopeKey = JSON.stringify([scope.network, scope.walletId, scope.accountId])
  const [transactions, setTransactions] = useState<VaultSendTransaction[]>([])
  const currentTransactions = useRef<VaultSendTransaction[]>([])
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [loadedScopeKey, setLoadedScopeKey] = useState<string | null>(null)
  const [hasSignedWithoutTransaction, setHasSignedWithoutTransaction] = useState(false)
  const [refreshIndex, setRefreshIndex] = useState(0)

  useEffect(() => {
    let isActive = true
    let latestRead = 0
    if (loadedScopeKey !== scopeKey) {
      currentTransactions.current = []
      setTransactions([])
      setStatus('loading')
    }
    const load = async () => {
      const read = ++latestRead
      try {
        const [incoming, recovery] = await Promise.all([
          listMultisigSendTransactions(scope),
          readMultisigSendRecovery(scope)
        ])
        if (!isActive || read !== latestRead) return
        if (typeof recovery.signedWithoutTransaction !== 'boolean')
          throw new Error('Invalid recovery state')
        const merged = mergeMultisigSendTransactions(currentTransactions.current, incoming, scope)
        currentTransactions.current = merged
        setTransactions(merged)
        setHasSignedWithoutTransaction(recovery.signedWithoutTransaction)
        setLoadedScopeKey(scopeKey)
        setStatus('ready')
      } catch {
        if (isActive && read === latestRead) {
          setLoadedScopeKey(scopeKey)
          setStatus('error')
        }
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), 15_000)
    return () => {
      isActive = false
      window.clearInterval(timer)
    }
  }, [scope.accountId, scope.network, scope.walletId, scopeKey, refreshIndex])

  const isCurrentScope = loadedScopeKey === scopeKey

  return {
    transactions: isCurrentScope ? transactions : [],
    status: isCurrentScope ? status : 'loading',
    hasSignedWithoutTransaction: isCurrentScope && hasSignedWithoutTransaction,
    refresh: () => {
      setStatus('loading')
      setRefreshIndex(index => index + 1)
    }
  }
}
