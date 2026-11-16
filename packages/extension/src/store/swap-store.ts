import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createChromeStorageAdapter } from '@/lib/chrome-storage-adapter'
import type { AddressType } from '@/types'
import type { RheaSwapQuoteMode } from '@/core/services/rhea-swap'

const MAX_RECENT_ADDRESSES = 5

export interface SavedSwapTokenSelection {
  readonly tokenInId: string | null
  readonly tokenOutId: string | null
}

interface SwapPreferences {
  slippage: number
  quoteMode: RheaSwapQuoteMode
  addressType: AddressType
  recentRefundAddresses: Record<string, string[]>
  recentRecipientAddresses: Record<string, string[]>
  tokenSelections: Record<string, SavedSwapTokenSelection>

  setSlippage: (slippage: number) => void
  setQuoteMode: (mode: RheaSwapQuoteMode) => void
  setAddressType: (type: AddressType) => void
  addRecentRefundAddress: (chain: string, address: string) => void
  addRecentRecipientAddress: (chain: string, address: string) => void
  getRecentRefundAddresses: (chain: string) => string[]
  getRecentRecipientAddresses: (chain: string) => string[]
  setSavedTokenSelection: (scope: string, selection: SavedSwapTokenSelection) => void
  setSavedTokenInId: (scope: string, id: string | null) => void
  setSavedTokenOutId: (scope: string, id: string | null) => void
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

      setSlippage: slippage => set({ slippage }),
      setQuoteMode: quoteMode => set({ quoteMode }),
      setAddressType: type => set({ addressType: type }),
      setSavedTokenSelection: (scope, selection) => {
        if (!scope) return
        set(state => ({
          tokenSelections: { ...state.tokenSelections, [scope]: selection }
        }))
      },
      setSavedTokenInId: (scope, id) => {
        if (!scope) return
        set(state => ({
          tokenSelections: {
            ...state.tokenSelections,
            [scope]: {
              tokenInId: id,
              tokenOutId: state.tokenSelections[scope]?.tokenOutId ?? null
            }
          }
        }))
      },
      setSavedTokenOutId: (scope, id) => {
        if (!scope) return
        set(state => ({
          tokenSelections: {
            ...state.tokenSelections,
            [scope]: {
              tokenInId: state.tokenSelections[scope]?.tokenInId ?? null,
              tokenOutId: id
            }
          }
        }))
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
      name: 'swap_preferences',
      storage: createChromeStorageAdapter('local') as any,
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
