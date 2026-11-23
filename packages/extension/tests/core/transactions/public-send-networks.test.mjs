import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  EVM_CHAIN_FEATURE_FLAG,
  NEAR_CHAIN_FEATURE_FLAG,
  SOLANA_CHAIN_FEATURE_FLAG,
  ZCASH_CHAIN_FEATURE_FLAG
} from '../../../src/config/multichain-feature-flags.ts'
import {
  buildPublicSendDestinationNetworks,
  resolvePublicSendNetworkAction
} from '../../../src/popup/services/public-send-networks.ts'

const flags = [
  ZCASH_CHAIN_FEATURE_FLAG,
  EVM_CHAIN_FEATURE_FLAG,
  SOLANA_CHAIN_FEATURE_FLAG,
  NEAR_CHAIN_FEATURE_FLAG
]
const flagsWithoutNear = flags.filter(flag => flag !== NEAR_CHAIN_FEATURE_FLAG)
const ethereum = chain('eip155:1', 'evm', 'Ethereum')
const base = chain('eip155:8453', 'evm', 'Base')
const solana = chain('solana:mainnet', 'solana', 'Solana')
const near = chain('near:testnet', 'near', 'NEAR Testnet')
const zcash = { chainId: 'zcash:mainnet', name: 'Zcash', icon: 'zcash' }

function chain(id, family, displayName, transactionAvailable = true) {
  return { id, family, displayName, transactionAvailable }
}

function option(networks, chainId) {
  return networks.find(item => item.chainId === chainId)
}

describe('public Send network switching', () => {
  it('offers NEAR as a chain switch from EVM and keeps bridge networks cross-chain', () => {
    const networks = buildPublicSendDestinationNetworks({
      source: ethereum,
      accountChains: [ethereum, base, solana, near],
      crossChainChains: [base, solana, near],
      zcash,
      enabledFlags: flags
    })

    assert.equal(option(networks, near.id)?.switchesAsset, true)
    assert.equal(option(networks, near.id)?.chainId, 'near:testnet')
    assert.equal(option(networks, base.id)?.switchesAsset, false)
    assert.equal(option(networks, solana.id)?.switchesAsset, false)
    assert.equal(option(networks, zcash.chainId)?.switchesAsset, true)
    assert.equal(
      resolvePublicSendNetworkAction({
        destinationChainId: near.id,
        sourceChainId: ethereum.id,
        options: networks,
        zcashChainId: zcash.chainId,
        crossChainChainIds: [base.id, solana.id, near.id]
      }),
      'native'
    )
    assert.equal(
      resolvePublicSendNetworkAction({
        destinationChainId: base.id,
        sourceChainId: ethereum.id,
        options: networks,
        zcashChainId: zcash.chainId,
        crossChainChainIds: [base.id, solana.id]
      }),
      'cross-chain'
    )
    assert.equal(
      resolvePublicSendNetworkAction({
        destinationChainId: zcash.chainId,
        sourceChainId: ethereum.id,
        options: networks,
        zcashChainId: zcash.chainId,
        crossChainChainIds: [base.id]
      }),
      'zcash'
    )
  })

  it('switches away from NEAR without starting a cross-chain send', () => {
    const networks = buildPublicSendDestinationNetworks({
      source: near,
      accountChains: [ethereum, solana, near],
      crossChainChains: [ethereum, solana],
      zcash,
      enabledFlags: flags
    })

    assert.equal(option(networks, near.id)?.switchesAsset, false)
    assert.equal(option(networks, ethereum.id)?.switchesAsset, true)
    assert.equal(option(networks, solana.id)?.switchesAsset, true)
    assert.equal(option(networks, zcash.chainId)?.switchesAsset, true)
    assert.equal(networks.length > 1, true)
    assert.equal(
      resolvePublicSendNetworkAction({
        destinationChainId: ethereum.id,
        sourceChainId: near.id,
        options: networks,
        zcashChainId: zcash.chainId,
        crossChainChainIds: [ethereum.id, solana.id]
      }),
      'native'
    )
    assert.equal(
      resolvePublicSendNetworkAction({
        destinationChainId: near.id,
        sourceChainId: near.id,
        options: networks,
        zcashChainId: zcash.chainId,
        crossChainChainIds: [ethereum.id]
      }),
      'ignore'
    )
  })

  it('hides NEAR when the chain flag is off or the network cannot send', () => {
    const hiddenByFlag = buildPublicSendDestinationNetworks({
      source: ethereum,
      accountChains: [ethereum, near],
      crossChainChains: [],
      zcash: null,
      enabledFlags: flagsWithoutNear
    })
    const hiddenByCapability = buildPublicSendDestinationNetworks({
      source: ethereum,
      accountChains: [ethereum, chain(near.id, 'near', near.displayName, false)],
      crossChainChains: [],
      zcash: null,
      enabledFlags: flags
    })
    const zcashNetworks = buildPublicSendDestinationNetworks({
      source: chain(zcash.chainId, 'zcash', zcash.name),
      accountChains: [ethereum, solana, near],
      crossChainChains: [ethereum],
      zcash,
      enabledFlags: flags
    })

    assert.equal(option(hiddenByFlag, near.id), undefined)
    assert.equal(option(hiddenByCapability, near.id), undefined)
    assert.equal(option(zcashNetworks, near.id)?.switchesAsset, true)
    assert.equal(option(zcashNetworks, ethereum.id)?.switchesAsset, true)
    assert.equal(option(zcashNetworks, zcash.chainId)?.icon, 'zcash')
    assert.equal(
      resolvePublicSendNetworkAction({
        destinationChainId: ethereum.id,
        sourceChainId: zcash.chainId,
        options: zcashNetworks,
        zcashChainId: zcash.chainId,
        crossChainChainIds: [ethereum.id]
      }),
      'native'
    )
  })
})
