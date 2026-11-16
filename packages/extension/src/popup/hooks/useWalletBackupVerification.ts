import { useCallback, useEffect, useRef, useState } from 'react'
import type { WalletBackupVerification } from '@/core/wallet/secret-phrase-backup'
import { didCredentialSessionEnd } from '@/core/wallet/credential-session-state'
import { classifyError } from '@/lib/errors'
import { zcashWalletRuntimeClient } from '@/popup/services/zcash-wallet-runtime-client'

export function useWalletBackupVerification(walletId: string | null) {
  const [wordIndices, setWordIndices] = useState<[number, number] | null>(null)
  const [words, setWords] = useState<[string, string]>(['', ''])
  const [error, setError] = useState('')
  const [isPreparing, setIsPreparing] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const version = useRef(0)
  const mounted = useRef(false)
  const sessionEnded = useRef(false)
  const submitting = useRef(false)

  const reset = useCallback(() => {
    version.current += 1
    setWordIndices(null)
    setWords(['', ''])
    setError('')
    setIsPreparing(false)
    setIsSubmitting(false)
  }, [])

  useEffect(() => {
    mounted.current = true
    sessionEnded.current = false
    reset()
    const onStorageChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      if (!didCredentialSessionEnd(changes, area)) return
      sessionEnded.current = true
      reset()
    }
    chrome.storage.onChanged.addListener(onStorageChange)
    return () => {
      mounted.current = false
      version.current += 1
      chrome.storage.onChanged.removeListener(onStorageChange)
    }
  }, [walletId, reset])

  const isCurrent = (requestVersion: number) =>
    mounted.current && !sessionEnded.current && version.current === requestVersion

  const prepare = useCallback(async () => {
    if (!walletId || sessionEnded.current || submitting.current) return false
    reset()
    const requestVersion = version.current
    setIsPreparing(true)
    try {
      const indices = await zcashWalletRuntimeClient.getWalletBackupWordIndices(walletId)
      if (!isCurrent(requestVersion)) return false
      setWordIndices(indices)
      return true
    } catch (cause) {
      if (isCurrent(requestVersion)) setError(classifyError(cause).userMessage)
      return false
    } finally {
      if (isCurrent(requestVersion)) setIsPreparing(false)
    }
  }, [walletId, reset])

  const setWord = (position: number, value: string) => {
    if (submitting.current || (position !== 0 && position !== 1)) return
    setWords(current => {
      const next: [string, string] = [...current]
      next[position] = value
      return next
    })
    setError('')
  }

  const canSubmit = Boolean(
    walletId && wordIndices && words.every(word => word.trim()) && !isPreparing && !isSubmitting
  )

  const submit = async (action: (verification: WalletBackupVerification) => Promise<void>) => {
    const requestVersion = version.current
    if (!wordIndices || !canSubmit || submitting.current || !isCurrent(requestVersion)) return
    submitting.current = true
    setIsSubmitting(true)
    setError('')
    try {
      await action({ wordIndices, words: [words[0].trim(), words[1].trim()] })
    } catch (cause) {
      if (isCurrent(requestVersion)) setError(classifyError(cause).userMessage)
    } finally {
      submitting.current = false
      if (isCurrent(requestVersion)) setIsSubmitting(false)
    }
  }

  return {
    wordIndices,
    words,
    error,
    isPreparing,
    isSubmitting,
    canSubmit,
    prepare,
    reset,
    setWord,
    submit
  }
}
