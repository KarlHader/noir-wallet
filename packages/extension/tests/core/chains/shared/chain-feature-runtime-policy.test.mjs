import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ALL_CHAIN_FEATURE_FLAGS,
  parseEnabledChainFeatureFlags
} from '../../../../src/config/multichain-feature-flags.ts'

import {
  isNewWalletFamilyEnabled,
  resolveBitcoinFeatureRuntimePolicy,
  resolveDashFeatureRuntimePolicy,
  resolveEvmFeatureRuntimePolicy,
  resolveNearFeatureRuntimePolicy,
  resolvePearlFeatureRuntimePolicy,
  resolveQuantusFeatureRuntimePolicy,
  resolveSolanaFeatureRuntimePolicy,
  resolveStarknetFeatureRuntimePolicy
} from '../../../../src/core/chains/feature-runtime-policy.ts'

describe('Chain feature runtime policy', () => {
  it('defaults to Zcash, EVM, Pearl, and Quantus while keeping deferred chain operations closed', () => {
    const enabled = parseEnabledChainFeatureFlags(undefined, ALL_CHAIN_FEATURE_FLAGS)
    assert.deepEqual(enabled, ['chain.zcash', 'chain.evm', 'chain.pearl', 'chain.quantus'])
    assert.equal(resolveQuantusFeatureRuntimePolicy(enabled).newOperationsEnabled, true)
    assert.equal(isNewWalletFamilyEnabled('quantus', enabled), true)
    assert.equal(resolveEvmFeatureRuntimePolicy(enabled).newOperationsEnabled, true)
    assert.equal(resolveBitcoinFeatureRuntimePolicy(enabled).newOperationsEnabled, false)
    assert.equal(resolveBitcoinFeatureRuntimePolicy(enabled).transactionRecoveryEnabled, true)
    assert.equal(resolvePearlFeatureRuntimePolicy(enabled).newOperationsEnabled, true)
    assert.equal(resolvePearlFeatureRuntimePolicy(enabled).transactionRecoveryEnabled, true)
    assert.equal(resolveSolanaFeatureRuntimePolicy(enabled).newOperationsEnabled, false)
    assert.equal(resolveNearFeatureRuntimePolicy(enabled).newOperationsEnabled, false)
    assert.equal(resolveDashFeatureRuntimePolicy(enabled).newOperationsEnabled, false)
    assert.equal(isNewWalletFamilyEnabled('dash', enabled), false)
    assert.equal(enabled.includes('chain.dash'), false)
    assert.equal(resolveStarknetFeatureRuntimePolicy(enabled).newOperationsEnabled, false)
    assert.equal(isNewWalletFamilyEnabled('starknet', enabled), false)
    assert.equal(enabled.includes('chain.starknet'), false)
  })

  it('permits an explicit deferred-chain verification profile without changing the default', () => {
    const enabled = parseEnabledChainFeatureFlags(
      'chain.bitcoin,chain.solana,chain.near',
      ALL_CHAIN_FEATURE_FLAGS
    )
    assert.deepEqual(enabled, ['chain.zcash', 'chain.bitcoin', 'chain.solana', 'chain.near'])
    assert.equal(resolveBitcoinFeatureRuntimePolicy(enabled).newOperationsEnabled, true)
    assert.equal(resolveSolanaFeatureRuntimePolicy(enabled).newOperationsEnabled, true)
    assert.equal(resolveNearFeatureRuntimePolicy(enabled).newOperationsEnabled, true)
    assert.equal(resolveEvmFeatureRuntimePolicy(enabled).newOperationsEnabled, false)
  })

  it('disables new EVM operations without stopping persisted transaction recovery', () => {
    assert.deepEqual(resolveEvmFeatureRuntimePolicy(['chain.zcash']), {
      newOperationsEnabled: false,
      transactionRecoveryEnabled: true
    })
  })

  it('enables new EVM operations only when the release flag is present', () => {
    assert.deepEqual(resolveEvmFeatureRuntimePolicy(['chain.zcash', 'chain.evm']), {
      newOperationsEnabled: true,
      transactionRecoveryEnabled: true
    })
  })

  it('keeps Bitcoin recovery enabled while gating new operations independently', () => {
    assert.deepEqual(resolveBitcoinFeatureRuntimePolicy(['chain.zcash']), {
      newOperationsEnabled: false,
      transactionRecoveryEnabled: true
    })
    assert.deepEqual(resolveBitcoinFeatureRuntimePolicy(['chain.zcash', 'chain.bitcoin']), {
      newOperationsEnabled: true,
      transactionRecoveryEnabled: true
    })
  })

  it('keeps Pearl recovery enabled while gating new operations independently', () => {
    assert.deepEqual(resolvePearlFeatureRuntimePolicy(['chain.zcash']), {
      newOperationsEnabled: false,
      transactionRecoveryEnabled: true
    })
    assert.deepEqual(resolvePearlFeatureRuntimePolicy(['chain.zcash', 'chain.pearl']), {
      newOperationsEnabled: true,
      transactionRecoveryEnabled: true
    })
  })

  it('enables Solana operations when the release flag is present', () => {
    assert.deepEqual(resolveSolanaFeatureRuntimePolicy(['chain.zcash']), {
      newOperationsEnabled: false
    })
    assert.deepEqual(resolveSolanaFeatureRuntimePolicy(['chain.zcash', 'chain.solana']), {
      newOperationsEnabled: true
    })
  })

  it('keeps Dash closed unless its own release flag is present', () => {
    assert.deepEqual(resolveDashFeatureRuntimePolicy(['chain.zcash']), {
      newOperationsEnabled: false
    })
    assert.equal(
      resolveDashFeatureRuntimePolicy(['chain.zcash', 'chain.bitcoin']).newOperationsEnabled,
      false
    )
    assert.deepEqual(resolveDashFeatureRuntimePolicy(['chain.zcash', 'chain.dash']), {
      newOperationsEnabled: true
    })
    assert.equal(isNewWalletFamilyEnabled('dash', ['chain.zcash', 'chain.bitcoin']), false)
    assert.equal(isNewWalletFamilyEnabled('dash', ['chain.zcash', 'chain.dash']), true)
    assert.equal(isNewWalletFamilyEnabled('bitcoin', ['chain.zcash', 'chain.dash']), false)
  })

  it('enables NEAR operations when the release flag is present', () => {
    assert.deepEqual(resolveNearFeatureRuntimePolicy(['chain.zcash']), {
      newOperationsEnabled: false
    })
    assert.deepEqual(resolveNearFeatureRuntimePolicy(['chain.zcash', 'chain.near']), {
      newOperationsEnabled: true
    })
  })

  it('keeps Starknet closed unless its own release flag is present', () => {
    assert.deepEqual(resolveStarknetFeatureRuntimePolicy(['chain.zcash']), {
      newOperationsEnabled: false
    })
    assert.equal(
      resolveStarknetFeatureRuntimePolicy(['chain.zcash', 'chain.near']).newOperationsEnabled,
      false
    )
    assert.deepEqual(resolveStarknetFeatureRuntimePolicy(['chain.zcash', 'chain.starknet']), {
      newOperationsEnabled: true
    })
    assert.equal(isNewWalletFamilyEnabled('starknet', ['chain.zcash', 'chain.near']), false)
    assert.equal(isNewWalletFamilyEnabled('starknet', ['chain.zcash', 'chain.starknet']), true)
  })
})
