import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ShieldChainInfo, ShieldTokenInfo } from '@noir-wallet/shield-sdk'

const KNOWN_CHAIN_NAMES: Readonly<Record<string, string>> = {
  'eip155:1': 'Ethereum',
  'eip155:10': 'Optimism',
  'eip155:56': 'BNB Chain',
  'eip155:100': 'Gnosis',
  'eip155:137': 'Polygon',
  'eip155:143': 'Monad',
  'eip155:196': 'X Layer',
  'eip155:8453': 'Base',
  'eip155:9745': 'Plasma',
  'eip155:42161': 'Arbitrum',
  'eip155:43114': 'Avalanche',
  'eip155:80094': 'Berachain',
  'bip122:00040fe8ec8471911baa1db1266ea15d': 'Zcash',
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'Solana',
  'near:mainnet': 'NEAR'
}

export function chainTitle(chainId: string, chains: readonly ShieldChainInfo[]): string {
  const loaded = chains.find(chain => chain.chainId === chainId)?.name.trim()
  if (loaded && loaded !== chainId) return loaded
  return KNOWN_CHAIN_NAMES[chainId] ?? chainId
}

export function assetHint(assetId: string): string {
  const reference = assetId.split('/').pop() ?? assetId
  const separator = reference.indexOf(':')
  const kind = separator === -1 ? '' : reference.slice(0, separator)
  const value = separator === -1 ? reference : reference.slice(separator + 1)
  if (kind === 'slip44') return 'Native'
  if (value.startsWith('0x') && value.length > 12) return `${value.slice(0, 6)}…${value.slice(-4)}`
  if (value.length > 18) return `${value.slice(0, 8)}…${value.slice(-4)}`
  return value
}

export function tokenMatches(
  token: ShieldTokenInfo,
  chains: readonly ShieldChainInfo[],
  query: string
): boolean {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return true
  const haystack = [
    token.symbol,
    chainTitle(token.chainId, chains),
    token.chainId,
    token.assetId,
    assetHint(token.assetId),
    String(token.decimals)
  ]
    .join(' ')
    .toLowerCase()
  return haystack.includes(needle)
}

export function TokenPicker({
  tokens,
  chains,
  chainId,
  assetId,
  onSelect
}: {
  tokens: readonly ShieldTokenInfo[]
  chains: readonly ShieldChainInfo[]
  chainId: string
  assetId: string
  onSelect: (token: ShieldTokenInfo) => void
}) {
  const listId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const selected = tokens.find(token => token.chainId === chainId && token.assetId === assetId)
  const visible = useMemo(
    () => tokens.filter(token => tokenMatches(token, chains, query)),
    [tokens, chains, query]
  )

  useEffect(() => {
    if (!open) return
    searchRef.current?.focus()
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="token-picker" ref={rootRef}>
      <button
        className="input token-trigger"
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() =>
          setOpen(current => {
            if (!current) setQuery('')
            return !current
          })
        }
      >
        {selected ? (
          <span className="token-selected">
            <strong>{selected.symbol}</strong>
            <span>{chainTitle(selected.chainId, chains)}</span>
          </span>
        ) : (
          <span className="token-placeholder">Select a loaded token</span>
        )}
      </button>
      {open ? (
        <div className="token-panel">
          <input
            ref={searchRef}
            className="input"
            value={query}
            placeholder="Search symbol or chain"
            aria-label="Search tokens"
            onChange={event => setQuery(event.target.value)}
          />
          {visible.length === 0 ? (
            <p className="token-empty">
              {tokens.length === 0 ? 'Load tokens first.' : 'No matching tokens.'}
            </p>
          ) : (
            <ul className="token-list" id={listId} role="listbox">
              {visible.map(token => {
                const active = token.chainId === chainId && token.assetId === assetId
                return (
                  <li key={`${token.chainId}:${token.assetId}`}>
                    <button
                      className="token-option"
                      type="button"
                      role="option"
                      aria-selected={active}
                      onClick={() => {
                        onSelect(token)
                        setOpen(false)
                      }}
                    >
                      <span className="token-symbol">{token.symbol}</span>
                      <span className="token-chain">{chainTitle(token.chainId, chains)}</span>
                      <span className="token-meta">
                        {assetHint(token.assetId)} · {token.decimals} decimals
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}
