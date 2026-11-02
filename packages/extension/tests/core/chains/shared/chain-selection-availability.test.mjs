import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ALL_CHAIN_FEATURE_FLAGS,
  DEFAULT_ENABLED_CHAIN_FEATURE_FLAGS
} from '../../../../src/config/multichain-feature-flags.ts'
import {
  deferredChainChoices,
  isSelectableSwapBlockchain,
  selectableChainOptions
} from '../../../../src/popup/services/chain-selection-availability.ts'
import { privateKeyImportFamilyOptions } from '../../../../src/popup/services/private-key-import-options.ts'
import { supportsEvmPrivateExecution } from '../../../../src/core/chains/evm/execution-capability.ts'
import { buildAddTokenNetworks } from '../../../../src/popup/services/add-token-model.ts'
import { buildSendAssetSelectionModel } from '../../../../src/popup/pages/transactions/send-asset-order.ts'
import {
  buildKeystoneNetworkBundles,
  filterKeystoneMultiAccountsPayload
} from '../../../../src/popup/pages/hardware/keystone-chain-selection.ts'

describe('Chain selection availability', () => {
  it('allows Confidential execution for mnemonic and EVM private-key accounts only', () => {
    for (const [source, expected] of [
      [{ kind: 'software' }, true],
      [{ kind: 'private-key', chainFamily: 'eip155' }, true],
      [{ kind: 'private-key', chainFamily: 'bip122' }, false],
      [{ kind: 'private-key', chainFamily: 'solana' }, false],
      [{ kind: 'private-key', chainFamily: 'near' }, false],
      [{ kind: 'hardware' }, false],
      [null, false],
      [undefined, false]
    ]) {
      assert.equal(supportsEvmPrivateExecution(source), expected, JSON.stringify(source))
    }
  })

  it('keeps deferred chains visible without putting them in selectable network IDs', () => {
    const options = [
      { id: 'zcash:mainnet', family: 'zcash' },
      { id: 'eip155:1', family: 'evm' },
      { id: 'bip122:mainnet', family: 'bitcoin' },
      { id: 'solana:mainnet', family: 'solana' },
      { id: 'near:mainnet', family: 'near' }
    ]
    assert.deepEqual(
      selectableChainOptions(options, DEFAULT_ENABLED_CHAIN_FEATURE_FLAGS).map(option => option.id),
      ['zcash:mainnet', 'eip155:1']
    )
    assert.deepEqual(
      deferredChainChoices(DEFAULT_ENABLED_CHAIN_FEATURE_FLAGS).map(option => option.family),
      ['bitcoin', 'solana', 'near']
    )
    assert.deepEqual(selectableChainOptions(options, ALL_CHAIN_FEATURE_FLAGS), options)
    assert.deepEqual(deferredChainChoices(ALL_CHAIN_FEATURE_FLAGS), [])
  })

  it('applies the same release choice to token and private-key import families', () => {
    assert.equal(isSelectableSwapBlockchain('eth', DEFAULT_ENABLED_CHAIN_FEATURE_FLAGS), true)
    assert.equal(isSelectableSwapBlockchain('base', DEFAULT_ENABLED_CHAIN_FEATURE_FLAGS), true)
    assert.equal(isSelectableSwapBlockchain('zec', DEFAULT_ENABLED_CHAIN_FEATURE_FLAGS), true)
    assert.equal(isSelectableSwapBlockchain('btc', DEFAULT_ENABLED_CHAIN_FEATURE_FLAGS), false)
    assert.equal(isSelectableSwapBlockchain('sol', DEFAULT_ENABLED_CHAIN_FEATURE_FLAGS), false)
    assert.equal(isSelectableSwapBlockchain('near', DEFAULT_ENABLED_CHAIN_FEATURE_FLAGS), false)
    assert.equal(isSelectableSwapBlockchain('btc', ALL_CHAIN_FEATURE_FLAGS), true)
    assert.deepEqual(
      privateKeyImportFamilyOptions(DEFAULT_ENABLED_CHAIN_FEATURE_FLAGS)
        .filter(option => option.enabled)
        .map(option => option.family),
      ['eip155']
    )
    assert.deepEqual(
      buildAddTokenNetworks('mainnet', [], DEFAULT_ENABLED_CHAIN_FEATURE_FLAGS).map(network => ({
        family: network.family,
        disabled: network.disabled ?? false
      })),
      [
        { family: 'bitcoin', disabled: true },
        { family: 'solana', disabled: true },
        { family: 'near', disabled: true }
      ]
    )
  })

  it('excludes cached deferred assets from the send picker while listing their disabled networks', () => {
    const model = buildSendAssetSelectionModel({
      assets: [{ chain: { chain: { id: 'bip122:mainnet', family: 'bitcoin' } }, asset: {} }],
      zcashTotal: '0',
      zcashEnabled: true,
      zcashNetwork: 'mainnet',
      zecPrice: 0,
      prices: null,
      selectedNetwork: 'all',
      searchQuery: '',
      enabledFlags: DEFAULT_ENABLED_CHAIN_FEATURE_FLAGS
    })
    assert.deepEqual(
      model.networkOptions.map(option => ({ id: option.id, disabled: option.disabled ?? false })),
      [
        { id: 'zcash', disabled: false },
        { id: 'coming-soon:bitcoin', disabled: true },
        { id: 'coming-soon:solana', disabled: true },
        { id: 'coming-soon:near', disabled: true }
      ]
    )
    assert.deepEqual(
      model.orderedRows.map(row => row.kind),
      ['zcash']
    )
  })

  it('keeps Zcash firmware usable and narrows Keystone multi-coin exports to EVM', () => {
    const bundles = buildKeystoneNetworkBundles(DEFAULT_ENABLED_CHAIN_FEATURE_FLAGS)
    assert.deepEqual(bundles.find(bundle => bundle.id === 'zcash').requestedNetworks, ['zcash'])
    assert.deepEqual(bundles.find(bundle => bundle.id === 'multi-chain').requestedNetworks, ['evm'])
    assert.equal(bundles.find(bundle => bundle.id === 'bitcoin-only').disabled, true)

    const payload = {
      type: 'multi-accounts',
      masterFingerprintHex: '00000000',
      keys: [
        { derivationPath: "m/44'/60'/0'", publicKeyHex: '11'.repeat(33) },
        { derivationPath: "m/84'/0'/0'", publicKeyHex: '22'.repeat(33) },
        { derivationPath: "m/44'/501'/0'", publicKeyHex: '33'.repeat(32) },
        { derivationPath: "m/44'/195'/0'", publicKeyHex: '44'.repeat(33) }
      ]
    }
    assert.deepEqual(
      filterKeystoneMultiAccountsPayload(payload, ['evm']).keys.map(key => key.derivationPath),
      ["m/44'/60'/0'"]
    )
  })
})
