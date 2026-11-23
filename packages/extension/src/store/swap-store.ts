import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createChromeStorageAdapter } from '@/lib/chrome-storage-adapter'
import type { AddressType } from '@/types'
import type { RheaSwapQuoteMode } from '@/core/services/rhea-swap'

const MAX_RECENT_ADDRESSES = 5
export const SWAP_PREFERENCES_STORAGE_KEY = 'swap_preferences'
export type SwapQuoteSettings = Pick<SwapPreferences, 'slippage' | 'quoteMode'>

export interface SavedSwapTokenSelection {
  readonly tokenInId: string | null
  readonly tokenOutId: string | null
  readonly tokenInSymbol?: string
  readonly tokenOutSymbol?: string
}

type SwapTokenChoice = Readonly<{ assetId: string; symbol: string }>
type PersistedSwapPreferences = Pick<
  SwapPreferences,
  | 'slippage'
  | 'quoteMode'
  | 'addressType'
  | 'recentRefundAddresses'
  | 'recentRecipientAddresses'
  | 'tokenSelections'
>

interface SwapPreferences {
  slippage: number
  quoteMode: RheaSwapQuoteMode
  addressType: AddressType
  recentRefundAddresses: Record<string, string[]>
  recentRecipientAddresses: Record<string, string[]>
  tokenSelections: Record<string, SavedSwapTokenSelection>

  setQuoteSettings: (settings: SwapQuoteSettings) => void
  setAddressType: (type: AddressType) => void
  addRecentRefundAddress: (chain: string, address: string) => void
  addRecentRecipientAddress: (chain: string, address: string) => void
  getRecentRefundAddresses: (chain: string) => string[]
  getRecentRecipientAddresses: (chain: string) => string[]
  setSavedTokenSelection: (scope: string, selection: SavedSwapTokenSelection) => void
  setSavedSwapToken: (scope: string, side: 'in' | 'out', token: SwapTokenChoice) => void
}

function addToRecent(
  record: Record<string, string[]>,
  chain: string,
  address: string
): Record<string, string[]> {
  const list = record[chain] || []
  const filtered = list.filter(a => a !== address)
  return {
    ...record,
    [chain]: [address, ...filtered].slice(0, MAX_RECENT_ADDRESSES)
  }
}

export const useSwapPreferences = create<SwapPreferences>()(
  persist(
    (set, get) => ({
      slippage: 1,
      quoteMode: 'best-price',
      addressType: 'shielded',
      recentRefundAddresses: {},
      recentRecipientAddresses: {},
      tokenSelections: {},

      setQuoteSettings: ({ slippage, quoteMode }) => set({ slippage, quoteMode }),
      setAddressType: type => set({ addressType: type }),
      setSavedTokenSelection: (scope, selection) => {
        if (!scope) return
        set(state => ({
          tokenSelections: { ...state.tokenSelections, [scope]: selection }
        }))
      },
      setSavedSwapToken: (scope, side, token) => {
        if (!scope) return
        set(state => {
          const previous = state.tokenSelections[scope] ?? { tokenInId: null, tokenOutId: null }
          const selection =
            side === 'in'
              ? { ...previous, tokenInId: token.assetId, tokenInSymbol: token.symbol }
              : { ...previous, tokenOutId: token.assetId, tokenOutSymbol: token.symbol }
          return {
            tokenSelections: {
              ...state.tokenSelections,
              [scope]: selection
            }
          }
        })
      },

      addRecentRefundAddress: (chain, address) => {
        if (!address.trim()) return
        set({ recentRefundAddresses: addToRecent(get().recentRefundAddresses, chain, address) })
      },

      addRecentRecipientAddress: (chain, address) => {
        if (!address.trim()) return
        set({
          recentRecipientAddresses: addToRecent(get().recentRecipientAddresses, chain, address)
        })
      },

      getRecentRefundAddresses: chain => get().recentRefundAddresses[chain] || [],
      getRecentRecipientAddresses: chain => get().recentRecipientAddresses[chain] || []
    }),
    {
      name: SWAP_PREFERENCES_STORAGE_KEY,
      storage: createChromeStorageAdapter('local') as any,
      version: 1,
      migrate: persisted => {
        const previous = persisted as PersistedSwapPreferences
        const selections = previous.tokenSelections ?? {}
        const tokenSelections = Object.fromEntries(
          Object.entries(selections).filter(([scope]) => !/:(main|private|shield)$/.test(scope))
        )
        for (const mode of ['main', 'private', 'shield']) {
          for (const [scope, selection] of Object.entries(selections)) {
            if (!scope.endsWith(`:${mode}`)) continue
            const shared = scope.slice(0, -(mode.length + 1))
            tokenSelections[shared] ??= selection
          }
        }
        return { ...previous, tokenSelections }
      },
      partialize: (state: SwapPreferences) => ({
        slippage: state.slippage,
        quoteMode: state.quoteMode,
        addressType: state.addressType,
        recentRefundAddresses: state.recentRefundAddresses,
        recentRecipientAddresses: state.recentRecipientAddresses,
        tokenSelections: state.tokenSelections
      })
    }
  )
)
