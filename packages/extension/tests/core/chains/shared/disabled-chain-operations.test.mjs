import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  areNewHardwareWalletFamiliesEnabled,
  isNewWalletFamilyEnabled
} from '../../../../src/core/chains/feature-runtime-policy.ts'
import { assertDisabledChainEndpointsUnchanged } from '../../../../src/core/chains/disabled-chain-endpoint-policy.ts'
import { BackgroundMultichainSessionDAppHandler } from '../../../../src/background/multichain-session-dapp-handler.ts'

const betaFlags = ['chain.zcash', 'chain.evm']
const allFlags = ['chain.zcash', 'chain.evm', 'chain.bitcoin', 'chain.solana', 'chain.near']

describe('disabled chain operation policy', () => {
  it('closes new private-key and hardware provisioning for deferred chains', () => {
    for (const family of ['bip122', 'bitcoin', 'solana', 'near', 'tron']) {
      assert.equal(isNewWalletFamilyEnabled(family, betaFlags), false)
    }
    assert.equal(isNewWalletFamilyEnabled('eip155', betaFlags), true)
    assert.equal(isNewWalletFamilyEnabled('zcash', betaFlags), true)
    assert.equal(areNewHardwareWalletFamiliesEnabled(['evm', 'bitcoin'], betaFlags), false)
    assert.equal(areNewHardwareWalletFamiliesEnabled(['zcash', 'evm'], betaFlags), true)
    assert.equal(areNewHardwareWalletFamiliesEnabled([], betaFlags), false)
  })

  it('keeps explicit all-chain verification profiles available', () => {
    for (const family of ['bip122', 'solana', 'near']) {
      assert.equal(isNewWalletFamilyEnabled(family, allFlags), true)
    }
    assert.equal(areNewHardwareWalletFamiliesEnabled(['zcash', 'bitcoin', 'evm'], allFlags), true)
  })

  it('retains disabled-chain endpoint settings while permitting active EVM edits', () => {
    const bitcoin = {
      chainId: 'bip122:000000000019d6689c085ae165831e93',
      rpc: { protocol: 'bitcoin-esplora', label: 'Existing', url: 'https://btc.example' }
    }
    const current = {
      schemaVersion: 1,
      customEvmNetworks: [],
      overrides: [bitcoin],
      savedRpcEndpoints: [bitcoin]
    }
    const evm = {
      chainId: 'eip155:1',
      rpc: { protocol: 'evm-json-rpc', label: 'New', url: 'https://evm.example' }
    }
    const next = { ...current, overrides: [bitcoin, evm] }
    assert.doesNotThrow(() =>
      assertDisabledChainEndpointsUnchanged(current, next, [bitcoin.chainId])
    )
    assert.throws(
      () =>
        assertDisabledChainEndpointsUnchanged(current, { ...next, overrides: [evm] }, [
          bitcoin.chainId
        ]),
      /active endpoint adapter/
    )
    assert.throws(
      () =>
        assertDisabledChainEndpointsUnchanged(current, { ...next, savedRpcEndpoints: [] }, [
          bitcoin.chainId
        ]),
      /active endpoint adapter/
    )
  })

  it('removes Bitcoin from retained CAIP-25 sessions and rejects new Bitcoin scopes', async () => {
    const bitcoinId = 'bip122:000000000019d6689c085ae165831e93'
    let bitcoinAccountReads = 0
    const handler = new BackgroundMultichainSessionDAppHandler({
      network: 'mainnet',
      evmNetworks: [],
      bitcoinEnabled: false,
      manager: {
        getCaip25Session: async () => ({
          scopes: [{ chainId: bitcoinId, methods: ['getAccounts'], notifications: [] }]
        })
      },
      approval: {},
      zcash: {},
      evm: {},
      bitcoin: {
        getSessionAccounts: async () => {
          bitcoinAccountReads += 1
          return ['bc1qexample']
        }
      },
      solana: null,
      near: null,
      dispatch: async () => {
        throw new Error('Disabled chain dispatched')
      }
    })
    const origin = 'https://dapp.example'
    const tab = { title: 'Test', pageUrl: origin }
    const retained = await handler.request({ method: 'wallet_getSession' }, origin, tab)
    assert.deepEqual(Object.keys(retained.scopes), [])
    assert.equal(bitcoinAccountReads, 0)
    await assert.rejects(
      handler.request(
        {
          method: 'wallet_createSession',
          params: { scopes: { [bitcoinId]: { methods: ['getAccounts'], notifications: [] } } }
        },
        origin,
        tab
      ),
      /not supported/
    )
    assert.equal(bitcoinAccountReads, 0)
  })
})
