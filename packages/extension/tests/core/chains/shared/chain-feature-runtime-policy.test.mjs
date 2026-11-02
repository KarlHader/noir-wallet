import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ALL_CHAIN_FEATURE_FLAGS,
  parseEnabledChainFeatureFlags
} from '../../../../src/config/multichain-feature-flags.ts'

import {
  resolveBitcoinFeatureRuntimePolicy,
  resolveEvmFeatureRuntimePolicy,
  resolveNearFeatureRuntimePolicy,
  resolveSolanaFeatureRuntimePolicy
} from '../../../../src/core/chains/feature-runtime-policy.ts'

describe('Chain feature runtime policy', () => {
  it('defaults to EVM and Zcash while keeping deferred chain operations closed', () => {
    const enabled = parseEnabledChainFeatureFlags(undefined, ALL_CHAIN_FEATURE_FLAGS)
    assert.deepEqual(enabled, ['chain.zcash', 'chain.evm'])
    assert.equal(resolveEvmFeatureRuntimePolicy(enabled).newOperationsEnabled, true)
    assert.equal(resolveBitcoinFeatureRuntimePolicy(enabled).newOperationsEnabled, false)
    assert.equal(resolveBitcoinFeatureRuntimePolicy(enabled).transactionRecoveryEnabled, true)
    assert.equal(resolveSolanaFeatureRuntimePolicy(enabled).newOperationsEnabled, false)
    assert.equal(resolveNearFeatureRuntimePolicy(enabled).newOperationsEnabled, false)
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

  it('enables Solana operations when the release flag is present', () => {
    assert.deepEqual(resolveSolanaFeatureRuntimePolicy(['chain.zcash']), {
      newOperationsEnabled: false
    })
    assert.deepEqual(resolveSolanaFeatureRuntimePolicy(['chain.zcash', 'chain.solana']), {
      newOperationsEnabled: true
    })
  })

  it('enables NEAR operations when the release flag is present', () => {
    assert.deepEqual(resolveNearFeatureRuntimePolicy(['chain.zcash']), {
      newOperationsEnabled: false
    })
    assert.deepEqual(resolveNearFeatureRuntimePolicy(['chain.zcash', 'chain.near']), {
      newOperationsEnabled: true
    })
  })
})
