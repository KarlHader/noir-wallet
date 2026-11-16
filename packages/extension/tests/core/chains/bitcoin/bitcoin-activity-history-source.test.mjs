import * as secp256k1 from '@bitcoinerlab/secp256k1'
import { test } from 'node:test'
import { expect } from '@playwright/test'
import { initEccLib, networks, payments } from 'bitcoinjs-lib'

import { createBitcoinActivityHistorySource } from '../../../../src/infrastructure/chains/bitcoin/bitcoin-activity-history-source.ts'
import { BitcoinRpcError } from '../../../../src/infrastructure/chains/bitcoin/bitcoin-esplora-client.ts'

initEccLib(secp256k1)

const chainId = 'bip122:000000000019d6689c085ae165831e93'
const assetId = `${chainId}/slip44:0`
const scope = { keyDomainId: 'key-domain:bitcoin', accountId: 'account:bitcoin:0' }

function address(index) {
  const privateKey = Buffer.alloc(32)
  privateKey[31] = index
  const value = payments.p2wpkh({
    pubkey: Buffer.from(secp256k1.pointFromScalar(privateKey, true)),
    network: networks.bitcoin
  }).address
  if (!value) throw new Error('Unable to derive Bitcoin test address')
  return value
}

const walletReceive = address(1)
const walletChange = address(2)
const externalSender = address(3)
const externalRecipient = address(4)

function output(addressValue, valueRaw) {
  return { address: addressValue, valueRaw }
}

function transaction(overrides = {}) {
  return {
    transactionId: 'a'.repeat(64),
    feeRaw: '50',
    inputs: [{ coinbase: false, previousOutput: output(externalSender, '1000') }],
    outputs: [output(walletReceive, '600'), output(externalSender, '350')],
    status: {
      confirmed: true,
      blockHeight: 95,
      blockHash: 'b'.repeat(64),
      blockTime: 1_700_000_000
    },
    ...overrides
  }
}

function source(handler, options = {}) {
  const calls = []
  return {
    calls,
    value: createBitcoinActivityHistorySource({
      chainId,
      assetId,
      requiredConfirmations: 6,
      now: () => 1_800_000_000_000,
      rpc: {
        getTipHeight: async signal => {
          calls.push({ method: 'tip', aborted: signal?.aborted })
          return 100
        },
        getAddressTransactions: async (requestedAddress, signal) => {
          calls.push({ method: 'history', address: requestedAddress, aborted: signal?.aborted })
          return handler(requestedAddress)
        }
      },
      ...options
    })
  }
}

test.describe('Bitcoin Activity history source', () => {
  test('maps final incoming history with exact amount and parties', async () => {
    const history = source(() => [transaction()])

    await expect(
      history.value.readAddressActivity({
        scope,
        ownedAddresses: [walletReceive, walletChange],
        historyAddresses: [walletReceive]
      })
    ).resolves.toEqual([
      {
        id: `rpc:bitcoin:${'a'.repeat(64)}`,
        source: 'rpc',
        scope,
        kind: 'transfer',
        status: 'final',
        snapshot: {
          schemaVersion: 1,
          direction: 'incoming',
          primaryAmount: { assetId, amountRaw: '600' },
          sender: { chainId, address: externalSender },
          recipient: { chainId, address: walletReceive }
        },
        segments: [
          {
            id: `rpc:bitcoin:${'a'.repeat(64)}:origin`,
            role: 'origin',
            target: { kind: 'onchain', chainId },
            status: 'final',
            evidence: {
              transactionHash: 'a'.repeat(64),
              blockHash: 'b'.repeat(64),
              blockHeight: 95,
              confirmations: 6,
              requiredConfirmations: 6
            }
          }
        ],
        completeness: 'complete',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000
      }
    ])
    expect(history.calls.map(call => call.method)).toEqual(['tip', 'history'])
  })

  test('deduplicates outgoing history returned for receive and change addresses', async () => {
    const outgoing = transaction({
      transactionId: 'c'.repeat(64),
      inputs: [{ coinbase: false, previousOutput: output(walletReceive, '1000') }],
      outputs: [output(externalRecipient, '600'), output(walletChange, '350')],
      status: { confirmed: false }
    })
    const history = source(() => [outgoing])

    const result = await history.value.readAddressActivity({
      scope,
      ownedAddresses: [walletReceive, walletChange],
      historyAddresses: [walletReceive, walletChange]
    })

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      id: `rpc:bitcoin:${'c'.repeat(64)}`,
      status: 'confirming',
      completeness: 'partial',
      snapshot: {
        direction: 'outgoing',
        primaryAmount: { assetId, amountRaw: '600' },
        sender: { chainId, address: walletReceive },
        recipient: { chainId, address: externalRecipient }
      },
      segments: [{ evidence: { confirmations: 0, requiredConfirmations: 6 } }],
      createdAt: 1_800_000_000_000
    })
    expect(history.calls.filter(call => call.method === 'history')).toHaveLength(2)
  })

  test('marks collaborative transactions partial instead of inventing the wallet amount', async () => {
    const collaborative = transaction({
      transactionId: 'd'.repeat(64),
      inputs: [
        { coinbase: false, previousOutput: output(walletReceive, '1000') },
        { coinbase: false, previousOutput: output(externalSender, '2000') }
      ],
      outputs: [output(externalRecipient, '1500'), output(walletChange, '1400')]
    })
    const history = source(() => [collaborative])

    const [item] = await history.value.readAddressActivity({
      scope,
      ownedAddresses: [walletReceive, walletChange],
      historyAddresses: [walletReceive]
    })

    expect(item.completeness).toBe('partial')
    expect(item.snapshot).toMatchObject({ direction: 'outgoing' })
    expect(item.snapshot).not.toHaveProperty('primaryAmount')
  })

  test('uses observation time and partial completeness when confirmed history omits block time', async () => {
    const history = source(() => [
      transaction({
        status: { confirmed: true, blockHeight: 95, blockHash: 'b'.repeat(64) }
      })
    ])

    const [item] = await history.value.readAddressActivity({
      scope,
      ownedAddresses: [walletReceive],
      historyAddresses: [walletReceive]
    })

    expect(item).toMatchObject({
      status: 'final',
      completeness: 'partial',
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_000
    })
  })

  test('rejects conflicting duplicate transaction evidence and non-owned history addresses', async () => {
    let call = 0
    const history = source(() => {
      call += 1
      return [transaction({ feeRaw: call === 1 ? '50' : '51' })]
    })

    await expect(
      history.value.readAddressActivity({
        scope,
        ownedAddresses: [walletReceive, walletChange],
        historyAddresses: [walletReceive, walletChange]
      })
    ).rejects.toMatchObject({
      name: 'BitcoinRpcError',
      code: 'invalid-response'
    })

    await expect(
      history.value.readAddressActivity({
        scope,
        ownedAddresses: [walletReceive],
        historyAddresses: [externalSender]
      })
    ).rejects.toThrow(/not owned/)
  })

  test('rejects a block above the attested tip', async () => {
    const history = source(() => [
      transaction({
        status: { confirmed: true, blockHeight: 101, blockHash: 'b'.repeat(64), blockTime: 1 }
      })
    ])

    const error = await history.value
      .readAddressActivity({
        scope,
        ownedAddresses: [walletReceive],
        historyAddresses: [walletReceive]
      })
      .catch(value => value)
    expect(error).toBeInstanceOf(BitcoinRpcError)
    expect(error.code).toBe('invalid-response')
  })
})
