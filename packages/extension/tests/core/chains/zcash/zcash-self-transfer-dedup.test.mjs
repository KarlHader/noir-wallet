import { test } from 'node:test'
import { expect } from '@playwright/test'

import { ZCASH_CHAIN_IDS } from '../../../../src/core/chains/registry/chain-ids.ts'
import {
  mergeTransactionsWithTransparentReceives,
  mergeTransactionsWithWasmHistory
} from '../../../../src/core/wallet/transparent-history.ts'
import { buildActivityReadModel } from '../../../../src/core/activity/index.ts'
import { mapZcashV1TransactionToActivityItem } from '../../../../src/infrastructure/activity/zcash-v1-activity-source.ts'
import { filterActivityItems } from '../../../../src/popup/services/activity-list-model.ts'

function transaction(overrides) {
  return {
    id: 'tx_send',
    txHash: 'self-transfer',
    status: 'success',
    type: 'send',
    amount: '0.001',
    to: 't1wallet',
    from: 'u1wallet',
    fromType: 'shielded',
    fee: '0.0001',
    timestamp: 2,
    network: 'mainnet',
    ...overrides
  }
}

test('shows a Shield send and its observed transparent receive in their own Activity modes', () => {
  const selfSend = transaction({})
  const receivedSide = transaction({
    id: 'rpc_treceive_self-transfer',
    type: 'receive',
    from: '',
    fromType: 'transparent',
    amount: '0.0009'
  })

  const history = mergeTransactionsWithTransparentReceives([selfSend], [receivedSide])
  const scope = { keyDomainId: 'wallet:activity', accountId: 'account:activity' }
  const { items } = buildActivityReadModel({
    scope,
    localGraphs: [],
    supplementalItems: history.map(entry => mapZcashV1TransactionToActivityItem(entry, scope))
  })
  const byDomain = domain =>
    filterActivityItems({ items, domain, selectedChainIds: [ZCASH_CHAIN_IDS.mainnet] })

  expect(byDomain('shield').map(item => item.id)).toEqual([selfSend.id])
  expect(byDomain('public')).toMatchObject([
    {
      id: receivedSide.id,
      kind: 'receive',
      snapshot: { direction: 'incoming', primaryAmount: { amountRaw: '90000' } }
    }
  ])
})

test('preserves the transparent receive side of an Unshield transaction', () => {
  const unshield = transaction({ type: 'unshield' })
  const receivedSide = transaction({
    id: 'rpc_treceive_self-transfer',
    type: 'receive',
    from: '',
    fromType: 'transparent'
  })

  expect(mergeTransactionsWithTransparentReceives([unshield], [receivedSide])).toEqual([
    unshield,
    receivedSide
  ])
})

test('shows a scanned Shield credit from a regular Public ZEC send to the same account', () => {
  const addresses = { transparent: 't1wallet', shielded: 'u1wallet', fullUnified: 'u1full' }
  const publicSend = transaction({
    to: addresses.fullUnified,
    from: addresses.transparent,
    fromType: 'transparent'
  })
  const shieldCredit = transaction({
    id: 'wasm_self-transfer',
    type: 'shield',
    amount: '0.0009',
    to: '',
    confirmations: 3
  })
  const scope = { keyDomainId: 'wallet:activity', accountId: 'account:activity' }
  const history = mergeTransactionsWithWasmHistory(
    [publicSend],
    [shieldCredit],
    [],
    addresses
  ).transactions
  const refreshed = mergeTransactionsWithWasmHistory(
    history,
    [shieldCredit],
    [],
    addresses
  ).transactions
  const { items } = buildActivityReadModel({
    scope,
    localGraphs: [],
    supplementalItems: refreshed.map(entry => mapZcashV1TransactionToActivityItem(entry, scope))
  })
  const byDomain = domain =>
    filterActivityItems({ items, domain, selectedChainIds: [ZCASH_CHAIN_IDS.mainnet] })
  expect(byDomain('public')).toMatchObject([
    { id: publicSend.id, kind: 'transfer', snapshot: { direction: 'outgoing' } }
  ])
  expect(byDomain('shield')).toMatchObject([
    {
      id: shieldCredit.id,
      kind: 'receive',
      snapshot: { direction: 'incoming', primaryAmount: { amountRaw: '90000' } }
    }
  ])
  const externalSend = { ...publicSend, to: 'u1external' }
  expect(
    mergeTransactionsWithWasmHistory(
      [externalSend],
      [shieldCredit],
      [],
      addresses
    ).transactions.map(entry => entry.type)
  ).toEqual(['send'])
})

test('only projects a Public ZEC credit for an owned transparent recipient', () => {
  const chainId = ZCASH_CHAIN_IDS.mainnet
  const amount = { assetId: `${chainId}/slip44:133`, amountRaw: '90000' }
  const publicReceipts = address => {
    const source = {
      id: 'tx:confidential:send',
      source: 'wallet-v2',
      scope: { keyDomainId: 'wallet:activity', accountId: 'account:activity' },
      kind: 'withdraw',
      status: 'final',
      snapshot: {
        direction: 'outgoing',
        shield: { operation: 'withdraw', sourceDomain: 'shield', destinationDomain: 'public' },
        recipient: { chainId, address },
        counterAmount: amount
      },
      segments: [
        {
          id: 'destination',
          role: 'destination',
          status: 'final',
          target: { kind: 'onchain', chainId },
          evidence: { transactionHash: 'a'.repeat(64), settledAmount: amount }
        }
      ]
    }
    return filterActivityItems({
      items: [source],
      domain: 'public',
      selectedChainIds: [chainId],
      executionAddressModes: new Map([[`${chainId}:${address}`, 'Public']])
    })
  }
  expect(publicReceipts('u1wallet')).toEqual([])
  expect(publicReceipts('t1wallet')).toMatchObject([
    { kind: 'receive', snapshot: { primaryAmount: amount } }
  ])
})
