import { detectInjectedProvider } from '../detect-provider'
import type { DetectQuantusProviderOptions, QuantusProvider } from './types'

type NoirWalletWindow = Window & {
  noirwallet?: {
    quantus?: unknown
  }
}

function isQuantusProvider(value: unknown): value is QuantusProvider {
  if (!value || typeof value !== 'object') return false
  const provider = value as Partial<QuantusProvider>
  return (
    typeof provider.request === 'function' &&
    typeof provider.connect === 'function' &&
    typeof provider.getAccounts === 'function' &&
    typeof provider.getNetwork === 'function' &&
    typeof provider.getChain === 'function' &&
    typeof provider.getPublicKey === 'function' &&
    typeof provider.getBalance === 'function' &&
    typeof provider.sendQuantus === 'function' &&
    typeof provider.signQuantusTransfer === 'function' &&
    typeof provider.broadcastExtrinsic === 'function' &&
    typeof provider.disconnect === 'function'
  )
}

export function getQuantusProvider(): QuantusProvider | null {
  if (typeof window === 'undefined') return null
  const candidate = (window as NoirWalletWindow).noirwallet?.quantus
  return isQuantusProvider(candidate) ? candidate : null
}

export async function detectQuantusProvider(
  options: DetectQuantusProviderOptions = {}
): Promise<QuantusProvider> {
  return detectInjectedProvider({
    label: 'Quantus',
    getProvider: getQuantusProvider,
    options
  })
}
