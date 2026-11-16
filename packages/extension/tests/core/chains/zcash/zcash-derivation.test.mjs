import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mapWasmAccountAddresses,
  mapWasmShieldedAddresses,
  mergeAccountAddresses
} from '../../../../src/core/zcash/account-addresses.ts'
import { getZcashDerivationPaths } from '../../../../src/lib/zcash-derivation.ts'
import { selectShieldedReceiveAddress } from '../../../../src/core/wallet/shielded-address-history.ts'
import {
  projectWalletNetwork,
  withNetworkAddresses
} from '../../../../src/store/wallet-network-projection.ts'
import { createAccountNetworksClient } from '../../../../src/popup/services/account-networks-client.ts'
import {
  createAddressGatedChainRegistry,
  createInitialProductChainRegistry,
  getZcashChainId
} from '../../../../src/core/chains/registry/index.ts'

const raw = {
  transparent: 't1primary',
  unified: 'u1initial',
  full_unified: 'u1full',
  address_index: 0
}
const primary = mapWasmAccountAddresses(raw)

test('primary transparent paths use the returned child index, including zero and nonzero', () => {
  for (const index of [0, 1, 42, 0x7fffffff]) {
    const addresses = mapWasmAccountAddresses({ ...raw, address_index: index })
    assert.equal(addresses.transparentAddressIndex, index)
    assert.equal(
      getZcashDerivationPaths('mainnet', "m/32'/133'/0'", addresses, addresses.transparent)
        .transparent,
      `m/44'/133'/0'/0/${index}`
    )
  }
  for (const index of [undefined, null, -1, 0.5, NaN, Infinity, '0', 0x80000000]) {
    const addresses = mapWasmAccountAddresses({ ...raw, address_index: index })
    assert.equal(addresses.transparentAddressIndex, undefined)
    assert.equal(
      getZcashDerivationPaths('mainnet', "m/32'/133'/0'", addresses, 't1primary').transparent,
      null
    )
  }
  assert.equal(
    mapWasmAccountAddresses({ ...raw, transparent: null }).transparentAddressIndex,
    undefined
  )
})

test('address refresh keeps a rotated receive address and binds the index to the transparent receiver', () => {
  const rotated = { ...primary, shielded: 'u1rotated', fullUnified: 'u1rotatedfull' }
  assert.deepEqual(mergeAccountAddresses(rotated, { ...primary, transparentAddressIndex: 7 }), {
    ...rotated,
    transparentAddressIndex: 7
  })
  const unknown = { transparent: 't1primary', shielded: 'u1initial' }
  assert.equal(mergeAccountAddresses(rotated, unknown).transparentAddressIndex, 0)
  assert.equal(
    mergeAccountAddresses(rotated, { ...unknown, transparent: 't1different' })
      .transparentAddressIndex,
    undefined
  )
  const next = mapWasmShieldedAddresses({
    ...raw,
    unified: 'u1next',
    address_index: null,
    transparent: null
  })
  const selected = selectShieldedReceiveAddress(
    {
      networkAddresses: { mainnet: { ...primary, ...next } },
      networkShieldedReceiveAddressHistory: {
        mainnet: [{ shielded: primary.shielded, fullUnified: primary.fullUnified }]
      }
    },
    'mainnet',
    primary.shielded
  )
  assert.equal(selected.transparentAddressIndex, 0)
  assert.equal(selected.transparent, primary.transparent)
})

test('network hydration and switching preserve distinct transparent child indexes', () => {
  const mainnet = withNetworkAddresses({ addresses: primary, birthdayHeight: 1 }, 'mainnet')
  const testnet = mapWasmAccountAddresses({
    ...raw,
    transparent: 'tmprimary',
    unified: 'utest1initial',
    address_index: 1
  })
  const wallet = {
    accounts: [{ ...mainnet, networkAddresses: { ...mainnet.networkAddresses, testnet } }]
  }
  assert.equal(
    projectWalletNetwork(wallet, 'mainnet').accounts[0].addresses.transparentAddressIndex,
    0
  )
  const switched = projectWalletNetwork(wallet, 'testnet').accounts[0].addresses
  assert.equal(
    getZcashDerivationPaths('testnet', "m/32'/1'/0'", switched, 'tmprimary').transparent,
    "m/44'/1'/0'/0/1"
  )
})

test('display uses the registered device path and never associates another receiver or network', async () => {
  const chains = createAddressGatedChainRegistry(createInitialProductChainRegistry('mainnet'), [
    'chain.zcash'
  ])
  const network = {
    chainId: getZcashChainId('mainnet'),
    accountDerivationPath: "m/32'/133'/8'",
    addresses: [
      {
        value: 'u1initial',
        scheme: 'zcash-shielded-unified',
        privacy: 'shielded',
        preferredForReceive: true
      },
      {
        value: 't1primary',
        scheme: 'zcash-transparent-p2pkh',
        privacy: 'transparent',
        preferredForReceive: false
      }
    ]
  }
  const response = () => ({
    result: {
      generationId: 'storage-v2:generation:derivation',
      accounts: [
        {
          walletId: 'wallet:derivation',
          walletDisplayName: 'Ledger',
          walletSource: { kind: 'software' },
          accountId: 'account:derivation',
          accountDisplayName: 'Account',
          accountIndex: 3,
          active: true,
          networks: [network]
        }
      ]
    }
  })
  const client = createAccountNetworksClient(async () => response(), chains)
  const account = (await client.getCatalog()).accounts[0]
  assert.equal(account.accountIndex, 3)
  assert.deepEqual(
    getZcashDerivationPaths(
      'mainnet',
      account.networks[0].accountDerivationPath,
      primary,
      't1primary'
    ),
    {
      account: "m/32'/133'/8'",
      transparent: "m/44'/133'/8'/0/0"
    }
  )
  assert.equal(
    getZcashDerivationPaths('mainnet', network.accountDerivationPath, primary, 't1other')
      .transparent,
    null
  )
  for (const path of ["m/32'/1'/8'", "m/32'/133'/2147483648'", "m/32'/133'/08'", 'bogus']) {
    network.accountDerivationPath = path
    await assert.rejects(client.getCatalog(), { code: 'invalid-response' })
  }
})
