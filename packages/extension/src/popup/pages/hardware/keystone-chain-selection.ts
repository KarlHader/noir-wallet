import type { ChainFeatureFlagValue } from '@/config/multichain-feature-flags'
import { productChainForPath } from '@/core/wallet/hardware-wallet-data'
import {
  KEYSTONE_PRODUCT_CHAINS_BY_PROFILE,
  type KeystoneChainSelection,
  type KeystoneMultiAccountsPayload
} from '@/lib/keystone'
import { isSelectableChainFamily } from '@/popup/services/chain-selection-availability'
import { MIN_KEYSTONE_ZCASH_FIRMWARE_VERSION } from '@/lib/zcash-hardware-compatibility'

export interface KeystoneNetworkBundle {
  readonly id: 'zcash' | 'multi-chain' | 'bitcoin-only'
  readonly name: string
  readonly firmwareDescription: string
  readonly requestedNetworks: readonly KeystoneChainSelection[]
  readonly comingSoonNetworks: readonly KeystoneChainSelection[]
  readonly disabled: boolean
}

export function buildKeystoneNetworkBundles(
  enabledFlags: readonly ChainFeatureFlagValue[]
): readonly KeystoneNetworkBundle[] {
  const enabledNetworks = (networks: readonly KeystoneChainSelection[]) =>
    networks.filter(network => isSelectableChainFamily(network, enabledFlags))
  const comingSoonNetworks = (networks: readonly KeystoneChainSelection[]) =>
    networks.filter(
      network =>
        (network === 'bitcoin' || network === 'solana' || network === 'near') &&
        !isSelectableChainFamily(network, enabledFlags)
    )
  const multiCoin = enabledNetworks(KEYSTONE_PRODUCT_CHAINS_BY_PROFILE['multi-coin'])
  const cypherpunk = enabledNetworks(KEYSTONE_PRODUCT_CHAINS_BY_PROFILE.cypherpunk)
  const bitcoinOnly = enabledNetworks(KEYSTONE_PRODUCT_CHAINS_BY_PROFILE['bitcoin-only'])
  return Object.freeze([
    {
      id: 'multi-chain',
      name: multiCoin.length === 1 && multiCoin[0] === 'evm' ? 'EVM networks' : 'Multi-chain',
      firmwareDescription: 'Multi-Coin firmware',
      requestedNetworks: multiCoin,
      comingSoonNetworks: comingSoonNetworks(KEYSTONE_PRODUCT_CHAINS_BY_PROFILE['multi-coin']),
      disabled: multiCoin.length === 0
    },
    {
      id: 'zcash',
      name: cypherpunk.includes('bitcoin') ? 'Zcash + BTC' : 'Zcash',
      firmwareDescription: `Cypherpunk firmware ${MIN_KEYSTONE_ZCASH_FIRMWARE_VERSION}+`,
      requestedNetworks: cypherpunk,
      comingSoonNetworks: comingSoonNetworks(KEYSTONE_PRODUCT_CHAINS_BY_PROFILE.cypherpunk),
      disabled: cypherpunk.length === 0
    },
    {
      id: 'bitcoin-only',
      name: 'Bitcoin only',
      firmwareDescription: 'Bitcoin-Only firmware',
      requestedNetworks: bitcoinOnly,
      comingSoonNetworks: comingSoonNetworks(KEYSTONE_PRODUCT_CHAINS_BY_PROFILE['bitcoin-only']),
      disabled: bitcoinOnly.length === 0
    }
  ])
}

export function filterKeystoneMultiAccountsPayload(
  payload: KeystoneMultiAccountsPayload,
  requestedNetworks: readonly KeystoneChainSelection[]
): KeystoneMultiAccountsPayload {
  const requested = new Set(requestedNetworks)
  return Object.freeze({
    ...payload,
    keys: Object.freeze(
      payload.keys.filter(key => {
        const chain = productChainForPath(key.derivationPath)
        return chain !== null && requested.has(chain)
      })
    )
  })
}
