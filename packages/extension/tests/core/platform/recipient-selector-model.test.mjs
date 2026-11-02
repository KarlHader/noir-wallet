import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  buildMyAccountRecipientGroups,
  buildSavedRecipientList
} from '../../../src/popup/components/transaction/recipient-selector-model.ts'

const ZCASH = 'bip122:0000000000000000000000000000000000000000000000000000000000000000'
const EVM = 'eip155:1'
const BITCOIN = 'bip122:000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'

function address(value, scheme, preferredForReceive = false) {
  return {
    value,
    scheme,
    privacy: scheme.startsWith('zcash-shielded') ? 'shielded' : 'transparent',
    preferredForReceive
  }
}

function network(chainId, family, addresses) {
  return { chain: { id: chainId, family }, addresses }
}

function account(walletId, accountId, active, suffix) {
  return {
    walletId,
    walletDisplayName: `Wallet ${walletId}`,
    walletSource: { kind: 'software' },
    accountId,
    accountDisplayName: `Account ${accountId}`,
    accountIndex: Number(accountId),
    active,
    networks: [
      network(ZCASH, 'zcash', [
        address(`u1shielded${suffix}`, 'zcash-shielded-unified', true),
        address(`t1transparent${suffix}`, 'zcash-transparent-p2pkh')
      ]),
      network(EVM, 'evm', [address(`0x${suffix.repeat(40)}`, 'evm', true)]),
      network(BITCOIN, 'bitcoin', [
        address(`bc1qnative${suffix}`, 'bitcoin-p2wpkh', true),
        address(`bc1ptaproot${suffix}`, 'bitcoin-p2tr')
      ])
    ]
  }
}

const catalog = {
  generationId: 'generation-1',
  accounts: [
    account('1', '0', true, '1'),
    account('1', '1', false, '2'),
    account('2', '0', false, '3')
  ]
}

test('keeps the alternate current Zcash address and every address for other Zcash accounts', () => {
  const groups = buildMyAccountRecipientGroups(catalog, ZCASH, ['u1shielded1'])

  expect(groups.map(group => group.key)).toEqual(['1:0', '1:1', '2:0'])
  expect(groups[0]).toMatchObject({ active: true, addresses: [{ value: 't1transparent1' }] })
  expect(groups[1].addresses.map(item => item.value)).toEqual(['u1shielded2', 't1transparent2'])
})

test('shows only the preferred receive address of other EVM and Bitcoin accounts', () => {
  const evmGroups = buildMyAccountRecipientGroups(catalog, EVM, [`0x${'1'.repeat(40)}`])
  const bitcoinGroups = buildMyAccountRecipientGroups(catalog, BITCOIN)

  expect(evmGroups.map(group => group.key)).toEqual(['1:1', '2:0'])
  expect(evmGroups.flatMap(group => group.addresses.map(item => item.value))).toEqual([
    `0x${'2'.repeat(40)}`,
    `0x${'3'.repeat(40)}`
  ])
  expect(bitcoinGroups.flatMap(group => group.addresses.map(item => item.scheme))).toEqual([
    'bitcoin-p2wpkh',
    'bitcoin-p2wpkh'
  ])
})

test('includes the current Bitcoin receive address only when requested', () => {
  const groups = buildMyAccountRecipientGroups(catalog, BITCOIN, [], {
    includeCurrentAccount: true
  })

  expect(groups.map(group => group.key)).toEqual(['1:0', '1:1', '2:0'])
  expect(groups[0].addresses.map(item => item.value)).toEqual(['bc1qnative1'])
  expect(
    buildMyAccountRecipientGroups(catalog, BITCOIN, ['bc1qnative1'], {
      includeCurrentAccount: true
    }).map(group => group.key)
  ).toEqual(['1:1', '2:0'])
})

test('keeps accounts without the target network disabled only when requested', () => {
  const scope = {
    generationId: 'generation-1',
    accounts: [account('1', '0', true, '1'), { ...account('2', '0', false, '2'), networks: [] }]
  }

  expect(buildMyAccountRecipientGroups(scope, BITCOIN).map(group => group.key)).toEqual([])
  const groups = buildMyAccountRecipientGroups(scope, BITCOIN, [], {
    includeUnavailableAccounts: true
  })
  expect(groups.map(group => group.key)).toEqual(['2:0'])
  expect(groups[0].addresses).toEqual([])
})

test('includes the current EVM account alternate execution address and excludes only the sender', () => {
  const current = account('1', '0', true, '1')
  current.networks.find(item => item.chain.id === EVM).privateExecutionAddress =
    `0x${'a'.repeat(40)}`
  const scope = { generationId: 'generation-1', accounts: [current] }
  const publicSender = buildMyAccountRecipientGroups(scope, EVM, [`0x${'1'.repeat(40)}`])
  expect(publicSender[0]).toMatchObject({
    active: true,
    addresses: [
      {
        value: `0x${'a'.repeat(40)}`,
        executionMode: 'private'
      }
    ]
  })
  const privateSender = buildMyAccountRecipientGroups(scope, EVM, [`0x${'A'.repeat(40)}`])
  expect(privateSender[0].addresses).toMatchObject([
    { value: `0x${'1'.repeat(40)}`, executionMode: 'main' }
  ])
  expect(buildMyAccountRecipientGroups(scope, 'eip155:42161')).toEqual([])
  current.networks.find(item => item.chain.id === EVM).privateExecutionAddress =
    `0x${'1'.repeat(40)}`
  expect(buildMyAccountRecipientGroups(scope, EVM).flatMap(group => group.addresses)).toHaveLength(
    1
  )
})

test('keeps saved external recipients in a separate chain-scoped alphabetical list', () => {
  const contacts = [
    { id: '2', chainId: EVM, address: `0x${'2'.repeat(40)}`, name: 'Bob' },
    { id: '1', chainId: EVM, address: `0x${'1'.repeat(40)}`, name: 'Alice' },
    { id: '3', chainId: BITCOIN, address: 'bc1qexternal', name: 'Bitcoin contact' }
  ]

  expect(buildSavedRecipientList(contacts, EVM).map(contact => contact.name)).toEqual([
    'Alice',
    'Bob'
  ])
  expect(buildSavedRecipientList(contacts, EVM, [`0x${'1'.repeat(40).toUpperCase()}`])).toEqual([
    contacts[0]
  ])
})
