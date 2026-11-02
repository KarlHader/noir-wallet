import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { WALLET_CONFIG, type AutoLockMs } from '@/config/wallet'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { getResponseErrorMessage } from '@/lib/errors'
import type { Network } from '@/types'
import { DEFAULT_FEE_TIER, type FeeTier } from '@/config/fee'
import { createWalletSettingsPersistStorage } from '@/lib/wallet-settings-persist-storage'
import { applyLendingSdkEnv } from '@/core/services/lending-sdk-init'
import { setNearRpcUrl } from '@/core/services/lending-service'
import {
  DEFAULT_BLOCK_EXPLORER_PREFERENCES,
  type BlockExplorerChain,
  type BlockExplorerId,
  type BlockExplorerPreferences
} from '@/config/block-explorers'
import { setActiveBlockExplorerPreferences } from '@/lib/block-explorer-preferences'
import {
  DEFAULT_RPC_ENDPOINT_PREFERENCES,
  setActiveRpcEndpointPreferences,
  type RpcEndpointPreferences
} from '@/infrastructure/chains/rpc-endpoints'
import type { RpcEndpointChain, RpcEndpointId } from '@/config/rpc-endpoints'
import {
  SETTINGS_STORAGE_KEY,
  resolvePersistedNetworkChainEndpointSettings
} from '@/lib/wallet-settings-storage'
import {
  DEFAULT_CHAIN_ENDPOINT_SETTINGS,
  setActiveChainEndpointSettings,
  parseChainEndpointSettings,
  type ChainEndpointSettings
} from '@/core/chains/chain-endpoint-settings'

export { SETTINGS_STORAGE_KEY } from '@/lib/wallet-settings-storage'

export const AUTO_LOCK_OPTIONS = WALLET_CONFIG.SECURITY.AUTO_LOCK.OPTIONS

let settingsHydrationPromise: Promise<void> | null = null

function parsePortfolioChainSelectionByAccount(
  value: unknown
): Readonly<Record<string, readonly string[]>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .flatMap(([scopeKey, chainIds]) => {
        if (
          scopeKey.length === 0 ||
          scopeKey.length > 512 ||
          !Array.isArray(chainIds) ||
          chainIds.length > 64
        ) {
          return []
        }
        const parsed = [
          ...new Set(
            chainIds.filter(
              (chainId): chainId is string =>
                typeof chainId === 'string' && chainId.length > 0 && chainId.length <= 128
            )
          )
        ]
        return parsed.length === chainIds.length ? [[scopeKey, Object.freeze(parsed)]] : []
      })
      .slice(0, 64)
  )
}

function parseLedgerSigningTransportByWallet(
  value: unknown
): Readonly<Record<string, 'usb' | 'bluetooth'>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([walletId, transport]) =>
          walletId.length > 0 &&
          walletId.length <= 128 &&
          (transport === 'usb' || transport === 'bluetooth')
      )
      .slice(0, 64)
  )
}

function ensureSettingsStoreHydrated(): Promise<void> {
  if (useSettingsStore.persist.hasHydrated()) return Promise.resolve()
  if (!settingsHydrationPromise) {
    const operation = Promise.resolve(useSettingsStore.persist.rehydrate()).then(
      () => {
        settingsHydrationPromise = null
      },
      (error: unknown) => {
        settingsHydrationPromise = null
        throw error
      }
    )
    settingsHydrationPromise = operation
    return operation
  }
  return settingsHydrationPromise
}

let sidePanelModeRevision = 0
let sidePanelModeLoadSequence = 0

