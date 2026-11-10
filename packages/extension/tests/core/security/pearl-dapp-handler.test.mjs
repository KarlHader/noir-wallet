import { test } from 'node:test'
import { expect } from '@playwright/test'

import { BackgroundPearlDAppHandler } from '../../../src/background/pearl-dapp-handler.ts'
import { PEARL_NETWORKS } from '../../../src/config/networks.ts'

const address = 'prl1pqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'
const publicKey = `0x02${'22'.repeat(32)}`
const chainId = PEARL_NETWORKS.mainnet.chainId

function activeContext(overrides = {}) {
  return {
    generationId: 'storage-v2-generation:1',
    chainAccount: {
      id: 'chain-account:pearl:1',
      scope: { keyDomainId: 'wallet-1', accountId: 'account-1', chainId },
      derivation: { scheme: 'bip86', path: "m/86'/808276'/0'" },
      identity: { kind: 'account-identifier', value: address },
      createdAt: 1_700_000_000_000
    },
    accountIndex: 0,
    keyDomainSource: { kind: 'software', mnemonicWordCount: 24 },
    ...overrides
  }
}

function messageSummary(summaryAddress = address) {
  return {
    schema: 'pearl.bip322-message.v1',
    chainId,
    operation: 'message',
    review: { level: 'standard', issues: [] },
    fields: {
      address: summaryAddress,
      message: {
        encoding: 'utf8',
        value: 'hello',
        byteLength: 5,
        sha256: '00'.repeat(32)
      }
    }
  }
}

function utxo(valueSats, confirmed) {
  return {
    transactionId: '11'.repeat(32),
    outputIndex: 0,
    valueSats,
    address,
    status: confirmed
      ? { confirmed: true, blockHeight: 100 }
      : { confirmed: false }
  }
}

function harness(overrides = {}) {
  const { approvalSelectedIds, confirmResult, summaryAddress, ...optionOverrides } = overrides
  let authorization = null
  let unlocked = true
  let rejectApproval = false
  let context = activeContext()
  const approvalCalls = []
  const events = []
  const cancelledCommands = []
  const manager = {
    async getAllConnections() {
      return authorization
        ? [{ origin: 'https://dapp.example', chainAuthorizations: [authorization] }]
        : []
    },
    async getChainAuthorization() {
      return authorization
    },
    async setChainAuthorizedAccounts(_origin, _tabInfo, authorizedChainId, accounts, binding) {
      authorization = { chainId: authorizedChainId, accounts, binding }
    },
    async removeChainAuthorization() {
      authorization = null
    }
  }
  const approval = {
    async requestExternalApproval(origin, action, data) {
      approvalCalls.push({ origin, action, data })
      return {
        approved: !rejectApproval,
        requestId: `approval-${approvalCalls.length}`,
        ...(approvalSelectedIds === undefined ? {} : { selectedIds: approvalSelectedIds })
      }
    },
    async broadcastProviderEvent(origin, eventChainId, eventName, data) {
      events.push({ origin, chainId: eventChainId, eventName, data })
    },
    cancelPendingApprovals(origin, eventChainId) {
      events.push({ origin, chainId: eventChainId, eventName: 'cancelPending' })
      return 1
    }
  }
  const signer = {
    async prepare(_keyDomainId, payload) {
      return {
        commandId: 'signing-command:pearl-message',
        chainId: payload.chainId,
        operation: 'message',
        summary: messageSummary(summaryAddress),
        payloadFingerprint: { algorithm: 'sha256', digestHex: '11'.repeat(32) },
        execution: { kind: 'internal' },
        expiresAt: Date.now() + 60_000
      }
    },
    async confirm() {
      return (
        confirmResult ?? {
          kind: 'signature',
          signature: { encoding: 'base64', value: 'c2lnbmF0dXJl' },
          publicKey,
          address
        }
      )
    },
    async cancel(_keyDomainId, commandId) {
      cancelledCommands.push(commandId)
    }
  }
  const options = {
    network: PEARL_NETWORKS.mainnet,
    manager,
    approval,
    loadActiveContext: async () => context,
    hasUnlockSession: async () => unlocked,
    runActiveOperation: operation => operation(),
    transferController: null,
    derivation: {
      deriveAddress: async () => ({ address, publicKey })
    },
    signer,
    discoveryRepository: {
      async get() {
        return {
          checkpoint: {},
          updatedAt: 1,
          observations: [
            { derived: {}, activity: {}, utxos: [utxo('1000', true), utxo('250', false)] }
          ]
        }
      }
    },
    rpc: {
      async broadcastRawTransaction() {
        throw new Error('Pearl broadcast stub was not configured')
      }
    },
    ...optionOverrides
  }
  return {
    handler: new BackgroundPearlDAppHandler(options),
    approvalCalls,
    events,
    cancelledCommands,
    getAuthorization: () => authorization,
    setUnlocked: value => {
      unlocked = value
    },
    setReject: value => {
      rejectApproval = value
    },
    setContext: value => {
      context = value
    }
  }
}

