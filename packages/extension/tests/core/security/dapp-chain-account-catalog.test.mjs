import { test } from 'node:test'
import { expect } from '@playwright/test'

import { listDAppChainAccounts } from '../../../src/background/dapp-chain-account-catalog.ts'

test('lists every supported stored account with a stable wallet and account label', async () => {
  const pointer = {
    generationId: 'generation-1',
    sourceFingerprint: 'fingerprint-1'
  }
  const snapshot = {
    manifest: {
      status: 'verified',
      generationId: pointer.generationId,
      sourceFingerprint: pointer.sourceFingerprint
    },
    keyDomains: [
      {
        id: 'wallet-1',
        credentialRef: 'credential-1',
        source: { kind: 'software', mnemonicWordCount: 24 },
        displayName: 'Wallet 1787031492044',
        createdAt: 1
      },
      {
        id: 'wallet-2',
        credentialRef: 'credential-2',
        source: {
          kind: 'private-key',
          chainFamily: 'eip155'
        },
        displayName: 'Imported EVM',
        createdAt: 2
      }
    ],
    accounts: [
      {
        id: 'account-1',
        keyDomainId: 'wallet-1',
        accountIndex: 0,
        displayName: 'Account_0_1788141400000',
        createdAt: 1
      },
      {
        id: 'account-2',
        keyDomainId: 'wallet-2',
        accountIndex: 0,
        displayName: 'Trading',
        createdAt: 2
      }
    ],
    chainAccounts: [
      {
        id: 'evm-1',
        scope: { keyDomainId: 'wallet-1', accountId: 'account-1', chainId: 'eip155:1' },
        derivation: { scheme: 'bip44', path: "m/44'/60'/0'/0/0" },
        identity: {
          kind: 'account-identifier',
          value: '0x1111111111111111111111111111111111111111'
        },
        createdAt: 1
      },
      {
        id: 'evm-2',
        scope: { keyDomainId: 'wallet-2', accountId: 'account-2', chainId: 'eip155:1' },
        derivation: { scheme: 'imported', path: 'm' },
        identity: {
          kind: 'account-identifier',
          value: '0x2222222222222222222222222222222222222222'
        },
        createdAt: 2
      }
    ],
    addresses: []
  }
  const accounts = await listDAppChainAccounts({
    repository: {
      getActivePointer: async () => pointer,
      getSnapshot: async () => snapshot
    },
    chainId: 'eip155:1',
    family: 'evm',
    resolveAddress: ({ chainAccount }) => chainAccount.identity.value.toLowerCase()
  })

  expect(accounts).toEqual([
    {
      id: JSON.stringify(['wallet-1', 'account-1']),
      label: 'Wallet 1 · Account 1',
      reference: { walletId: 'wallet-1', accountId: 'account-1' },
      address: '0x1111111111111111111111111111111111111111'
    },
    {
      id: JSON.stringify(['wallet-2', 'account-2']),
      label: 'Imported EVM · Trading',
      reference: { walletId: 'wallet-2', accountId: 'account-2' },
      address: '0x2222222222222222222222222222222222222222'
    }
  ])
})
