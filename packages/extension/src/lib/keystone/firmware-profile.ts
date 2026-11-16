export type KeystoneChainSelection = 'zcash' | 'bitcoin' | 'evm' | 'solana' | 'tron' | 'near'

export type KeystoneFirmwareProfile = 'cypherpunk' | 'multi-coin' | 'bitcoin-only'

export const KEYSTONE_FIRMWARE_LABELS: Readonly<Record<KeystoneFirmwareProfile, string>> =
  Object.freeze({
    cypherpunk: 'Cypherpunk firmware',
    'multi-coin': 'Multi-Coin firmware',
    'bitcoin-only': 'Bitcoin-Only firmware'
  })

export const KEYSTONE_CHAIN_FIRMWARE_PROFILES = Object.freeze({
  zcash: Object.freeze(['cypherpunk'] as const),
  bitcoin: Object.freeze(['multi-coin', 'cypherpunk', 'bitcoin-only'] as const),
  evm: Object.freeze(['multi-coin'] as const),
  solana: Object.freeze(['multi-coin'] as const),
  tron: Object.freeze(['multi-coin'] as const),
  near: Object.freeze(['multi-coin'] as const)
}) satisfies Readonly<Record<KeystoneChainSelection, readonly KeystoneFirmwareProfile[]>>

export const KEYSTONE_PRODUCT_CHAINS_BY_PROFILE = Object.freeze({
  cypherpunk: Object.freeze(['zcash', 'bitcoin'] as const),
  'multi-coin': Object.freeze(['evm', 'bitcoin', 'solana', 'tron', 'near'] as const),
  'bitcoin-only': Object.freeze(['bitcoin'] as const)
}) satisfies Readonly<Record<KeystoneFirmwareProfile, readonly KeystoneChainSelection[]>>

const supportedSelections = new Set<KeystoneChainSelection>(
  Object.keys(KEYSTONE_CHAIN_FIRMWARE_PROFILES) as KeystoneChainSelection[]
)
const multiCoinSelections = new Set<KeystoneChainSelection>(
  KEYSTONE_PRODUCT_CHAINS_BY_PROFILE['multi-coin'].filter(chain => chain !== 'bitcoin')
)

export type KeystoneSetupPlan =
  | Readonly<{
      status: 'empty'
      requestedChains: readonly []
    }>
  | Readonly<{
      status: 'conflict'
      requestedChains: readonly KeystoneChainSelection[]
      conflictingChains: readonly KeystoneChainSelection[]
    }>
  | Readonly<{
      status: 'compatible'
      requestedChains: readonly KeystoneChainSelection[]
      firmwareProfile: KeystoneFirmwareProfile
      firmwareChains: readonly KeystoneChainSelection[]
    }>

/**
 * Maps the networks a user wants to use to the single Keystone firmware profile
 * that can provide them. A device cannot expose Zcash and EVM capabilities from
 * one installed firmware profile.
 */
export function resolveKeystoneSetupPlan(
  requestedChains: readonly KeystoneChainSelection[]
): KeystoneSetupPlan {
  const uniqueChains: KeystoneChainSelection[] = []
  const seen = new Set<KeystoneChainSelection>()

  for (const chain of requestedChains) {
    if (!supportedSelections.has(chain)) {
      throw new Error(`Unsupported Keystone chain selection: ${String(chain)}`)
    }
    if (!seen.has(chain)) {
      seen.add(chain)
      uniqueChains.push(chain)
    }
  }

  const normalizedChains = Object.freeze(uniqueChains)
  if (normalizedChains.length === 0) {
    return Object.freeze({ status: 'empty', requestedChains: Object.freeze([] as const) })
  }

  const selectedMultiCoinChain = uniqueChains.find(chain => multiCoinSelections.has(chain))
  if (seen.has('zcash') && selectedMultiCoinChain) {
    const conflictingChains: readonly KeystoneChainSelection[] = Object.freeze([
      'zcash',
      selectedMultiCoinChain
    ])
    return Object.freeze({
      status: 'conflict',
      requestedChains: normalizedChains,
      conflictingChains
    })
  }

  const firmwareProfile: KeystoneFirmwareProfile = seen.has('zcash')
    ? 'cypherpunk'
    : selectedMultiCoinChain
      ? 'multi-coin'
      : 'bitcoin-only'

  return Object.freeze({
    status: 'compatible',
    requestedChains: normalizedChains,
    firmwareProfile,
    firmwareChains: KEYSTONE_PRODUCT_CHAINS_BY_PROFILE[firmwareProfile]
  })
}
