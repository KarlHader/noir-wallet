import { createProtocolMappings as createMappings } from '../../helpers/asset-market-fixtures.mjs'
import { test } from 'node:test'
import { expect } from '@playwright/test'

test('preserves the exact 1Click identities of bundled mainnet assets', () => {
  const { mappings } = createMappings('mainnet')
  expect(new Set(mappings.map(mapping => mapping.assetId)).size).toBe(mappings.length)
  expect(new Set(mappings.map(mapping => mapping.protocolAssetId)).size).toBe(mappings.length)

  const byAssetId = Object.fromEntries(
    mappings.map(mapping => [mapping.assetId, mapping.protocolAssetId])
  )
  expect(byAssetId).toMatchObject({
    'bip122:000000000019d6689c085ae165831e93/slip44:0': 'nep141:btc.omft.near',
    'bip122:00040fe8ec8471911baa1db1266ea15d/slip44:133': 'nep141:zec.omft.near',
    'eip155:1/slip44:60': 'nep141:eth.omft.near',
    'eip155:42161/slip44:60': 'nep141:arb.omft.near',
    'eip155:8453/slip44:60': 'nep141:base.omft.near',
    'eip155:56/slip44:714': 'nep141:bnb.omdep.near',
    'eip155:137/slip44:966': 'nep141:pol.omdep.near',
    'eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':
      'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
    'eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831':
      'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
    'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913':
      'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
    'eip155:56/erc20:0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d':
      'nep141:bnb-0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d.omdep.near',
    'eip155:137/erc20:0x3c499c542cef5e3811e1192ce70d8cc03d5c3359':
      'nep141:pol-0x3c499c542cef5e3811e1192ce70d8cc03d5c3359.omdep.near'
  })
})

test('does not expose mainnet protocol assets from a testnet wallet build', () => {
  expect(createMappings('testnet').mappings).toEqual([])
})
