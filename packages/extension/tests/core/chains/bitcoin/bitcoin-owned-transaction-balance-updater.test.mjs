import { test } from 'node:test'
import { expect } from '@playwright/test'
import { address, networks, payments, Transaction } from 'bitcoinjs-lib'

import { BitcoinOwnedTransactionBalanceUpdater } from '../../../../src/infrastructure/chains/bitcoin/index.ts'

const chainId = 'bip122:000000000019d6689c085ae165831e93'
const fundingTransactionId = 'c'.repeat(64)
const pointer = {
  schemaVersion: 2,
  generationId: 'metadata:generation:bitcoin-owned-broadcast',
  sourceFingerprint: 'a'.repeat(64),
  committedAt: 1_000
}

function wallet(number, publicKey) {
  const identity = payments.p2wpkh({
    pubkey: Buffer.from(publicKey, 'hex'),
    network: networks.bitcoin
  }).address
  if (!identity) throw new Error('Expected a Bitcoin address')
  const keyDomainId = `key-domain:bitcoin:wallet-${number}`
  const accountId = `account:bitcoin:wallet-${number}`
  return {
    keyDomain: {
      id: keyDomainId,
      credentialRef: `credential-set:bitcoin:wallet-${number}`,
      source: { kind: 'software', mnemonicWordCount: 24 },
      displayName: `Wallet ${number}`,
      createdAt: 1_000
    },
    account: {
      id: accountId,
      keyDomainId,
      accountIndex: 0,
      displayName: 'Account 1',
      createdAt: 1_000
    },
    chainAccount: {
      id: `chain-account:bitcoin:wallet-${number}`,
      scope: { keyDomainId, accountId, chainId },
      derivation: { scheme: 'bip84', path: "m/84'/0'/0'/0/0" },
      identity: { kind: 'account-identifier', value: identity },
      createdAt: 1_000
    },
    publicKey,
    identity
  }
}

function discoveryState(value, utxos) {
  return {
    chainAccount: value.chainAccount,
    accountIndex: 0,
    checkpoint: {
      schemaVersion: 1,
      chainId,
      accountIndex: 0,
      gapLimit: 1,
      maximumAddressesPerTarget: 2,
      cursors: [
        {
          target: { addressType: 'p2wpkh', change: false },
          nextAddressIndex: 1,
          consecutiveUnused: utxos.length === 0 ? 1 : 0,
          complete: utxos.length === 0
        }
      ]
    },
    observations: [
      {
        derived: {
          chainId,
          addressType: 'p2wpkh',
          accountIndex: 0,
          change: false,
          addressIndex: 0,
          address: value.identity,
          addressScheme: 'bitcoin-p2wpkh',
          derivationScheme: 'bip84',
          derivationPath: "m/84'/0'/0'/0/0",
          publicKey: `0x${value.publicKey}`
        },
        activity: {
          confirmedTransactionCount: utxos.length === 0 ? 0 : 1,
          mempoolTransactionCount: 0,
          used: utxos.length > 0
        },
        utxos
      }
    ],
    updatedAt: 1_000
  }
}

function scopeKey(chainAccount) {
  return `${chainAccount.scope.keyDomainId}:${chainAccount.scope.accountId}`
}

