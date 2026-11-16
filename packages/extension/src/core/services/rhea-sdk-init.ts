import { setCustomNodeUrl, setSdkEnv } from '@rhea-finance/cross-chain-sdk'

export type RheaSdkEnv = 'stg' | 'prd'

export function applyRheaSdkEnv(env: RheaSdkEnv) {
  try {
    setSdkEnv(env)
  } catch {
    // SDK init may fail in Service Worker context
  }
}

export function setNearRpcUrl(url: string): void {
  setCustomNodeUrl(url)
}

// RHEA Intents uses production backends in the released wallet.
applyRheaSdkEnv('prd')
