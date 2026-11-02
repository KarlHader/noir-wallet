import { useState, useEffect, useRef, useCallback } from 'react'
import { getZnsClient, isZnsName, normalizeZnsName } from '@/lib/zns'
import { useWalletStore } from '@/store/wallet-store'

interface ZnsResolveResult {
  /** Resolved Zcash address, null when not resolved */
  address: string | null
  /** Original ZNS name the user typed */
  name: string | null
  loading: boolean
  error: string | null
  retryable: boolean
  retry: () => void
}

const DEBOUNCE_MS = 500

export function useZnsResolve(input: string): ZnsResolveResult {
  const [address, setAddress] = useState<string | null>(null)
  const [name, setName] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retryable, setRetryable] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt(value => value + 1), [])
  const network = useWalletStore(s => s.currentNetwork)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    abortRef.current?.abort()
    setRetryable(false)
    setAddress(null)
    setName(null)

    if (!isZnsName(input)) {
      setAddress(null)
      setName(null)
      setError(null)
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    const ctrl = new AbortController()
    abortRef.current = ctrl

    const timer = setTimeout(async () => {
      const normalized = normalizeZnsName(input)
      try {
        const zns = getZnsClient(network)
        const reg = await zns.resolveName(normalized)
        if (ctrl.signal.aborted) return
        if (reg) {
          setAddress(reg.address)
          setName(`${normalized}.zcash`)
          setError(null)
        } else {
          setAddress(null)
          setName(null)
          setError('Name not found')
        }
      } catch {
        if (!ctrl.signal.aborted) {
          setAddress(null)
          setName(null)
          setError('Resolution failed')
          setRetryable(true)
        }
      } finally {
        if (!ctrl.signal.aborted) setLoading(false)
      }
    }, DEBOUNCE_MS)

    return () => {
      ctrl.abort()
      clearTimeout(timer)
    }
  }, [input, network, attempt])

  return { address, name, loading, error, retryable, retry }
}
