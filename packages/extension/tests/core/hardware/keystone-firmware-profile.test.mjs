import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  KEYSTONE_CHAIN_FIRMWARE_PROFILES,
  KEYSTONE_PRODUCT_CHAINS_BY_PROFILE,
  resolveKeystoneSetupPlan
} from '../../../src/lib/keystone/firmware-profile.ts'

test.describe('Keystone chain-first firmware planning', () => {
  test('maps Zcash selections to Cypherpunk firmware', () => {
    assert.deepEqual(resolveKeystoneSetupPlan(['zcash']), {
      status: 'compatible',
      requestedChains: ['zcash'],
      firmwareProfile: 'cypherpunk',
      firmwareChains: ['zcash', 'bitcoin']
    })
    assert.deepEqual(resolveKeystoneSetupPlan(['zcash', 'bitcoin']), {
      status: 'compatible',
      requestedChains: ['zcash', 'bitcoin'],
      firmwareProfile: 'cypherpunk',
      firmwareChains: ['zcash', 'bitcoin']
    })
  })

  test('maps EVM selections to Multi-Coin firmware', () => {
    assert.deepEqual(resolveKeystoneSetupPlan(['evm', 'bitcoin', 'solana', 'tron', 'near']), {
      status: 'compatible',
      requestedChains: ['evm', 'bitcoin', 'solana', 'tron', 'near'],
      firmwareProfile: 'multi-coin',
      firmwareChains: ['evm', 'bitcoin', 'solana', 'tron', 'near']
    })
  })

  test('maps every non-Zcash product chain to Multi-Coin firmware', () => {
    for (const chain of ['evm', 'solana', 'tron', 'near']) {
      assert.equal(resolveKeystoneSetupPlan([chain]).firmwareProfile, 'multi-coin')
    }
  })

  test('keeps every supported product chain assigned to an explicit firmware profile', () => {
    assert.deepEqual(Object.keys(KEYSTONE_CHAIN_FIRMWARE_PROFILES).sort(), [
      'bitcoin',
      'evm',
      'near',
      'solana',
      'tron',
      'zcash'
    ])
    for (const [profile, chains] of Object.entries(KEYSTONE_PRODUCT_CHAINS_BY_PROFILE)) {
      for (const chain of chains) {
        assert.ok(
          KEYSTONE_CHAIN_FIRMWARE_PROFILES[chain].includes(profile),
          `${chain} is missing the ${profile} firmware mapping`
        )
      }
    }
  })

  test('maps a Bitcoin-only selection to Bitcoin-Only firmware', () => {
    assert.deepEqual(resolveKeystoneSetupPlan(['bitcoin', 'bitcoin']), {
      status: 'compatible',
      requestedChains: ['bitcoin'],
      firmwareProfile: 'bitcoin-only',
      firmwareChains: ['bitcoin']
    })
  })

  test('rejects a Zcash and EVM combination on one firmware profile', () => {
    assert.deepEqual(resolveKeystoneSetupPlan(['zcash', 'bitcoin', 'evm']), {
      status: 'conflict',
      requestedChains: ['zcash', 'bitcoin', 'evm'],
      conflictingChains: ['zcash', 'evm']
    })

    assert.deepEqual(resolveKeystoneSetupPlan(['zcash', 'solana']), {
      status: 'conflict',
      requestedChains: ['zcash', 'solana'],
      conflictingChains: ['zcash', 'solana']
    })
  })

  test('requires at least one known network', () => {
    assert.deepEqual(resolveKeystoneSetupPlan([]), {
      status: 'empty',
      requestedChains: []
    })
    assert.throws(
      () => resolveKeystoneSetupPlan(['monero']),
      /Unsupported Keystone chain selection: monero/
    )
  })
})