test.describe('Background Pearl dApp handler', () => {
  test('grants chain-scoped access with the Pearl account state', async () => {
    const state = harness()
    await expect(state.handler.getActiveWalletIdentity()).resolves.toEqual({
      chainId,
      address,
      publicKey: publicKey.slice(2)
    })
    await expect(
      state.handler.request({ method: 'getAccounts' }, 'https://dapp.example', {})
    ).resolves.toEqual([])
    await expect(
      state.handler.request({ method: 'connect' }, 'https://dapp.example', {
        title: 'DApp',
        favIconUrl: 'https://dapp.example/icon.png',
        pageUrl: 'https://dapp.example/swap'
      })
    ).resolves.toEqual({ address, publicKey: publicKey.slice(2) })
    expect(state.approvalCalls[0].action).toBe('pearlConnect')
    expect(state.getAuthorization()).toMatchObject({ chainId })

    await expect(
      state.handler.request({ method: 'getPublicKey' }, 'https://dapp.example', {})
    ).resolves.toBe(publicKey.slice(2))
    await expect(
      state.handler.request({ method: 'getBalance' }, 'https://dapp.example', {})
    ).resolves.toEqual({ confirmed: 1000, unconfirmed: 250, total: 1250 })
    await expect(
      state.handler.request({ method: 'getNetwork' }, 'https://dapp.example', {})
    ).resolves.toBe('mainnet')
    await expect(
      state.handler.request({ method: 'getChain' }, 'https://dapp.example', {})
    ).resolves.toEqual({ enum: 'PEARL_MAINNET', name: 'Pearl', network: 'mainnet' })
    await expect(
      state.handler.request({ method: 'switchNetwork', params: ['mainnet'] }, 'https://dapp.example', {})
    ).resolves.toBeNull()
    await expect(
      state.handler.request({ method: 'switchNetwork', params: ['testnet'] }, 'https://dapp.example', {})
    ).rejects.toMatchObject({ code: 4901 })

    await expect(
      state.handler.request({ method: 'disconnect' }, 'https://dapp.example', {})
    ).resolves.toBeNull()
    expect(state.getAuthorization()).toBeNull()
    expect(state.events).toContainEqual({
      origin: 'https://dapp.example',
      chainId: 'pearl',
      eventName: 'accountsChanged',
      data: []
    })
  })

  test('requires an unlock session and an authorized account for signing', async () => {
    const state = harness()
    state.setUnlocked(false)
    await expect(
      state.handler.request({ method: 'connect' }, 'https://dapp.example', {})
    ).rejects.toMatchObject({ code: 4100 })
    state.setUnlocked(true)
    await expect(
      state.handler.request(
        { method: 'signMessage', params: ['hello'] },
        'https://dapp.example',
        {}
      )
    ).rejects.toMatchObject({ code: 4100 })
  })

  test('signs an approved BIP-322 message after rechecking the account', async () => {
    const state = harness()
    await state.handler.request({ method: 'connect' }, 'https://dapp.example', {})
    await expect(
      state.handler.request(
        { method: 'signMessage', params: ['hello', 'bip322-simple'] },
        'https://dapp.example',
        {}
      )
    ).resolves.toBe('c2lnbmF0dXJl')
    expect(state.approvalCalls.at(-1).action).toBe('pearlMessage')
    expect(state.cancelledCommands).toEqual([])
  })

  test('rejects unsupported signature types and invalid parameters', async () => {
    const state = harness()
    await state.handler.request({ method: 'connect' }, 'https://dapp.example', {})
    await expect(
      state.handler.request(
        { method: 'signMessage', params: ['hello', 'ecdsa'] },
        'https://dapp.example',
        {}
      )
    ).rejects.toMatchObject({ code: 4200 })
    await expect(
      state.handler.request({ method: 'signMessage', params: [] }, 'https://dapp.example', {})
    ).rejects.toMatchObject({ code: -32602 })
    await expect(
      state.handler.request({ method: 'getAccounts', params: ['extra'] }, 'https://dapp.example', {})
    ).rejects.toMatchObject({ code: -32602 })
  })

  test('does not sign when the user rejects the approval', async () => {
    const state = harness()
    await state.handler.request({ method: 'connect' }, 'https://dapp.example', {})
    state.setReject(true)
    await expect(
      state.handler.request({ method: 'signMessage', params: ['hello'] }, 'https://dapp.example', {})
    ).rejects.toMatchObject({ code: 4001 })
    expect(state.cancelledCommands).toEqual(['signing-command:pearl-message'])
  })

  test('cancels the prepared signature when the account changes mid-approval', async () => {
    const state = harness()
    await state.handler.request({ method: 'connect' }, 'https://dapp.example', {})
    const realApproval = state.handler.options.approval
    realApproval.requestExternalApproval = async (origin, action, data) => {
      state.setContext(activeContext({ chainAccount: {
        ...activeContext().chainAccount,
        id: 'chain-account:pearl:2',
        scope: { keyDomainId: 'wallet-1', accountId: 'account-2', chainId }
      } }))
      return { approved: true, requestId: 'approval-changed' }
    }
    await expect(
      state.handler.request({ method: 'signMessage', params: ['hello'] }, 'https://dapp.example', {})
    ).rejects.toMatchObject({ code: 4100 })
    expect(state.cancelledCommands).toEqual(['signing-command:pearl-message'])
  })

  test('refuses hardware accounts and mismatched signing summaries', async () => {
    const hardware = harness()
    await hardware.handler.request({ method: 'connect' }, 'https://dapp.example', {})
    hardware.setContext(
      activeContext({ keyDomainSource: { kind: 'hardware', vendor: 'ledger' } })
    )
    await expect(
      hardware.handler.request({ method: 'signMessage', params: ['hello'] }, 'https://dapp.example', {})
    ).rejects.toMatchObject({ code: 4200 })

    const mismatched = harness({ summaryAddress: 'tprl1pqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq' })
    await mismatched.handler.request({ method: 'connect' }, 'https://dapp.example', {})
    await expect(
      mismatched.handler.request({ method: 'signMessage', params: ['hello'] }, 'https://dapp.example', {})
    ).rejects.toMatchObject({ code: 4100 })
    expect(mismatched.cancelledCommands).toEqual(['signing-command:pearl-message'])
  })

  test('rejects a signature that does not match the authorized account', async () => {
    const state = harness({
      confirmResult: {
        kind: 'signature',
        signature: { encoding: 'base64', value: 'c2lnbmF0dXJl' },
        publicKey: `0x03${'33'.repeat(32)}`,
        address
      }
    })
    await state.handler.request({ method: 'connect' }, 'https://dapp.example', {})
    await expect(
      state.handler.request({ method: 'signMessage', params: ['hello'] }, 'https://dapp.example', {})
    ).rejects.toMatchObject({ code: -32603 })
  })

  test('keeps sendPearl closed when the transfer controller is unavailable', async () => {
    const state = harness()
    await state.handler.request({ method: 'connect' }, 'https://dapp.example', {})
    await expect(
      state.handler.request(
        { method: 'sendPearl', params: [address, 1000] },
        'https://dapp.example',
        {}
      )
    ).rejects.toMatchObject({ code: 4200 })
  })

  test('rejects malformed spend and broadcast requests', async () => {
    const state = harness()
    await state.handler.request({ method: 'connect' }, 'https://dapp.example', {})
    await expect(
      state.handler.request({ method: 'signPsbt', params: ['00'] }, 'https://dapp.example', {})
    ).rejects.toMatchObject({ code: -32602 })
    await expect(
      state.handler.request({ method: 'pushPsbt', params: ['00'] }, 'https://dapp.example', {})
    ).rejects.toMatchObject({ code: -32602 })
    await expect(
      state.handler.request(
        { method: 'pushTx', params: [{ rawtx: 'xyz' }] },
        'https://dapp.example',
        {}
      )
    ).rejects.toMatchObject({ code: -32602 })
    await expect(
      state.handler.request(
        { method: 'pushPsbt', params: ['70736274ff0100'] },
        'https://dapp.example',
        {}
      )
    ).rejects.toMatchObject({ code: -32602 })
  })

  test('refuses hardware accounts for sendPearl and signPsbt', async () => {
    const state = harness({
      transferController: {
        prepare: async () => {
          throw new Error('prepare should not run for hardware accounts')
        }
      }
    })
    await state.handler.request({ method: 'connect' }, 'https://dapp.example', {})
    state.setContext(activeContext({ keyDomainSource: { kind: 'hardware', vendor: 'ledger' } }))
    await expect(
      state.handler.request(
        { method: 'sendPearl', params: [address, 1000] },
        'https://dapp.example',
        {}
      )
    ).rejects.toMatchObject({ code: 4200 })
    await expect(
      state.handler.request(
        { method: 'signPsbt', params: ['70736274ff0100'] },
        'https://dapp.example',
        {}
      )
    ).rejects.toMatchObject({ code: 4200 })
  })
})
