import { test } from 'node:test'
import { expect } from '@playwright/test'
import { groupAccountNetworksForDisplay } from '../../../src/popup/components/account/account-network-groups.ts'

function network(id, family, displayName, address) {
  return {
    chain: { id, family, displayName },
    addresses: [
      {
        value: address,
        scheme: family === 'evm' ? 'evm' : family,
        privacy: 'transparent',
        preferredForReceive: true
      }
    ]
  }
}

test('groups EVM networks that share one account address without merging other families', () => {
  const evmAddress = `0x${'a'.repeat(40)}`
  const groups = groupAccountNetworksForDisplay([
    network('eip155:1', 'evm', 'Ethereum', evmAddress),
    network('eip155:56', 'evm', 'BNB Chain', evmAddress.toUpperCase()),
    network('bip122:mainnet', 'bitcoin', 'Bitcoin', 'bc1qfixture')
  ])

  expect(groups).toHaveLength(2)
  expect(groups[0]).toMatchObject({
    family: 'evm',
    displayName: 'EVM',
    networks: [{ chain: { displayName: 'Ethereum' } }, { chain: { displayName: 'BNB Chain' } }],
    addresses: [{ value: evmAddress }]
  })
  expect(groups[1]).toMatchObject({ family: 'bitcoin', displayName: 'Bitcoin' })
})

test('keeps distinct EVM addresses separate', () => {
  const groups = groupAccountNetworksForDisplay([
    network('eip155:1', 'evm', 'Ethereum', `0x${'1'.repeat(40)}`),
    network('eip155:56', 'evm', 'BNB Chain', `0x${'2'.repeat(40)}`)
  ])
  expect(groups).toHaveLength(2)
})
