import { useEffect, useRef, useState } from 'react'
import {
  addInspectedToken,
  inspectTokenAddress,
  isEvmTokenContractAddress,
  type InspectedTokenAddress
} from '@/popup/services/token-address-discovery'

export interface TokenPickerDiscovery {
  readonly scopeKey: string
  readonly chainId: string | null
  readonly onAdded: (result: InspectedTokenAddress) => string | void | Promise<string | void>
}

export function useTokenPickerDiscovery(
  discovery: TokenPickerDiscovery | undefined,
  search: string,
  hasMatches: boolean
) {
  const contractAddress = search.trim()
  const key = `${discovery?.scopeKey ?? ''}:${discovery?.chainId ?? ''}:${contractAddress.toLowerCase()}`
  const latestKey = useRef(key)
  const generation = useRef(0)
  const mounted = useRef(false)
  if (latestKey.current !== key) generation.current += 1
  latestKey.current = key

  const [inspected, setInspected] = useState<{ key: string; result: InspectedTokenAddress } | null>(
    null
  )
  const [error, setError] = useState<{ key: string; message: string } | null>(null)
  const [inspectingKey, setInspectingKey] = useState<string | null>(null)
  const [addingKey, setAddingKey] = useState<string | null>(null)
  const [added, setAdded] = useState<{ key: string; message: string } | null>(null)
  const addressSearch = Boolean(discovery) && isEvmTokenContractAddress(contractAddress)
  const chainId = discovery?.chainId

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (!addressSearch || !chainId || hasMatches) return
    let cancelled = false
    const requestGeneration = generation.current
    const isCurrent = () =>
      !cancelled && mounted.current && generation.current === requestGeneration
    setError(null)
    setInspectingKey(key)
    void inspectTokenAddress({ chainId, contractAddress })
      .then(result => {
        if (isCurrent()) setInspected({ key, result })
      })
      .catch(() => {
        if (isCurrent()) setError({ key, message: 'Token could not be verified on this network' })
      })
      .finally(() => {
        if (isCurrent()) setInspectingKey(null)
      })
    return () => {
      cancelled = true
    }
  }, [addressSearch, chainId, contractAddress, hasMatches, key])

  const result = !hasMatches && inspected?.key === key ? inspected.result : null

  async function addToken() {
    if (!result || !discovery || addingKey || latestKey.current !== key) return
    const requestGeneration = generation.current
    const isCurrent = () => mounted.current && generation.current === requestGeneration
    setError(null)
    setAddingKey(key)
    try {
      await addInspectedToken(result.candidate)
      if (!isCurrent()) return
      const message = (await discovery.onAdded(result)) || 'Added to wallet'
      if (!isCurrent()) return
      setInspected(null)
      setAdded({ key, message })
    } catch {
      if (isCurrent()) setError({ key, message: 'Could not add token' })
    } finally {
      if (mounted.current) setAddingKey(null)
    }
  }

  return {
    result,
    needsChain: addressSearch && !chainId,
    inspecting: !hasMatches && inspectingKey === key,
    adding: addingKey === key,
    error: error?.key === key ? error.message : undefined,
    added: added?.key === key ? added.message : undefined,
    addToken
  }
}
