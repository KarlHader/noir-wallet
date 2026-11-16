/// <reference types="vite/client" />

declare const __APP_VERSION__: string
declare const __BUILD_TIME__: string
declare const __BUILD_CHANNEL__: string
declare const __NETWORK_MODE__: string
declare const __BETA_INVITE_REQUIRED__: boolean
declare const __DEBUG_LOGS__: boolean
declare const __EXTENSION_UPDATES_ENABLED__: boolean
declare const __MULTICHAIN_CONFORMANCE_RPC_ENABLED__: boolean
declare const __EVM_HISTORY_API_ORIGIN__: string
declare const __GA_API_SECRET__: string
declare const __CUSTOM_ANALYTICS_PASSWORD__: string
declare const __RHEA_SWAP_ACCESS_TOKEN__: string
declare const __CONFIDENTIAL_ONE_CLICK_API_URL__: string
declare const __ENABLED_CHAIN_FEATURE_FLAGS__: readonly `chain.${string}`[]

interface ImportMetaEnv {
  /** Optional build-time cap on the WASM Rayon thread pool (perf/low-power builds). */
  readonly VITE_WASM_THREADS?: string
  readonly NOIR_APP_VERSION: string
  readonly NOIR_PROVIDER_ICON_DATA_URL: string
  readonly NOIR_WALLET_RDNS: string
  readonly NOIR_NETWORK_MODE: 'mainnet' | 'testnet'
  readonly NOIR_ENABLED_CHAIN_FEATURE_FLAGS: readonly `chain.${string}`[]
}

declare module '*.svg' {
  const content: string
  export default content
}

declare module '*.svg?react' {
  import { FC, SVGProps } from 'react'
  const content: FC<SVGProps<SVGElement>>
  export default content
}

declare module '*.webp' {
  const content: string
  export default content
}