test.describe('Bitcoin owned broadcast balance updater', () => {
  test('removes the sender input and adds sender change and a second Wallet recipient output', async () => {
    const sender = wallet(
      1,
      `02${'79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'}`
    )
    const recipient = wallet(
      2,
      `03${'79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'}`
    )
    const states = new Map([
      [
        scopeKey(sender.chainAccount),
        discoveryState(sender, [
          {
            transactionId: fundingTransactionId,
            outputIndex: 0,
            valueRaw: '15470',
            status: { confirmed: true, blockHeight: 900_000, blockHash: 'd'.repeat(64) }
          },
          {
            transactionId: 'e'.repeat(64),
            outputIndex: 1,
            valueRaw: '31810',
            status: { confirmed: true, blockHeight: 899_999, blockHash: 'f'.repeat(64) }
          }
        ])
      ],
      [scopeKey(recipient.chainAccount), discoveryState(recipient, [])]
    ])
    const snapshot = {
      manifest: {
        schemaVersion: 2,
        generationId: pointer.generationId,
        status: 'verified',
        sourceFingerprint: pointer.sourceFingerprint,
        createdAt: 1_000,
        verifiedAt: 1_000,
        entityCounts: { keyDomains: 2, accounts: 2, chainAccounts: 2, addresses: 0 },
        activeAccount: {
          keyDomainId: sender.chainAccount.scope.keyDomainId,
          accountId: sender.chainAccount.scope.accountId
        }
      },
      keyDomains: [sender.keyDomain, recipient.keyDomain],
      accounts: [sender.account, recipient.account],
      chainAccounts: [sender.chainAccount, recipient.chainAccount],
      addresses: []
    }
    const updates = []
    const transaction = new Transaction()
    transaction.addInput(Buffer.from(fundingTransactionId, 'hex').reverse(), 0)
    transaction.addOutput(address.toOutputScript(recipient.identity, networks.bitcoin), 10_000)
    transaction.addOutput(address.toOutputScript(sender.identity, networks.bitcoin), 5_182)
    const transactionId = transaction.getId()
    const updater = new BitcoinOwnedTransactionBalanceUpdater({
      storageRepository: {
        getActivePointer: async () => pointer,
        getSnapshot: async () => snapshot
      },
      discoveryRepository: {
        get: async context => states.get(scopeKey(context.chainAccount)) ?? null,
        putRefresh: async refresh => {
          states.set(scopeKey(refresh.chainAccount), {
            chainAccount: refresh.chainAccount,
            accountIndex: refresh.accountIndex,
            checkpoint: refresh.checkpoint,
            observations: refresh.observations,
            updatedAt: refresh.updatedAt
          })
        }
      },
      chainId,
      now: () => 2_000,
      onUpdated: updatedScope => updates.push(updatedScope)
    })

    await expect(
      updater.applyBroadcast({
        scope: sender.chainAccount.scope,
        transactionId,
        rawTransactionHex: transaction.toHex(),
        spentOutpoints: [{ transactionId: fundingTransactionId, outputIndex: 0 }]
      })
    ).resolves.toEqual({ matched: 2, updated: 2, errors: 0 })

    let senderState = states.get(scopeKey(sender.chainAccount))
    let recipientState = states.get(scopeKey(recipient.chainAccount))
    expect(senderState.updatedAt).toBe(2_000)
    expect(senderState.observations[0]).toMatchObject({
      activity: { confirmedTransactionCount: 1, mempoolTransactionCount: 1, used: true },
      utxos: [
        {
          transactionId: 'e'.repeat(64),
          outputIndex: 1,
          valueRaw: '31810',
          status: { confirmed: true }
        },
        {
          transactionId,
          outputIndex: 1,
          valueRaw: '5182',
          status: { confirmed: false }
        }
      ]
    })
    expect(
      senderState.observations[0].utxos.reduce((total, utxo) => total + BigInt(utxo.valueRaw), 0n)
    ).toBe(36_992n)
    expect(recipientState.updatedAt).toBe(2_000)
    expect(recipientState.observations[0]).toMatchObject({
      activity: { confirmedTransactionCount: 0, mempoolTransactionCount: 1, used: true },
      utxos: [
        {
          transactionId,
          outputIndex: 0,
          valueRaw: '10000',
          status: { confirmed: false }
        }
      ]
    })
    expect(updates).toEqual([sender.chainAccount.scope, recipient.chainAccount.scope])

    updates.length = 0
    await expect(
      updater.applyObservation({
        status: 'confirming',
        transactionId,
        blockHash: '1'.repeat(64),
        blockHeight: 963_719,
        confirmations: 1,
        requiredConfirmations: 6
      })
    ).resolves.toEqual({ matched: 2, updated: 2, errors: 0 })
    senderState = states.get(scopeKey(sender.chainAccount))
    recipientState = states.get(scopeKey(recipient.chainAccount))
    expect(senderState.observations[0].utxos[1].status).toEqual({
      confirmed: true,
      blockHeight: 963_719,
      blockHash: '1'.repeat(64)
    })
    expect(recipientState.observations[0].utxos[0].status).toEqual({
      confirmed: true,
      blockHeight: 963_719,
      blockHash: '1'.repeat(64)
    })

    await expect(
      updater.applyObservation({
        status: 'broadcast',
        transactionId,
        requiredConfirmations: 6
      })
    ).resolves.toEqual({ matched: 2, updated: 2, errors: 0 })
    senderState = states.get(scopeKey(sender.chainAccount))
    recipientState = states.get(scopeKey(recipient.chainAccount))
    expect(senderState.observations[0].utxos[1].status).toEqual({ confirmed: false })
    expect(recipientState.observations[0].utxos[0].status).toEqual({ confirmed: false })
  })
})
