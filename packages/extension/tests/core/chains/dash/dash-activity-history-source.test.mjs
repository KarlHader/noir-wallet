import { test } from 'node:test'
import { expect } from '@playwright/test'

import { DASH_CHAIN_IDS } from '../../../../src/core/chains/registry/chain-ids.ts'
import { createDashActivityHistorySource } from '../../../../src/infrastructure/chains/dash/dash-activity-history-source.ts'

const chainId = DASH_CHAIN_IDS.mainnet
const assetId = `${chainId}/slip44:5`
const scope = { keyDomainId: 'key-domain:dash', accountId: 'account:dash:0' }
const walletReceive = 'XoJA8qE3N2Y3jMLEtZ3vcN42qseZ8LvFf5'
const walletChange = 'XbctnEsgWTn5j1co3emZynemxSFPqkLRKZ'
const externalRecipient = 'XfoXRyRePBFFhg7fKbsGRQBixHipJSGqNf'
const externalSender = 'XnykfdCWrHENs8aH8X59RLZAn15VAP1cPB'
const txid = 'ab'.repeat(32)

function transaction(overrides = {}) {
  return {
    transactionId: txid,
    confirmations: 6,
    time: 1_700_000_000,
    feeDuffs: '10000',
    inputs: [{ address: walletReceive }],
    outputs: [
      { valueDuffs: '1200000', addresses: [externalRecipient] },
      { valueDuffs: '3080582', addresses: [walletChange] }
    ],
    ...overrides
  }
}

function source(transactionsForAddress) {
  const calls = []
  const history = createDashActivityHistorySource({
    chainId,
    now: () => 1_700_000_100_000,
    rpc: {
      async getAddressTransactions(address, pageNum) {
        calls.push({ address, pageNum })
        return { pagesTotal: 1, transactions: transactionsForAddress(address) }
      }
    }
  })
  return { history, calls }
}

test('nets a send and its change into one external outgoing activity item', async () => {
  const { history, calls } = source(address =>
    address === walletReceive || address === walletChange ? [transaction()] : []
  )

  const result = await history.readAddressActivity({
    scope,
    ownedAddresses: [walletReceive, walletChange],
    historyAddresses: [walletReceive, walletChange]
  })

  expect(result).toHaveLength(1)
  expect(result[0]).toMatchObject({
    id: `dash:${txid}`,
    status: 'final',
    snapshot: {
      direction: 'outgoing',
      primaryAmount: { assetId, amountRaw: '1200000' },
      sender: { chainId, address: walletReceive },
      recipient: { chainId, address: externalRecipient }
    }
  })
  expect(calls.map(call => call.address)).toEqual([walletReceive, walletChange])
})

test('omits a transaction that only pays a change address', async () => {
  const { history } = source(() => [
    transaction({
      outputs: [{ valueDuffs: '3080582', addresses: [walletChange] }]
    })
  ])

  const result = await history.readAddressActivity({
    scope,
    ownedAddresses: [walletReceive, walletChange],
    historyAddresses: [walletChange]
  })

  expect(result).toEqual([])
})

test('keeps an external payment as one incoming item', async () => {
  const { history } = source(() => [
    transaction({
      inputs: [{ address: externalSender }],
      outputs: [{ valueDuffs: '4280000', addresses: [walletReceive] }]
    })
  ])

  const [item] = await history.readAddressActivity({
    scope,
    ownedAddresses: [walletReceive, walletChange],
    historyAddresses: [walletReceive]
  })

  expect(item).toMatchObject({
    snapshot: {
      direction: 'incoming',
      primaryAmount: { assetId, amountRaw: '4280000' },
      sender: { chainId, address: externalSender },
      recipient: { chainId, address: walletReceive }
    }
  })
})

test('does not query an owned address that has no history', async () => {
  const { history, calls } = source(() => [transaction()])

  await history.readAddressActivity({
    scope,
    ownedAddresses: [walletReceive, walletChange],
    historyAddresses: [walletReceive]
  })

  expect(calls.map(call => call.address)).toEqual([walletReceive])
})
