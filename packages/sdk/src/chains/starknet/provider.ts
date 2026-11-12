import type { DetectStarknetProviderOptions, StarknetProvider } from './types'
import { detectInjectedProvider } from '../detect-provider'

type NoirWalletWindow = Window & { noirwallet?: { starknet?: unknown } }

function isStarknetProvider(value: unknown): value is StarknetProvider {
  if (!value || typeof value !== 'object') return false
  const provider = value as Partial<StarknetProvider>
  return (
    provider.id === 'noirwallet' &&
    typeof provider.request === 'function' &&
    typeof provider.on === 'function' &&
    typeof provider.off === 'function'
  )
}

export function getStarknetProvider(): StarknetProvider | null {
  if (typeof window === 'undefined') return null
  const candidate = (window as NoirWalletWindow).noirwallet?.starknet
  return isStarknetProvider(candidate) ? candidate : null
}

export async function detectStarknetProvider(
  options: DetectStarknetProviderOptions = {}
): Promise<StarknetProvider> {
  return detectInjectedProvider({
    label: 'Starknet',
    getProvider: getStarknetProvider,
    options
  })
}
