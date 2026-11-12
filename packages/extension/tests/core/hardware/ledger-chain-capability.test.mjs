import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  keySourceSupportsAddressFamily,
  keySourceSupportsChainFamily
} from '../../../src/core/accounts/application/key-source-chain-policy.ts'

test('Ledger Zcash credentials can use Zcash accounts without claiming other chains', () => {
  const source = {
    kind: 'hardware',
    vendor: 'ledger',
    firmwareProfile: 'zcash',
    capabilities: ['zcash']
  }
  expect(keySourceSupportsChainFamily(source, 'zcash')).toBe(true)
  expect(keySourceSupportsAddressFamily(source, 'zcash')).toBe(true)
  for (const family of ['evm', 'bitcoin', 'solana', 'tron', 'near', 'dash']) {
    expect(keySourceSupportsChainFamily(source, family)).toBe(false)
    expect(keySourceSupportsAddressFamily(source, family)).toBe(false)
  }
})

test('Dash stays unavailable until a hardware account declares the dash capability', () => {
  const ledger = {
    kind: 'hardware',
    vendor: 'ledger',
    firmwareProfile: 'multi-coin',
    capabilities: ['bitcoin', 'evm']
  }
  const keystone = {
    kind: 'hardware',
    vendor: 'keystone',
    firmwareProfile: 'multi-coin',
    capabilities: ['zcash', 'bitcoin', 'evm']
  }
  expect(keySourceSupportsChainFamily(ledger, 'dash')).toBe(false)
  expect(keySourceSupportsAddressFamily(ledger, 'dash')).toBe(false)
  expect(keySourceSupportsChainFamily(keystone, 'dash')).toBe(false)
  expect(keySourceSupportsAddressFamily(keystone, 'dash')).toBe(false)
  expect(keySourceSupportsChainFamily({ ...ledger, vendor: 'other' }, 'dash')).toBe(false)

  const declared = { ...ledger, capabilities: ['bitcoin', 'dash'] }
  expect(keySourceSupportsChainFamily(declared, 'dash')).toBe(true)
  expect(keySourceSupportsAddressFamily(declared, 'dash')).toBe(true)
  expect(keySourceSupportsChainFamily({ ...keystone, capabilities: ['dash'] }, 'dash')).toBe(true)
  expect(keySourceSupportsChainFamily({ kind: 'software' }, 'dash')).toBe(true)
  expect(keySourceSupportsChainFamily({ kind: 'private-key', chainFamily: 'dash' }, 'dash')).toBe(
    true
  )
  expect(
    keySourceSupportsChainFamily({ kind: 'private-key', chainFamily: 'dash' }, 'bitcoin')
  ).toBe(false)
  expect(
    keySourceSupportsChainFamily(
      { kind: 'private-key', chainFamily: 'bip122', bitcoinNetwork: 'mainnet' },
      'dash'
    )
  ).toBe(false)
})

test('Starknet stays unavailable until a Ledger account declares the starknet capability', () => {
  const ledger = {
    kind: 'hardware',
    vendor: 'ledger',
    firmwareProfile: 'multi-coin',
    capabilities: ['bitcoin', 'evm']
  }
  expect(keySourceSupportsChainFamily(ledger, 'starknet')).toBe(false)
  expect(keySourceSupportsAddressFamily(ledger, 'starknet')).toBe(false)
  const declared = { ...ledger, capabilities: ['starknet'] }
  expect(keySourceSupportsChainFamily(declared, 'starknet')).toBe(true)
  expect(keySourceSupportsAddressFamily(declared, 'starknet')).toBe(true)
  expect(keySourceSupportsChainFamily(declared, 'evm')).toBe(false)
  const keystone = {
    kind: 'hardware',
    vendor: 'keystone',
    firmwareProfile: 'multi-coin',
    capabilities: ['starknet']
  }
  expect(keySourceSupportsChainFamily(keystone, 'starknet')).toBe(false)
  expect(keySourceSupportsAddressFamily(keystone, 'starknet')).toBe(false)
  expect(
    keySourceSupportsChainFamily({ kind: 'private-key', chainFamily: 'starknet' }, 'starknet')
  ).toBe(false)
})
