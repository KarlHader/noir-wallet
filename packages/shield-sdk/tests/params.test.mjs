import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prepareQuote, prepareReceive, prepareTransfer } from '../src/layers/near-confidential.ts'
import { ShieldError } from '../src/types.ts'

test('receive keeps the layer and normalizes the source chain', () => {
  const request = prepareReceive({
    layer: 'near-confidential',
    source: { chainId: 56, assetId: 'eip155:56/slip44:714', symbol: 'BNB' },
    amount: '0.10'
  })
  assert.equal(request.layer, 'near-confidential')
  assert.deepEqual(request.source, {
    chainId: 'eip155:56',
    assetId: 'eip155:56/slip44:714',
    symbol: 'BNB'
  })
  assert.equal(request.amount, '0.10')
})

test('transfer accepts a public address or a confidential account id', () => {
  const pub = prepareTransfer({
    layer: 'near-confidential',
    token: { chainId: '0x38', assetId: 'eip155:56/slip44:714' },
    amount: '1',
    destination: {
      kind: 'public',
      chainId: 'eip155:1',
      address: '0x1111111111111111111111111111111111111111'
    }
  })
  assert.equal(pub.destination.kind, 'public')
  assert.equal(pub.destination.chainId, 'eip155:1')
  assert.equal('assetId' in pub.destination, false)
  assert.equal(pub.token.chainId, 'eip155:56')

  const internal = prepareTransfer({
    layer: 'near-confidential',
    token: { chainId: 1, symbol: 'ETH' },
    amount: '0.01',
    destination: { kind: 'confidential', accountId: 'recipient.account' }
  })
  assert.deepEqual(internal.destination, {
    kind: 'confidential',
    accountId: 'recipient.account'
  })
  const crossChain = prepareTransfer({
    layer: 'near-confidential',
    token: { chainId: 56, assetId: 'eip155:56/slip44:714' },
    amount: '1',
    destination: {
      kind: 'confidential',
      accountId: 'recipient.account',
      chainId: '0x1'
    }
  })
  assert.deepEqual(crossChain.destination, {
    kind: 'confidential',
    accountId: 'recipient.account',
    chainId: 'eip155:1'
  })
  assert.throws(
    () =>
      prepareTransfer({
        layer: 'near-confidential',
        token: { chainId: 1, assetId: 'eip155:1/slip44:60' },
        amount: '1',
        destination: {
          kind: 'confidential',
          accountId: 'recipient.account',
          chainId: 1,
          assetId: 'eip155:1/slip44:60'
        }
      }),
    /destination token cannot be selected/
  )
  assert.equal('peaAddress' in internal, false)
  assert.equal('peaAddress' in internal.destination, false)

  const checksummed = '0x229E549c97C22b139b8C05fba770D94C086853d8'
  const normalized = prepareTransfer({
    layer: 'near-confidential',
    token: { chainId: 1, assetId: 'eip155:1/slip44:60' },
    amount: '1',
    destination: { kind: 'confidential', accountId: checksummed }
  })
  assert.equal(normalized.destination.accountId, checksummed.toLowerCase())

  const quote = prepareQuote({
    layer: 'near-confidential',
    action: 'transfer',
    amount: '1',
    token: { chainId: 1, assetId: 'eip155:1/slip44:60' },
    destination: { kind: 'confidential', accountId: checksummed }
  })
  assert.equal(quote.destination.accountId, checksummed.toLowerCase())
  const publicQuote = prepareQuote({
    layer: 'near-confidential',
    action: 'transfer',
    amount: '1',
    token: { chainId: 1, assetId: 'eip155:1/slip44:60' },
    destination: {
      kind: 'public',
      chainId: 'eip155:1',
      address: checksummed
    }
  })
  assert.equal(publicQuote.destination.address, checksummed)
  assert.throws(
    () =>
      prepareQuote({
        layer: 'near-confidential',
        action: 'transfer',
        amount: '1',
        token: { chainId: 1, assetId: 'eip155:1/slip44:60' },
        destination: {
          kind: 'public',
          chainId: 'eip155:1',
          symbol: 'ETH',
          address: checksummed
        }
      }),
    /destination token cannot be selected/
  )
})

test('rejects another layer, peaAddress, and a missing asset', () => {
  assert.throws(
    () =>
      prepareReceive({
        layer: 'privacy-pools',
        source: { chainId: 1, assetId: 'eip155:1/slip44:60' },
        amount: '1'
      }),
    ShieldError
  )
  assert.throws(
    () =>
      prepareTransfer({
        layer: 'near-confidential',
        token: { chainId: 1, assetId: 'eip155:1/slip44:60' },
        amount: '1',
        destination: { kind: 'confidential', accountId: 'id', peaAddress: '0xabc' }
      }),
    ShieldError
  )
  assert.throws(
    () =>
      prepareReceive({
        layer: 'near-confidential',
        source: { chainId: 1 },
        amount: '1'
      }),
    /asset ID or a unique symbol/
  )
})
