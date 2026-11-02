import { test } from 'node:test'
import { expect } from '@playwright/test'

import { BackgroundBitcoinDAppHandler } from '../../../src/background/bitcoin-dapp-handler.ts'
import { BITCOIN_NETWORKS } from '../../../src/config/networks.ts'
import { networks, payments, Psbt, Transaction } from 'bitcoinjs-lib'

const address = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
const publicKey = `0x02${'22'.repeat(32)}`
const account = {
  generationId: 'storage-v2-generation:1',
  chainAccount: {
    id: 'chain-account:bitcoin:1',
    scope: {
      keyDomainId: 'wallet-1',
      accountId: 'account-1',
      chainId: BITCOIN_NETWORKS.mainnet.chainId
    },
    derivation: { scheme: 'bip84', path: "m/84'/0'/0'" },
    identity: { kind: 'account-identifier', value: address },
    createdAt: 1_700_000_000_000
  },
  accountIndex: 0,
  keyDomainSource: { kind: 'software', mnemonicWordCount: 24 }
}

function signingSummary(kind) {
  if (kind === 'bitcoin-bip322-message') {
    return {
      schema: 'bitcoin.bip322-message.v1',
      chainId: account.chainAccount.scope.chainId,
      operation: 'message',
      review: { level: 'standard', issues: [] },
      fields: {
        address,
        message: {
          encoding: 'utf8',
          value: 'hello',
          byteLength: 5,
          sha256: '00'.repeat(32)
        }
      }
    }
  }
  return {
    schema: 'bitcoin.psbt.v1',
    chainId: account.chainAccount.scope.chainId,
    operation: 'transaction',
    review: { level: 'standard', issues: [] },
    fields: {
      psbtVersion: 0,
      signer: address,
      inputs: [],
      outputs: [],
      signingInputIndexes: [0],
      totalInputSats: '1000',
      totalOutputSats: '900',
      feeSats: '100'
    }
  }
}

function harness(overrides = {}) {
  const { approvalSelectedIds, ...optionOverrides } = overrides
  let authorization = null
  let unlocked = true
  const approvalCalls = []
  const events = []
  const cancelledApprovalChains = []
  const preparedTransfers = []
  const rejectedTransfers = []
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
        requestId: `approval-${approvalCalls.length}`,
        ...(approvalSelectedIds === undefined ? {} : { selectedIds: approvalSelectedIds })
      }
    },
    async broadcastProviderEvent(origin, chainId, eventName, data) {
      events.push({ origin, chainId, eventName, data })
    },
    cancelPendingApprovals(origin, chainId) {
      cancelledApprovalChains.push({ origin, chainId })
      return 1
    }
  }
  const signer = {
    async prepare(_keyDomainId, payload) {
      return {
        commandId: `signing-command:${payload.kind}`,
        chainId: payload.chainId,
        operation: payload.kind === 'bitcoin-psbt' ? 'transaction' : 'message',
        summary: signingSummary(payload.kind),
        payloadFingerprint: { algorithm: 'sha256', digestHex: '11'.repeat(32) },
        execution: { kind: 'internal' },
        expiresAt: Date.now() + 60_000
      }
    },
    async confirm(_keyDomainId, commandId) {
      if (commandId.endsWith('bitcoin-psbt')) {
        return {
          kind: 'signed-payload',
          payload: { encoding: 'base64', value: 'cHNidP8A' },
          transactionId: '22'.repeat(32)
        }
      }
      return {
        kind: 'signature',
        signature: { encoding: 'utf8', value: 'smp-noir-signature' },
        publicKey,
        address
      }
    },
    async cancel(_keyDomainId, commandId) {
      cancelledCommands.push(commandId)
    }
  }
  const transferController = {
    async prepare(intent) {
      preparedTransfers.push(intent)
      return {
        graph: { root: { id: 'transaction:bitcoin:dapp-1' } },
        review: {
          chainId: account.chainAccount.scope.chainId,
          operation: 'transaction',
          summary: signingSummary('bitcoin-psbt'),
          payloadFingerprint: { algorithm: 'sha256', digestHex: '33'.repeat(32) },
          expiresAt: Date.now() + 60_000
        }
      }
    },
    async approveForDApp(transactionId, _payloadFingerprint, authorize) {
      await authorize(account)
      return {
        status: 'broadcast',
        graph: {
          root: { id: transactionId },
          segments: [{ role: 'origin', evidence: { transactionHash: '44'.repeat(32) } }]
        }
      }
    },
    async reject(transactionId) {
      rejectedTransfers.push(transactionId)
    }
  }
  const options = {
    network: BITCOIN_NETWORKS.mainnet,
    manager,
    approval,
    loadActiveContext: async () => account,
    hasUnlockSession: async () => unlocked,
    runActiveOperation: operation => operation(),
    getAddressType: async () => 'p2wpkh',
    transferController,
    derivation: {
      deriveAddress: async () => ({ address, publicKey })
    },
    signer,
    rpc: { broadcastRawTransaction: async () => '55'.repeat(32) },
    portfolio: {
      refreshActiveSource: async () => ({
        generationId: account.generationId,
        chainAccount: account.chainAccount,
        source: {
          chainAccount: account.chainAccount,
          status: 'ready',
          balances: [
            {
              totalRaw: '1250',
              spendableRaw: '1000',
              availableRaw: '900',
              pendingRaw: '250'
            }
          ]
        }
      })
    },
    ...optionOverrides
  }
  return {
    handler: new BackgroundBitcoinDAppHandler(options),
    approvalCalls,
    events,
    cancelledApprovalChains,
    manager,
    preparedTransfers,
    rejectedTransfers,
    cancelledCommands,
    getAuthorization: () => authorization,
    setUnlocked: value => {
      unlocked = value
    }
  }
}

