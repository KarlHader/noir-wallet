import { detectInjectedProvider } from '../detect-provider'
import type { DetectPearlProviderOptions, PearlProvider } from './types'

type NoirWalletWindow = Window & {
  noirwallet?: {
    pearl?: unknown
  }
}

function isPearlProvider(value: unknown): value is PearlProvider {
  if (!value || typeof value !== 'object') return false
  const provider = value as Partial<PearlProvider>
  return (
    typeof provider.request === 'function' &&
    typeof provider.connect === 'function' &&
    typeof provider.getAccounts === 'function' &&
    typeof provider.getNetwork === 'function' &&
    typeof provider.getChain === 'function' &&
    typeof provider.getPublicKey === 'function' &&
    typeof provider.getBalance === 'function' &&
    typeof provider.sendPearl === 'function' &&
    typeof provider.signMessage === 'function' &&
    typeof provider.signPsbt === 'function' &&
    typeof provider.signPsbts === 'function' &&
    typeof provider.pushPsbt === 'function' &&
    typeof provider.pushTx === 'function' &&
    typeof provider.disconnect === 'function'
  )
}

export function getPearlProvider(): PearlProvider | null {
  if (typeof window === 'undefined') return null
  const candidate = (window as NoirWalletWindow).noirwallet?.pearl
  return isPearlProvider(candidate) ? candidate : null
}

export async function detectPearlProvider(
  options: DetectPearlProviderOptions = {}
): Promise<PearlProvider> {
  return detectInjectedProvider({
    label: 'Pearl',
    getProvider: getPearlProvider,
    options
  })
}