interface SettingsStore {
  networkMode: 'mainnet' | 'testnet'
  chainEndpointSettingsByNetwork: Partial<Record<Network, ChainEndpointSettings>>
  autoLockMs: AutoLockMs
  nearRpcUrl: string
  blockExplorerPreferences: BlockExplorerPreferences
  rpcEndpointPreferences: RpcEndpointPreferences
  chainEndpointSettings: ChainEndpointSettings
  zeroIndexerEnabled: boolean
  feeTier: FeeTier
  balancesHidden: boolean
  portfolioViewMode: 'assets' | 'chains'
  portfolioChainSelectionByAccount: Readonly<Record<string, readonly string[]>>
  ledgerSigningTransportByWallet: Readonly<Record<string, 'usb' | 'bluetooth'>>
  sidePanelMode: boolean
  isSidePanelModeLoaded: boolean
  isLoaded: boolean
  setAutoLockMs: (ms: AutoLockMs) => void
  setNearRpcUrl: (url: string) => void
  setBlockExplorerPreference: (chain: BlockExplorerChain, explorerId: BlockExplorerId) => void
  setRpcEndpointPreference: (chain: RpcEndpointChain, endpointId: RpcEndpointId) => void
  setChainEndpointSettings: (settings: ChainEndpointSettings) => void
  setFeeTier: (tier: FeeTier) => void
  setBalancesHidden: (hidden: boolean) => void
  setPortfolioViewMode: (mode: 'assets' | 'chains') => void
  setPortfolioChainSelection: (scopeKey: string, chainIds: readonly string[] | null) => void
  setLedgerSigningTransport: (walletId: string, transport: 'usb' | 'bluetooth') => void
  setSidePanelMode: (enabled: boolean) => Promise<void>
  syncSidePanelMode: (enabled: boolean) => void
  loadSidePanelMode: () => Promise<void>
  loadSettings: () => Promise<void>
}
export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set, get) => ({
      autoLockMs: WALLET_CONFIG.SECURITY.AUTO_LOCK.DEFAULT_MS,
      networkMode: DEFAULT_NETWORK,
      chainEndpointSettingsByNetwork: {},
      nearRpcUrl: '',
      blockExplorerPreferences: DEFAULT_BLOCK_EXPLORER_PREFERENCES,
      rpcEndpointPreferences: DEFAULT_RPC_ENDPOINT_PREFERENCES,
      chainEndpointSettings: DEFAULT_CHAIN_ENDPOINT_SETTINGS,
      zeroIndexerEnabled: true,
      feeTier: DEFAULT_FEE_TIER,
      balancesHidden: false,
      portfolioViewMode: 'assets',
      portfolioChainSelectionByAccount: {},
      ledgerSigningTransportByWallet: {},
      sidePanelMode: false,
      isSidePanelModeLoaded: false,
      isLoaded: false,

      setAutoLockMs: ms => {
        set({ autoLockMs: ms })
      },

      setNearRpcUrl: url => {
        set({ nearRpcUrl: url })
        if (url) {
          setNearRpcUrl(url)
        }
      },

      setFeeTier: tier => {
        set({ feeTier: tier })
      },

      setBalancesHidden: hidden => {
        set({ balancesHidden: hidden })
      },

      setPortfolioViewMode: mode => {
        set({ portfolioViewMode: mode })
      },

      setPortfolioChainSelection: (scopeKey, chainIds) => {
        set(state => {
          const next = { ...state.portfolioChainSelectionByAccount }
          if (chainIds === null) delete next[scopeKey]
          else next[scopeKey] = Object.freeze([...new Set(chainIds)])
          return { portfolioChainSelectionByAccount: next }
        })
      },

      setLedgerSigningTransport: (walletId, transport) => {
        if (!walletId || walletId.length > 128) return
        set(state => ({
          ledgerSigningTransportByWallet: {
            ...state.ledgerSigningTransportByWallet,
            [walletId]: transport
          }
        }))
      },

      setSidePanelMode: async enabled => {
        const revision = ++sidePanelModeRevision
        const response = await chrome.runtime.sendMessage({
          type: 'SET_EXTENSION_DISPLAY_MODE',
          sidePanelMode: enabled
        })
        if (!response?.success) {
          throw new Error(
            getResponseErrorMessage(response) || 'Failed to change wallet display mode'
          )
        }
        if (typeof response.sidePanelMode !== 'boolean') {
          throw new Error('Background returned an invalid wallet display mode')
        }
        if (revision === sidePanelModeRevision)
          set({ sidePanelMode: response.sidePanelMode, isSidePanelModeLoaded: true })
      },

      syncSidePanelMode: enabled => {
        sidePanelModeRevision += 1
        set({ sidePanelMode: enabled, isSidePanelModeLoaded: true })
      },

      loadSidePanelMode: async () => {
        const revision = sidePanelModeRevision
        const sequence = ++sidePanelModeLoadSequence
        const response = await chrome.runtime.sendMessage({
          type: 'GET_EXTENSION_DISPLAY_MODE'
        })
        if (!response?.success || typeof response.sidePanelMode !== 'boolean') {
          throw new Error(getResponseErrorMessage(response) || 'Failed to read wallet display mode')
        }
        if (revision === sidePanelModeRevision && sequence === sidePanelModeLoadSequence)
          set({ sidePanelMode: response.sidePanelMode, isSidePanelModeLoaded: true })
      },

      setBlockExplorerPreference: (chain, explorerId) => {
        const blockExplorerPreferences = {
          ...get().blockExplorerPreferences,
          [chain]: explorerId
        }
        set({ blockExplorerPreferences })
        setActiveBlockExplorerPreferences(blockExplorerPreferences)
      },

      setRpcEndpointPreference: (chain, endpointId) => {
        const rpcEndpointPreferences = {
          ...get().rpcEndpointPreferences,
          [chain]: endpointId
        }
        set({ rpcEndpointPreferences })
        setActiveRpcEndpointPreferences(rpcEndpointPreferences)
      },

      setChainEndpointSettings: settings => {
        const parsed = setActiveChainEndpointSettings(settings)
        set(state => ({
          chainEndpointSettings: parsed,
          chainEndpointSettingsByNetwork: {
            ...state.chainEndpointSettingsByNetwork,
            [DEFAULT_NETWORK]: parsed
          }
        }))
      },

      loadSettings: async () => {
        await ensureSettingsStoreHydrated()
        if (get().isLoaded) return
        const {
          nearRpcUrl,
          blockExplorerPreferences,
          rpcEndpointPreferences,
          chainEndpointSettings
        } = get()
        if (nearRpcUrl) {
          setNearRpcUrl(nearRpcUrl)
        }
        applyLendingSdkEnv('prd')
        setActiveBlockExplorerPreferences(blockExplorerPreferences)
        setActiveRpcEndpointPreferences(rpcEndpointPreferences)
        setActiveChainEndpointSettings(chainEndpointSettings)
        try {
          const response = await chrome.runtime.sendMessage({ type: 'GET_CHAIN_ENDPOINT_SETTINGS' })
          if (response?.result !== undefined) {
            const authoritative = parseChainEndpointSettings(response.result)
            setActiveChainEndpointSettings(authoritative)
            if (JSON.stringify(authoritative) !== JSON.stringify(chainEndpointSettings)) {
              set(state => ({
                chainEndpointSettings: authoritative,
                chainEndpointSettingsByNetwork: {
                  ...state.chainEndpointSettingsByNetwork,
                  [DEFAULT_NETWORK]: authoritative
                }
              }))
            }
          }
        } catch {
          // Persisted local settings remain available if Background is restarting.
        }
        set({ networkMode: DEFAULT_NETWORK, isLoaded: true })
      }
    }),
    {
      name: SETTINGS_STORAGE_KEY,
      storage: createWalletSettingsPersistStorage<Partial<SettingsStore>>(),
      merge: (persisted, current) => {
        const value =
          persisted && typeof persisted === 'object' && !Array.isArray(persisted)
            ? (persisted as Partial<SettingsStore>)
            : {}
        const chainEndpointSettings = parseChainEndpointSettings(
          resolvePersistedNetworkChainEndpointSettings(value, DEFAULT_NETWORK)
        )
        const persistedByNetwork = value.chainEndpointSettingsByNetwork
        const chainEndpointSettingsByNetwork =
          persistedByNetwork &&
          typeof persistedByNetwork === 'object' &&
          !Array.isArray(persistedByNetwork)
            ? Object.fromEntries(
                Object.entries(persistedByNetwork).flatMap(([network, settings]) =>
                  network === 'mainnet' || network === 'testnet'
                    ? [[network, parseChainEndpointSettings(settings)]]
                    : []
                )
              )
            : { [DEFAULT_NETWORK]: chainEndpointSettings }
        return {
          ...current,
          ...value,
          zeroIndexerEnabled: value.zeroIndexerEnabled !== false,
          balancesHidden:
            typeof value.balancesHidden === 'boolean'
              ? value.balancesHidden
              : current.balancesHidden,
          portfolioViewMode:
            value.portfolioViewMode === 'assets' || value.portfolioViewMode === 'chains'
              ? value.portfolioViewMode
              : current.portfolioViewMode,
          portfolioChainSelectionByAccount: parsePortfolioChainSelectionByAccount(
            value.portfolioChainSelectionByAccount
          ),
          ledgerSigningTransportByWallet: parseLedgerSigningTransportByWallet(
            value.ledgerSigningTransportByWallet
          ),
          sidePanelMode: current.sidePanelMode,
          isSidePanelModeLoaded: current.isSidePanelModeLoaded,
          chainEndpointSettingsByNetwork,
          chainEndpointSettings
        }
      },
      onRehydrateStorage: () => state => {
        setActiveBlockExplorerPreferences(state?.blockExplorerPreferences)
        setActiveRpcEndpointPreferences(state?.rpcEndpointPreferences)
        setActiveChainEndpointSettings(state?.chainEndpointSettings)
      },
      partialize: state => ({
        networkMode: state.networkMode,
        chainEndpointSettingsByNetwork: state.chainEndpointSettingsByNetwork,
        autoLockMs: state.autoLockMs,
        nearRpcUrl: state.nearRpcUrl,
        blockExplorerPreferences: state.blockExplorerPreferences,
        rpcEndpointPreferences: state.rpcEndpointPreferences,
        chainEndpointSettings: state.chainEndpointSettings,
        zeroIndexerEnabled: state.zeroIndexerEnabled,
        feeTier: state.feeTier,
        balancesHidden: state.balancesHidden,
        portfolioViewMode: state.portfolioViewMode,
        portfolioChainSelectionByAccount: state.portfolioChainSelectionByAccount,
        ledgerSigningTransportByWallet: state.ledgerSigningTransportByWallet
      })
    }
  )
)
