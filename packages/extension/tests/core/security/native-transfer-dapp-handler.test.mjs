import { test } from 'node:test'
import { expect } from '@playwright/test'

import { BackgroundNativeTransferDAppHandler } from '../../../src/background/native-transfer-dapp-handler.ts'

const configs = [
  {
    providerId: 'solana',
    familyName: 'Solana',
    chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    chainName: 'Solana Devnet',
    address: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk',
    connectApprovalAction: 'solanaConnect'
  },
  {
    providerId: 'near',
    familyName: 'NEAR',
    chainId: 'near:testnet',
    chainName: 'NEAR Testnet',
    address: '00'.repeat(32),
    publicKey: `ed25519:${'1'.repeat(32)}`,
    connectApprovalAction: 'nearConnect'
  }
]

function harness(config, overrides = {}) {
  const { approvalSelectedIds, ...optionOverrides } = overrides
  let authorization = null
  let unlocked = true
  const approvalCalls = []
  const events = []
  const context = {
    chainAccount: {
      id: `chain-account:${config.providerId}:active`,
      scope: {
        keyDomainId: 'wallet-1',
        accountId: 'account-1',
        chainId: config.chainId
      },
      derivation: { scheme: 'slip10', path: 'm/test' },
      identity: { kind: 'account-identifier', value: config.address },
      createdAt: 1
    },
    accountIndex: 0,
    keyDomainSource: { kind: 'software', mnemonicWordCount: 24 },
    ...(config.publicKey === undefined ? {} : { publicKey: config.publicKey })
  }
  const manager = {
    async getAllConnections() {
      return authorization
        ? [{ origin: 'https://dapp.example', chainAuthorizations: [authorization] }]
        : []
    },
    async getChainAuthorization() {
      return authorization
    },
    async setChainAuthorizedAccounts(_origin, _tabInfo, chainId, accounts, binding) {
      authorization = { chainId, accounts, binding }
    },
    async removeChainAuthorization() {
      authorization = null
    }
  }
  const approval = {
    async requestExternalApproval(origin, action, data) {
      approvalCalls.push({ origin, action, data })
      return {
        approved: true,
        requestId: action,
        ...(approvalSelectedIds === undefined ? {} : { selectedIds: approvalSelectedIds })
      }
    },
    async broadcastProviderEvent(origin, chainId, eventName, data) {
      events.push({ origin, chainId, eventName, data })
    },
    cancelPendingApprovals() {
      return 1
    }
  }
  const options = {
    ...config,
    manager,
    approval,
    loadActiveContext: async () => context,
    hasUnlockSession: async () => unlocked,
    runActiveOperation: operation => operation(),
    parseAddress: value => value,
    ...optionOverrides
  }
  return {
    handler: new BackgroundNativeTransferDAppHandler(options),
    approvalCalls,
    events,
    manager,
    setUnlocked(value) {
      unlocked = value
    }
  }
}

for (const config of configs) {
  test.describe(`${config.familyName} dApp handler`, () => {
    test('authorizes and returns only the connected account', async () => {
      const state = harness(config)
      await expect(
        state.handler.request({ method: 'getAccounts' }, 'https://dapp.example', {})
      ).resolves.toEqual([])
      await expect(
        state.handler.request({ method: 'connect' }, 'https://dapp.example', {
          title: 'DApp',
          favIconUrl: 'https://dapp.example/icon.png',
          pageUrl: 'https://dapp.example/swap'
        })
      ).resolves.toEqual({
        address: config.address,
        ...(config.publicKey === undefined ? {} : { publicKey: config.publicKey })
      })
      await expect(
        state.handler.request({ method: 'getAccounts' }, 'https://dapp.example', {})
      ).resolves.toEqual([config.address])
      expect(state.approvalCalls.map(call => call.action)).toEqual([config.connectApprovalAction])
      expect(state.approvalCalls[0].data.favicon).toBe('https://dapp.example/icon.png')
      expect(state.approvalCalls[0].data.faviconPageUrl).toBe('https://dapp.example/swap')
    })

    test('reuses an existing account authorization for a silent account request', async () => {
      const state = harness(config)
      await state.handler.request({ method: 'requestAccounts' }, 'https://dapp.example', {})
      await state.handler.request({ method: 'requestAccounts' }, 'https://dapp.example', {})
      expect(state.approvalCalls.map(call => call.action)).toEqual([config.connectApprovalAction])
    })

    test('persists and returns every account selected during explicit connect', async () => {
      const currentId = JSON.stringify(['wallet-1', 'account-1'])
      const secondId = JSON.stringify(['wallet-2', 'account-2'])
      const secondAddress =
        config.providerId === 'solana'
          ? '7gyGAp71YXQRoxmFBaHxofQXAipvgHyBKPyfUFJVDZzR'
          : 'second.testnet'
      const state = harness(config, {
        approvalSelectedIds: [currentId, secondId],
        listAccounts: async () => [
          {
            id: currentId,
            label: 'Wallet 1 · Account 1',
            reference: { walletId: 'wallet-1', accountId: 'account-1' },
            address: config.address
          },
          {
            id: secondId,
            label: 'Wallet 2 · Account 2',
            reference: { walletId: 'wallet-2', accountId: 'account-2' },
            address: secondAddress
          }
        ]
      })

      await state.handler.request({ method: 'connect' }, 'https://dapp.example', {})
      await expect(
        state.handler.request({ method: 'getAccounts' }, 'https://dapp.example', {})
      ).resolves.toEqual([config.address, secondAddress])
      expect(state.approvalCalls[0].data.accounts[0].required).toBe(true)
    })

    test('hides accounts while locked and broadcasts revocation on disconnect', async () => {
      const state = harness(config)
      await state.handler.request({ method: 'connect' }, 'https://dapp.example', {})
      state.setUnlocked(false)
      await expect(
        state.handler.request({ method: 'getAccounts' }, 'https://dapp.example', {})
      ).resolves.toEqual([])
      state.setUnlocked(true)
      await state.handler.request({ method: 'disconnect' }, 'https://dapp.example', {})
      expect(state.events.at(-1)).toEqual({
        origin: 'https://dapp.example',
        chainId: config.providerId,
        eventName: 'accountsChanged',
        data: []
      })
    })
  })
}