test.describe('Background Bitcoin dApp handler', () => {
  test('grants chain-scoped access and returns the BIP-84 account state', async () => {
    const state = harness()
    await expect(state.handler.getActiveWalletIdentity()).resolves.toEqual({
      chainId: BITCOIN_NETWORKS.mainnet.chainId,
      address,
      publicKey,
      addressType: 'p2wpkh'
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
    await expect(
      state.handler.request({ method: 'getPublicKey' }, 'https://dapp.example', {})
    ).resolves.toBe(publicKey.slice(2))
    await expect(
      state.handler.request({ method: 'getBalance' }, 'https://dapp.example', {})
    ).resolves.toEqual({ confirmed: 1000, unconfirmed: 250, total: 1250 })
    await expect(
      state.handler.request({ method: 'getNetwork' }, 'https://dapp.example', {})
    ).resolves.toBe('livenet')
    expect(state.approvalCalls.map(call => call.action)).toEqual(['bitcoinConnect'])
    expect(state.approvalCalls[0].data.favicon).toBe('https://dapp.example/icon.png')
    expect(state.approvalCalls[0].data.faviconPageUrl).toBe('https://dapp.example/swap')
    expect(state.getAuthorization()).toMatchObject({
      chainId: BITCOIN_NETWORKS.mainnet.chainId,
      accounts: [{ walletId: 'wallet-1', accountId: 'account-1' }]
    })
  })

  test('persists and returns every explicitly selected Bitcoin account', async () => {
    const secondAddress = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'
    const currentId = JSON.stringify(['wallet-1', 'account-1'])
    const secondId = JSON.stringify(['wallet-2', 'account-2'])
    const state = harness({
      approvalSelectedIds: [currentId, secondId],
      listAccounts: async () => [
        {
          id: currentId,
          label: 'Wallet 1 · Account 1',
          reference: { walletId: 'wallet-1', accountId: 'account-1' },
          address
        },
        {
          id: secondId,
          label: 'Wallet 2 · Account 2',
          reference: { walletId: 'wallet-2', accountId: 'account-2' },
          address: secondAddress
        }
      ]
    })

    await expect(
      state.handler.request({ method: 'requestAccounts' }, 'https://dapp.example', {})
    ).resolves.toEqual([address, secondAddress])
    await expect(
      state.handler.request({ method: 'getAccounts' }, 'https://dapp.example', {})
    ).resolves.toEqual([address, secondAddress])
    expect(state.getAuthorization()).toEqual({
      chainId: BITCOIN_NETWORKS.mainnet.chainId,
      accounts: [
        { walletId: 'wallet-1', accountId: 'account-1' },
        { walletId: 'wallet-2', accountId: 'account-2' }
      ],
      binding: { walletId: 'wallet-1', accountId: 'account-1' }
    })
    expect(state.approvalCalls[0].data.accounts[0].required).toBe(true)
  })

  test('does not persist a connection approved after the active Account changed', async () => {
    const changedAccount = {
      ...account,
      chainAccount: {
        ...account.chainAccount,
        id: 'chain-account:bitcoin:2',
        scope: { ...account.chainAccount.scope, accountId: 'account-2' },
        derivation: { scheme: 'bip84', path: "m/84'/0'/1'" }
      },
      accountIndex: 1
    }
    let active = account
    const state = harness({
      loadActiveContext: async () => active,
      runActiveOperation: async operation => {
        active = changedAccount
        return operation()
      }
    })

    await expect(
      state.handler.request({ method: 'requestAccounts' }, 'https://dapp.example', {})
    ).rejects.toMatchObject({ code: 4100 })
    expect(state.getAuthorization()).toBeNull()
  })

  test('revokes only Bitcoin permission after persistence and cancels its approvals', async () => {
    const state = harness()
    await state.handler.request({ method: 'requestAccounts' }, 'https://dapp.example', {})

    await expect(
      state.handler.request({ method: 'disconnect' }, 'https://dapp.example', {})
    ).resolves.toBeNull()
    expect(state.getAuthorization()).toBeNull()
    expect(state.cancelledApprovalChains).toEqual([
      { origin: 'https://dapp.example', chainId: 'bitcoin' }
    ])
    expect(state.events.at(-1)).toEqual({
      origin: 'https://dapp.example',
      chainId: 'bitcoin',
      eventName: 'accountsChanged',
      data: []
    })
  })

  test('keeps Bitcoin permission and approval state when revoke persistence fails', async () => {
    const state = harness()
    await state.handler.request({ method: 'requestAccounts' }, 'https://dapp.example', {})
    state.manager.removeChainAuthorization = async () => {
      throw new Error('storage unavailable')
    }

    await expect(
      state.handler.request({ method: 'disconnect' }, 'https://dapp.example', {})
    ).rejects.toThrow('storage unavailable')
    expect(state.getAuthorization()).not.toBeNull()
    expect(state.cancelledApprovalChains).toEqual([])
    expect(state.events).toEqual([])
  })

  test('does not expose the internal Bitcoin identity while the wallet is locked', async () => {
    const state = harness()
    state.setUnlocked(false)
    await expect(state.handler.getActiveWalletIdentity()).rejects.toThrow(/unlock/i)
  })

  test('exposes Keystone public account data but fails closed before any dApp signing reservation', async () => {
    const hardwareAccount = {
      ...account,
      keyDomainSource: {
        kind: 'hardware',
        vendor: 'keystone',
        firmwareProfile: 'multi-coin',
        capabilities: ['bitcoin', 'evm']
      }
    }
    const state = harness({ loadActiveContext: async () => hardwareAccount })
    await expect(
      state.handler.request({ method: 'requestAccounts' }, 'https://dapp.example', {})
    ).resolves.toEqual([address])
    await expect(
      state.handler.request(
        { method: 'signMessage', params: ['hello', 'bip322-simple'] },
        'https://dapp.example',
        { pageUrl: 'https://dapp.example/sign' }
      )
    ).rejects.toMatchObject({ code: 4200 })
    await expect(
      state.handler.request(
        { method: 'sendBitcoin', params: [address, 42] },
        'https://dapp.example',
        { pageUrl: 'https://dapp.example/send' }
      )
    ).rejects.toMatchObject({ code: 4200 })
    expect(state.preparedTransfers).toEqual([])
    expect(state.cancelledCommands).toEqual([])
  })

  test('requires independent approvals for BIP-322 messages and Bitcoin sends', async () => {
    const state = harness()
    await state.handler.request({ method: 'requestAccounts' }, 'https://dapp.example', {})

    await expect(
      state.handler.request(
        { method: 'signMessage', params: ['hello', 'bip322-simple'] },
        'https://dapp.example',
        { pageUrl: 'https://dapp.example/sign' }
      )
    ).resolves.toBe('smp-noir-signature')
    await expect(
      state.handler.request(
        { method: 'sendBitcoin', params: [address, 42] },
        'https://dapp.example',
        { pageUrl: 'https://dapp.example/send' }
      )
    ).resolves.toBe('44'.repeat(32))
    expect(state.preparedTransfers).toEqual([
      { recipient: address, amount: { mode: 'exact', valueSats: '42' } }
    ])
    expect(state.approvalCalls.map(call => call.action)).toEqual([
      'bitcoinConnect',
      'bitcoinMessage',
      'bitcoinTransaction'
    ])
    expect(state.approvalCalls[1].data).toMatchObject({
      faviconPageUrl: 'https://dapp.example/sign'
    })
    expect(state.approvalCalls[2].data).toMatchObject({
      faviconPageUrl: 'https://dapp.example/send'
    })
  })

  test('re-prepares the Bitcoin transaction when the user changes the fee tier', async () => {
    const prepareCalls = []
    const rejected = []
    let approvedTransactionId = null
    let activeTransactionId = null
    const state = harness({
      approval: {
        async requestExternalApproval(_origin, action, data, options) {
          if (action === 'bitcoinTransaction') {
            const updated = await options.onNetworkFeeTierChange('fast')
            expect(updated.feeTier).toBe('fast')
            expect(updated.review).not.toBe(data.review)
          }
          return { approved: true, requestId: action }
        },
        async broadcastProviderEvent() {},
        cancelPendingApprovals() {
          return 0
        }
      },
      transferController: {
        async prepare(...args) {
          if (activeTransactionId !== null) {
            throw new Error('Bitcoin inputs are still reserved')
          }
          prepareCalls.push(args)
          const index = prepareCalls.length
          activeTransactionId = `transaction:bitcoin:fee-${index}`
          return {
            graph: { root: { id: activeTransactionId } },
            review: {
              chainId: account.chainAccount.scope.chainId,
              operation: 'transaction',
              summary: signingSummary('bitcoin-psbt'),
              payloadFingerprint: { algorithm: 'sha256', digestHex: `${index}`.repeat(64) },
              expiresAt: Date.now() + 60_000
            }
          }
        },
        async approveForDApp(transactionId, _fingerprint, authorize) {
          approvedTransactionId = transactionId
          await authorize(account)
          return {
            status: 'broadcast',
            graph: {
              root: { id: transactionId },
              segments: [{ role: 'origin', evidence: { transactionHash: '44'.repeat(32) } }]
            }
          }
        },
        async reject(transactionId) {
          rejected.push(transactionId)
          if (transactionId === activeTransactionId) activeTransactionId = null
        }
      }
    })
    await state.handler.request({ method: 'requestAccounts' }, 'https://dapp.example', {})
    await state.handler.request(
      { method: 'sendBitcoin', params: [address, 42] },
      'https://dapp.example',
      {}
    )

    expect(prepareCalls).toHaveLength(2)
    expect(prepareCalls[1][2]).toBe('fast')
    expect(rejected).toEqual(['transaction:bitcoin:fee-1'])
    expect(approvedTransactionId).toBe('transaction:bitcoin:fee-2')
  })

  test('releases a fee replacement prepared after its approval was rejected', async () => {
    const rejected = []
    let completePreparation
    let feeUpdateResult
    let prepareCount = 0
    const makeReview = id => ({
      graph: { root: { id } },
      review: {
        chainId: account.chainAccount.scope.chainId,
        operation: 'transaction',
        summary: signingSummary('bitcoin-psbt'),
        payloadFingerprint: { algorithm: 'sha256', digestHex: '44'.repeat(32) },
        expiresAt: Date.now() + 60_000
      }
    })
    const state = harness({
      approval: {
        async requestExternalApproval(_origin, action, _data, options) {
          if (action === 'bitcoinTransaction') {
            feeUpdateResult = options.onNetworkFeeTierChange('fast').then(
              () => null,
              error => error
            )
            return { approved: false, requestId: action }
          }
          return { approved: true, requestId: action }
        },
        async broadcastProviderEvent() {},
        cancelPendingApprovals() {
          return 0
        }
      },
      transferController: {
        async prepare() {
          prepareCount += 1
          if (prepareCount === 1) return makeReview('transaction:bitcoin:original')
          return new Promise(resolve => {
            completePreparation = () => resolve(makeReview('transaction:bitcoin:replacement'))
          })
        },
        async reject(transactionId) {
          rejected.push(transactionId)
        }
      }
    })
    await state.handler.request({ method: 'requestAccounts' }, 'https://dapp.example', {})
    await expect(
      state.handler.request(
        { method: 'sendBitcoin', params: [address, 42] },
        'https://dapp.example',
        {}
      )
    ).rejects.toMatchObject({ code: 4001 })

    completePreparation()
    expect((await feeUpdateResult).message).toBe('Approval request is no longer active')
    expect(rejected).toContain('transaction:bitcoin:replacement')
  })

  test('passes a standard custom fee rate into Bitcoin transaction preparation', async () => {
    const prepareCalls = []
    const state = harness({
      transferController: {
        async prepare(...args) {
          prepareCalls.push(args)
          return {
            graph: { root: { id: 'transaction:bitcoin:dapp-fee' } },
            review: {
              chainId: account.chainAccount.scope.chainId,
              operation: 'transaction',
              summary: signingSummary('bitcoin-psbt'),
              payloadFingerprint: { algorithm: 'sha256', digestHex: '33'.repeat(32) },
              expiresAt: Date.now() + 60_000
            }
          }
        },
        async approveForDApp(transactionId, _payloadFingerprint, authorize) {
          await authorize(account)
          return {
            status: 'broadcast',
            graph: {
              root: { id: transactionId },
              segments: [{ role: 'origin', evidence: { transactionHash: '44'.repeat(32) } }]
            }
          }
        },
        async reject() {}
      }
    })
    await state.handler.request({ method: 'requestAccounts' }, 'https://dapp.example', {})
    await state.handler.request(
      { method: 'sendBitcoin', params: [address, 42, { feeRate: 7 }] },
      'https://dapp.example',
      {}
    )
    expect(prepareCalls[0][4]).toBe(7)
  })

  test('rejects and releases a prepared send when permission is revoked after approval', async () => {
    let state
    state = harness({
      approval: {
        async requestExternalApproval(_origin, action) {
          if (action === 'bitcoinTransaction') await state.manager.removeChainAuthorization()
          return { approved: true, requestId: action }
        },
        async broadcastProviderEvent() {},
        cancelPendingApprovals() {
          return 0
        }
      }
    })
    await state.handler.request({ method: 'requestAccounts' }, 'https://dapp.example', {})

    await expect(
      state.handler.request(
        { method: 'sendBitcoin', params: [address, 42] },
        'https://dapp.example',
        {}
      )
    ).rejects.toMatchObject({ code: 4100 })
    expect(state.rejectedTransfers).toEqual(['transaction:bitcoin:dapp-1'])
  })

  test('cancels an approved message command when the active Account changed', async () => {
    const changedAccount = {
      ...account,
      chainAccount: {
        ...account.chainAccount,
        id: 'chain-account:bitcoin:2',
        scope: { ...account.chainAccount.scope, accountId: 'account-2' },
        derivation: { scheme: 'bip84', path: "m/84'/0'/1'" }
      },
      accountIndex: 1
    }
    let active = account
    const state = harness({
      loadActiveContext: async () => active,
      approval: {
        requestExternalApproval: async (_origin, action) => {
          if (action === 'bitcoinMessage') active = changedAccount
          return { approved: true, requestId: action }
        },
        broadcastProviderEvent: async () => {}
      }
    })
    await state.handler.request({ method: 'requestAccounts' }, 'https://dapp.example', {})

    await expect(
      state.handler.request(
        { method: 'signMessage', params: ['hello', 'bip322-simple'] },
        'https://dapp.example',
        {}
      )
    ).rejects.toMatchObject({ code: 4100 })
    expect(state.cancelledCommands).toEqual(['signing-command:bitcoin-bip322-message'])
  })

  test('does not return a signature when the unlock session ends during confirmation', async () => {
    let unlocked = true
    const cancelledCommands = []
    const state = harness({
      hasUnlockSession: async () => unlocked,
      signer: {
        prepare: async (_keyDomainId, payload) => ({
          commandId: 'signing-session-ended',
          chainId: payload.chainId,
          operation: 'message',
          summary: signingSummary(payload.kind),
          payloadFingerprint: { algorithm: 'sha256', digestHex: '11'.repeat(32) },
          execution: { kind: 'internal' },
          expiresAt: Date.now() + 60_000
        }),
        confirm: async () => {
          unlocked = false
          return {
            kind: 'signature',
            signature: { encoding: 'utf8', value: 'must-not-escape' },
            publicKey,
            address
          }
        },
        cancel: async (_keyDomainId, commandId) => cancelledCommands.push(commandId)
      }
    })
    await state.handler.request({ method: 'requestAccounts' }, 'https://dapp.example', {})

    await expect(
      state.handler.request(
        { method: 'signMessage', params: ['hello', 'bip322-simple'] },
        'https://dapp.example',
        {}
      )
    ).rejects.toMatchObject({ code: 4100 })
    expect(cancelledCommands).toEqual(['signing-session-ended'])
  })

  test('returns a signed non-finalized PSBT and rejects a mismatched account summary', async () => {
    const state = harness()
    await state.handler.request({ method: 'requestAccounts' }, 'https://dapp.example', {})
    await expect(
      state.handler.request(
        { method: 'signPsbt', params: ['70736274ff00', { autoFinalized: false }] },
        'https://dapp.example',
        {}
      )
    ).resolves.toBe('70736274ff00')

    const mismatched = harness({
      signer: {
        prepare: async () => ({
          commandId: 'signing-command:mismatch',
          chainId: account.chainAccount.scope.chainId,
          operation: 'transaction',
          summary: {
            ...signingSummary('bitcoin-psbt'),
            fields: { ...signingSummary('bitcoin-psbt').fields, signer: 'bc1qother' }
          },
          payloadFingerprint: { algorithm: 'sha256', digestHex: '11'.repeat(32) },
          execution: { kind: 'internal' },
          expiresAt: Date.now() + 60_000
        }),
        confirm: async () => {
          throw new Error('must not confirm')
        },
        cancel: async (_keyDomainId, commandId) => {
          mismatched.cancelledCommands.push(commandId)
        }
      }
    })
    await mismatched.handler.request({ method: 'requestAccounts' }, 'https://dapp.example', {})
    await expect(
      mismatched.handler.request(
        { method: 'signPsbt', params: ['70736274ff00'] },
        'https://dapp.example',
        {}
      )
    ).rejects.toMatchObject({ code: 4100 })
    expect(mismatched.cancelledCommands).toEqual(['signing-command:mismatch'])
  })

  test('signs a bounded PSBT batch sequentially and rejects incomplete PSBT broadcast', async () => {
    const state = harness()
    await state.handler.request({ method: 'requestAccounts' }, 'https://dapp.example', {})
    await expect(
      state.handler.request(
        {
          method: 'signPsbts',
          params: [
            ['70736274ff00', '70736274ff00'],
            [{ autoFinalized: false }, { autoFinalized: false }]
          ]
        },
        'https://dapp.example',
        {}
      )
    ).resolves.toEqual(['70736274ff00', '70736274ff00'])
    expect(state.approvalCalls.map(call => call.action)).toEqual([
      'bitcoinConnect',
      'bitcoinTransaction',
      'bitcoinTransaction'
    ])
    await expect(
      state.handler.request(
        { method: 'pushPsbt', params: ['70736274ff00'] },
        'https://dapp.example',
        {}
      )
    ).rejects.toMatchObject({ code: -32602 })
  })

  test('broadcasts an already-finalized PSBT and verifies the returned transaction ID', async () => {
    const destination = payments.p2wpkh({
      pubkey: Buffer.from(publicKey.slice(2), 'hex'),
      network: networks.bitcoin
    })
    const previous = new Transaction()
    previous.addInput(Buffer.alloc(32), 0xffffffff)
    previous.addOutput(destination.output, 10_000)
    const psbt = new Psbt({ network: networks.bitcoin })
    psbt.addInput({
      hash: previous.getId(),
      index: 0,
      nonWitnessUtxo: previous.toBuffer(),
      finalScriptSig: Buffer.from([0])
    })
    psbt.addOutput({ script: destination.output, value: 9_000 })
    const broadcast = []
    const state = harness({
      rpc: {
        broadcastRawTransaction: async rawTransactionHex => {
          broadcast.push(rawTransactionHex)
          return Transaction.fromHex(rawTransactionHex).getId()
        }
      }
    })
    await state.handler.request({ method: 'requestAccounts' }, 'https://dapp.example', {})

    const transactionId = await state.handler.request(
      { method: 'pushPsbt', params: [psbt.toHex()] },
      'https://dapp.example',
      {}
    )
    expect(transactionId).toBe(Transaction.fromHex(broadcast[0]).getId())
    await expect(
      state.handler.request(
        { method: 'pushTx', params: [{ rawtx: broadcast[0] }] },
        'https://dapp.example',
        {}
      )
    ).resolves.toBe(transactionId)
    expect(broadcast).toHaveLength(2)
  })

  test('keeps permission while locked and emits an empty account event', async () => {
    const state = harness()
    await state.handler.request({ method: 'requestAccounts' }, 'https://dapp.example', {})
    state.setUnlocked(false)
    await expect(
      state.handler.request({ method: 'getAccounts' }, 'https://dapp.example', {})
    ).resolves.toEqual([])
    await state.handler.notifyAccountsChanged()
    expect(state.getAuthorization()).not.toBeNull()
    expect(state.events).toEqual([
      {
        origin: 'https://dapp.example',
        chainId: 'bitcoin',
        eventName: 'accountsChanged',
        data: []
      }
    ])
  })
})
