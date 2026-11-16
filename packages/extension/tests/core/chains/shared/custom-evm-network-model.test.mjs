import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildCustomEvmNetwork,
  customEvmNetworkToForm,
  emptyCustomEvmNetworkForm
} from '../../../../src/popup/services/custom-evm-network-model.ts'

const validForm = () => ({
  ...emptyCustomEvmNetworkForm(),
  name: 'My Chain',
  chainId: '31337',
  currencyName: 'My Ether',
  currencySymbol: 'MYETH',
  rpcUrl: 'https://rpc.example',
  explorerUrl: 'https://explorer.example'
})

test('custom EVM form produces a parsed network and round-trips its fields', () => {
  const { network, errors } = buildCustomEvmNetwork(validForm(), 'testnet')
  assert.deepEqual(errors, {})
  assert.equal(network.chainId, 'eip155:31337')
  assert.equal(network.numericChainId, 31337)
  assert.equal(network.nativeCurrency.decimals, 18)
  assert.equal(network.rpc.url, 'https://rpc.example/')
  assert.equal(network.explorer.baseUrl, 'https://explorer.example')
  assert.equal(customEvmNetworkToForm(network).chainId, '31337')
})

test('custom EVM form rejects built-in, non-decimal and changed chain IDs', () => {
  assert.equal(
    buildCustomEvmNetwork({ ...validForm(), chainId: '11155111' }, 'testnet').errors.chainId,
    'This chain is built in'
  )
  assert.equal(
    buildCustomEvmNetwork({ ...validForm(), chainId: '1' }, 'testnet').errors.chainId,
    'This chain is built in on Mainnet'
  )
  assert.equal(
    buildCustomEvmNetwork({ ...validForm(), chainId: '11155111' }, 'mainnet').errors.chainId,
    'This chain is built in on Testnet'
  )
  for (const chainId of ['0x7a69', '0', '01', '9007199254740992']) {
    assert.equal(buildCustomEvmNetwork({ ...validForm(), chainId }, 'testnet').network, undefined)
  }
  const existing = buildCustomEvmNetwork(validForm(), 'testnet').network
  assert.equal(
    buildCustomEvmNetwork({ ...validForm(), chainId: '31338' }, 'testnet', existing).errors.chainId,
    'Chain ID cannot be changed'
  )
})

test('editing a custom explorer keeps its transaction path', () => {
  const original = buildCustomEvmNetwork(validForm(), 'testnet').network
  const existing = {
    ...original,
    explorer: { ...original.explorer, transactionPath: 'transactions' }
  }
  const form = { ...customEvmNetworkToForm(existing), explorerUrl: 'https://updated.example' }
  const { network, errors } = buildCustomEvmNetwork(form, 'testnet', existing)
  assert.deepEqual(errors, {})
  assert.equal(network.explorer.baseUrl, 'https://updated.example')
  assert.equal(network.explorer.transactionPath, 'transactions')
})

test('custom EVM form validates URLs and currency decimals at their fields', () => {
  assert(
    buildCustomEvmNetwork({ ...validForm(), rpcUrl: 'http://remote.example' }, 'mainnet').errors
      .rpcUrl
  )
  assert(
    buildCustomEvmNetwork(
      { ...validForm(), explorerUrl: 'https://user:pass@explorer.example' },
      'mainnet'
    ).errors.explorerUrl
  )
  assert(buildCustomEvmNetwork({ ...validForm(), decimals: '256' }, 'mainnet').errors.decimals)
  assert(
    buildCustomEvmNetwork({ ...validForm(), currencySymbol: 'X'.repeat(17) }, 'mainnet').errors
      .currencySymbol
  )
})
