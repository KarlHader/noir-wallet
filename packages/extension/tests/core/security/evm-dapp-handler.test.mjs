import { test } from 'node:test'
import { expect } from '@playwright/test'

import { BackgroundEvmDAppHandler } from '../../../src/background/evm-dapp-handler.ts'
import { EVM_NETWORKS } from '../../../src/config/networks.ts'
import { EvmRpcError } from '../../../src/infrastructure/chains/evm/evm-rpc-client.ts'

const account = {
  generationId: 'generation-1',
  keyDomainSource: { kind: 'software', mnemonicWordCount: 24 },
  chainAccount: {
    id: 'chain-account-1',
    scope: {
      keyDomainId: 'wallet-1',
      accountId: 'account-1',
      chainId: 'eip155:1'
    },
    derivation: { scheme: 'bip44', path: "m/44'/60'/0'/0/0" },
    identity: {
      kind: 'account-identifier',
      value: '0x1111111111111111111111111111111111111111'
    },
    createdAt: 1_700_000_000_000
  }
}

const privateExecutionAddress = '0x9999999999999999999999999999999999999999'

const hardwareAccount = Object.freeze({
  ...account,
  keyDomainSource: Object.freeze({
    kind: 'hardware',
    vendor: 'keystone',
    firmwareProfile: 'multi-coin',
    capabilities: Object.freeze(['bitcoin', 'evm'])
  })
})

function harness(overrides = {}) {
  const {
    approvalSelectedIds,
    rpc: rpcOverrides,
    transferController: transferControllerOverrides,
    ...optionOverrides
  } = overrides
  let authorization = null
  const approvalCalls = []
  const analyticsEvents = []
  const events = []
  const cancelledApprovalChains = []
  const rejectedTransfers = []
  const persistedOperations = []
  const preparedContractCalls = []
  const preparedTransfers = []
  const signerPreparePayloads = []
  const cancelledSigningCommands = []
  const rpcReads = []
  const privateTransferCalls = []
  let preparedSignerAddress = account.chainAccount.identity.value
  const manager = {
    async getAllConnections() {
      return authorization
        ? [{ origin: 'https://dapp.example', chainAuthorizations: [authorization] }]
        : []
    },
    async getChainAuthorization() {
      return authorization
    },
    async setChainAuthorizedAccounts(origin, tabInfo, chainId, accounts, binding) {
      authorization = { chainId, accounts, binding }
    },
    async addEvmAuthorizedAccount(origin, chainId, accountRef) {
      if (!authorization || authorization.chainId !== chainId) {
        throw new Error('Reconnect from the site to update this network permission')
      }
      authorization = {
        ...authorization,
        accounts: authorization.accounts.some(
          item => item.walletId === accountRef.walletId && item.accountId === accountRef.accountId
        )
          ? authorization.accounts
          : [...authorization.accounts, accountRef],
        binding: accountRef
      }
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
        requestId: `request-${approvalCalls.length}`,
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
    async prepare(keyDomainId, payload) {
      signerPreparePayloads.push({ keyDomainId, payload })
      preparedSignerAddress = payload.kind.startsWith('pea-')
        ? privateExecutionAddress
        : account.chainAccount.identity.value
      return {
        commandId: 'signing-1',
        chainId: payload.chainId,
        operation: 'message',
        summary: {
          schema: 'evm.personal-message.v1',
          chainId: payload.chainId,
          operation: 'message',
          review: { level: 'standard', issues: [] },
          fields: {
            signer: preparedSignerAddress,
            message: {
              encoding: 'utf8',
              value: 'Hello',
              byteLength: 5,
              sha256: '00'.repeat(32)
            }
          }
        },
        payloadFingerprint: { algorithm: 'sha256', digestHex: '00'.repeat(32) },
        execution: { kind: 'internal' },
        expiresAt: Date.now() + 60_000
      }
    },
    async confirm() {
      return {
        kind: 'signature',
        signature: { encoding: 'hex', value: `0x${'11'.repeat(65)}` },
        publicKey: `0x${'22'.repeat(65)}`,
        address: preparedSignerAddress
      }
    },
    async cancel(_keyDomainId, commandId) {
      cancelledSigningCommands.push(commandId)
    }
  }
  const transferController = {
    async prepare(...args) {
      preparedTransfers.push(args)
      return {
        graph: { root: { id: `0x${'33'.repeat(32)}` } },
        review: {
          chainId: 'eip155:1',
          operation: 'transaction',
          summary: { schema: 'evm.transaction.v1' },
          payloadFingerprint: { algorithm: 'sha256', digestHex: '44'.repeat(32) },
          expiresAt: Date.now() + 60_000
        }
      }
    },
    async prepareContractCall(intent) {
      preparedContractCalls.push(intent)
      return {
        graph: { root: { id: `0x${'33'.repeat(32)}` } },
        review: {
          chainId: 'eip155:1',
          operation: 'transaction',
          summary: { schema: 'evm.transaction.v1' },
          payloadFingerprint: { algorithm: 'sha256', digestHex: '44'.repeat(32) },
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
          segments: [
            {
              role: 'origin',
              evidence: { transactionHash: `0x${'55'.repeat(32)}` }
            }
          ]
        }
      }
    },
    async reject(transactionId) {
      rejectedTransfers.push(transactionId)
    },
    ...transferControllerOverrides
  }
  const options = {
    analytics: (name, options) => analyticsEvents.push({ name, options }),
    network: EVM_NETWORKS.mainnet,
    manager,
    approval,
    loadActiveContext: async () => account,
    hasUnlockSession: async () => true,
    runActiveOperation: operation => operation(),
    transferController,
    privateTransfer: {
      async send(input) {
        privateTransferCalls.push(input)
        await input.ensureIdentity()
        return `0x${'55'.repeat(32)}`
      }
    },
    operationStore: {
      put: async record => persistedOperations.push(record),
      delete: async transactionId => persistedOperations.push({ deleted: transactionId })
    },
    signer,
    rpc: {
      requestDAppRead: async () => '0x2a',
      getNativeBalance: async () => '42',
      getCode: async address => {
        rpcReads.push({ method: 'eth_getCode', address })
        return '0x6000'
      },
      call: async (call, blockTag) => {
        rpcReads.push({ method: 'eth_call', call, blockTag })
        return '0x1234'
      },
      getTransactionCount: async (address, blockTag) => {
        rpcReads.push({ method: 'eth_getTransactionCount', address, blockTag })
        return '7'
      },
      estimateGas: async call => {
        rpcReads.push({ method: 'eth_estimateGas', call })
        return '21000'
      },
      ...rpcOverrides
    },
    ...optionOverrides
  }
  return {
    handler: new BackgroundEvmDAppHandler(options),
    analyticsEvents,
    approvalCalls,
    events,
    cancelledApprovalChains,
    manager,
    rejectedTransfers,
    preparedContractCalls,
    preparedTransfers,
    signerPreparePayloads,
    cancelledSigningCommands,
    rpcReads,
    persistedOperations,
    privateTransferCalls,
    getAuthorization: () => authorization
  }
}

test.describe('Background EVM dApp handler', () => {
  test('records approved connections once, message signatures, and disconnect without private data', async () => {
    const state = harness()
    const origin = 'https://private-dapp.example'
    await state.handler.request({ method: 'eth_requestAccounts' }, origin, {})
    await state.handler.request({ method: 'eth_requestAccounts' }, origin, {})
    await state.handler.request(
      { method: 'personal_sign', params: ['0x48656c6c6f', account.chainAccount.identity.value] },
      origin,
      {}
    )
    await state.handler.request(
      { method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] },
      origin,
      {}
    )
    expect(state.analyticsEvents.map(event => event.name)).toEqual([
      'dapp_connected',
      'dapp_message_signed',
      'dapp_disconnected'
    ])
    expect(state.analyticsEvents[0].options).toMatchObject({
      chain: 'evm',
      pageId: 'noir_dapp',
      extra: { account_count: 1, source: 'approval' }
    })
    expect(JSON.stringify(state.analyticsEvents)).not.toContain(origin)
    expect(JSON.stringify(state.analyticsEvents)).not.toContain(account.chainAccount.identity.value)
    expect(JSON.stringify(state.analyticsEvents)).not.toContain('48656c6c6f')
  })

  test('rejected EVM approval reports rejection without a connection or transaction success', async () => {
    const state = harness({
      approval: {
        requestExternalApproval: async () => ({ approved: false, requestId: 'rejected' })
      }
    })
    await expect(
      state.handler.request({ method: 'eth_requestAccounts' }, 'https://dapp.example', {})
    ).rejects.toMatchObject({ code: 4001 })
    expect(state.analyticsEvents).toEqual([
      {
        name: 'dapp_request_rejected',
        options: { chain: 'evm', pageId: 'noir_dapp', extra: { method: 'connect' } }
      }
    ])
  })

  test('wallet-side Connect adds the active account to an existing EVM grant and broadcasts it', async () => {
    let activeContext = account
    const state = harness({ loadActiveContext: async () => activeContext })
    const origin = 'https://dapp.example'
    await state.handler.request({ method: 'eth_requestAccounts' }, origin, {})
    activeContext = {
      ...account,
      chainAccount: {
        ...account.chainAccount,
        scope: { ...account.chainAccount.scope, accountId: 'account-2' },
        identity: {
          kind: 'account-identifier',
          value: '0x2222222222222222222222222222222222222222'
        }
      }
    }
    await state.handler.connectCurrentAccountToDApp(origin)
    expect(state.getAuthorization()).toEqual({
      chainId: 'eip155:1',
      accounts: [
        { walletId: 'wallet-1', accountId: 'account-1' },
        { walletId: 'wallet-1', accountId: 'account-2' }
      ],
      binding: { walletId: 'wallet-1', accountId: 'account-2' }
    })
    expect(state.events.at(-1)).toEqual({
      origin,
      chainId: 'evm',
      eventName: 'accountsChanged',
      data: ['0x2222222222222222222222222222222222222222']
    })

    const locked = harness({ hasUnlockSession: async () => false })
    await expect(locked.handler.connectCurrentAccountToDApp(origin)).rejects.toMatchObject({
      code: 4100
    })
    expect(locked.getAuthorization()).toBeNull()

    const unconnected = harness()
    await expect(unconnected.handler.connectCurrentAccountToDApp(origin)).rejects.toThrow(
      'Reconnect from the site to update this network permission'
    )
  })

  test('grants one chain-scoped account after explicit approval', async () => {
    const { handler, approvalCalls, getAuthorization } = harness()

    await expect(
      handler.request({ method: 'eth_accounts' }, 'https://dapp.example', {})
    ).resolves.toEqual([])
    await expect(
      handler.request({ method: 'eth_requestAccounts' }, 'https://dapp.example', {
        title: 'DApp',
        favIconUrl: 'https://dapp.example/icon.png',
        pageUrl: 'https://dapp.example/swap'
      })
    ).resolves.toEqual([account.chainAccount.identity.value])
    expect(approvalCalls).toHaveLength(1)
    expect(approvalCalls[0].action).toBe('evmConnect')
    expect(approvalCalls[0].data.favicon).toBe('https://dapp.example/icon.png')
    expect(approvalCalls[0].data.faviconPageUrl).toBe('https://dapp.example/swap')
    expect(getAuthorization()).toEqual({
      chainId: 'eip155:1',
      accounts: [{ walletId: 'wallet-1', accountId: 'account-1' }],
      binding: { walletId: 'wallet-1', accountId: 'account-1' }
    })
  })

  test('persists and returns every explicitly selected EVM account', async () => {
    const secondAddress = '0x2222222222222222222222222222222222222222'
    const currentId = JSON.stringify(['wallet-1', 'account-1'])
    const secondId = JSON.stringify(['wallet-2', 'account-2'])
    const state = harness({
      approvalSelectedIds: [currentId, secondId],
      listAccounts: async () => [
        {
          id: currentId,
          label: 'Wallet 1 · Account 1',
          reference: { walletId: 'wallet-1', accountId: 'account-1' },
          address: account.chainAccount.identity.value
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
      state.handler.request({ method: 'eth_requestAccounts' }, 'https://dapp.example', {})
    ).resolves.toEqual([account.chainAccount.identity.value, secondAddress])
    await expect(
      state.handler.request({ method: 'eth_accounts' }, 'https://dapp.example', {})
    ).resolves.toEqual([account.chainAccount.identity.value, secondAddress])
    expect(state.getAuthorization()).toEqual({
      chainId: 'eip155:1',
      accounts: [
        { walletId: 'wallet-1', accountId: 'account-1' },
        { walletId: 'wallet-2', accountId: 'account-2' }
      ],
      binding: { walletId: 'wallet-1', accountId: 'account-1' }
    })
    expect(state.approvalCalls[0].data.accounts[0].required).toBe(true)
  })

  test('rejects a manipulated selection that removes the current EVM account', async () => {
    const secondId = JSON.stringify(['wallet-2', 'account-2'])
    const state = harness({
      approvalSelectedIds: [secondId],
      listAccounts: async () => [
        {
          id: JSON.stringify(['wallet-1', 'account-1']),
          label: 'Wallet 1 · Account 1',
          reference: { walletId: 'wallet-1', accountId: 'account-1' },
          address: account.chainAccount.identity.value
        },
        {
          id: secondId,
          label: 'Wallet 2 · Account 2',
          reference: { walletId: 'wallet-2', accountId: 'account-2' },
          address: '0x2222222222222222222222222222222222222222'
        }
      ]
    })

    await expect(
      state.handler.request({ method: 'eth_requestAccounts' }, 'https://dapp.example', {})
    ).rejects.toMatchObject({ code: 4100 })
    expect(state.getAuthorization()).toBeNull()
  })

  test('does not persist a connection approved after the active Account changed', async () => {
    const changedAccount = {
      ...account,
      chainAccount: {
        ...account.chainAccount,
        id: 'chain-account-2',
        scope: { ...account.chainAccount.scope, accountId: 'account-2' },
        derivation: { scheme: 'bip44', path: "m/44'/60'/0'/0/1" },
        identity: {
          kind: 'account-identifier',
          value: '0x2222222222222222222222222222222222222222'
        }
      }
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
      state.handler.request({ method: 'eth_requestAccounts' }, 'https://dapp.example', {})
    ).rejects.toMatchObject({ code: 4100 })
    expect(state.getAuthorization()).toBeNull()
  })

  test('hides accounts while locked without deleting the persistent permission', async () => {
    let unlocked = true
    const state = harness({ hasUnlockSession: async () => unlocked })
    await state.handler.request({ method: 'eth_requestAccounts' }, 'https://dapp.example', {})
    unlocked = false

    await expect(
      state.handler.request({ method: 'eth_accounts' }, 'https://dapp.example', {})
    ).resolves.toEqual([])
    expect(state.getAuthorization()).not.toBeNull()
  })

  test('revokes only the active EVM chain after persistence and cancels its approvals', async () => {
    const state = harness()
    await state.handler.request({ method: 'eth_requestAccounts' }, 'https://dapp.example', {})

    await expect(
      state.handler.request(
        { method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] },
        'https://dapp.example',
        {}
      )
    ).resolves.toBeNull()
    expect(state.getAuthorization()).toBeNull()
    expect(state.cancelledApprovalChains).toEqual([
      { origin: 'https://dapp.example', chainId: 'evm' }
    ])
    expect(state.events.at(-1)).toEqual({
      origin: 'https://dapp.example',
      chainId: 'evm',
      eventName: 'accountsChanged',
      data: []
    })
  })

  test('keeps EVM permission and approval state when revoke persistence fails', async () => {
    const state = harness()
    await state.handler.request({ method: 'eth_requestAccounts' }, 'https://dapp.example', {})
    state.manager.removeChainAuthorization = async () => {
      throw new Error('storage unavailable')
    }

    await expect(
      state.handler.request(
        { method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] },
        'https://dapp.example',
        {}
      )
    ).rejects.toThrow('storage unavailable')
    expect(state.getAuthorization()).not.toBeNull()
    expect(state.cancelledApprovalChains).toEqual([])
    expect(state.events).toEqual([])
  })

  test('forwards public JSON-RPC reads without requiring account permission', async () => {
    const calls = []
    const { handler } = harness({
      rpc: {
        requestDAppRead: async (method, params) => {
          calls.push({ method, params })
          return method === 'eth_getBalance' ? '0x2a' : '0x1234'
        }
      }
    })
    await expect(
      handler.request(
        { method: 'eth_getBalance', params: [account.chainAccount.identity.value, 'latest'] },
        'https://dapp.example',
        {}
      )
    ).resolves.toBe('0x2a')
    await expect(
      handler.request(
        {
          method: 'eth_call',
          params: { to: '0x2222222222222222222222222222222222222222', data: '0x' }
        },
        'https://dapp.example',
        {}
      )
    ).resolves.toBe('0x1234')
    expect(calls).toEqual([
      {
        method: 'eth_getBalance',
        params: [account.chainAccount.identity.value, 'latest']
      },
      {
        method: 'eth_call',
        params: { to: '0x2222222222222222222222222222222222222222', data: '0x' }
      }
    ])
  })

  test('preserves validated JSON-RPC errors for dApps', async () => {
    const { handler } = harness({
      rpc: {
        requestDAppRead: async () => {
          throw new EvmRpcError('rpc-error', 'EVM RPC request failed', {
            code: -32602,
            message: 'invalid block parameter'
          })
        }
      }
    })

    await expect(
      handler.request({ method: 'eth_getBalance', params: [] }, 'https://dapp.example', {})
    ).rejects.toMatchObject({ code: -32602, message: 'invalid block parameter' })
  })

  test('forwards bounded public contract reads on the active EVM network', async () => {
    const state = harness()

    await expect(
      state.handler.request(
        {
          method: 'eth_getCode',
          params: ['0x2222222222222222222222222222222222222222', 'latest']
        },
        'https://dapp.example',
        {}
      )
    ).resolves.toBe('0x6000')
    await expect(
      state.handler.request(
        {
          method: 'eth_call',
          params: [
            {
              to: '0x2222222222222222222222222222222222222222',
              data: '0x12345678'
            },
            'latest'
          ]
        },
        'https://dapp.example',
        {}
      )
    ).resolves.toBe('0x1234')

    expect(state.rpcReads).toEqual([
      {
        method: 'eth_getCode',
        address: '0x2222222222222222222222222222222222222222'
      },
      {
        method: 'eth_call',
        call: {
          to: '0x2222222222222222222222222222222222222222',
          valueRaw: '0',
          data: '0x12345678'
        },
        blockTag: 'latest'
      }
    ])
  })

  test('binds DeFi reads and transaction preflight to the Private Execution Address', async () => {
    const state = harness({
      resolveExecutionIdentity: async () => ({
        mode: 'private',
        address: privateExecutionAddress
      })
    })
    await state.handler.request({ method: 'eth_requestAccounts' }, 'https://dapp.example', {})

    await expect(
      state.handler.request(
        {
          method: 'eth_call',
          params: [
            {
              from: privateExecutionAddress,
              to: '0x2222222222222222222222222222222222222222',
              data: '0x12345678'
            },
            'pending'
          ]
        },
        'https://dapp.example',
        {}
      )
    ).resolves.toBe('0x1234')
    await expect(
      state.handler.request(
        {
          method: 'eth_getTransactionCount',
          params: [privateExecutionAddress, 'pending']
        },
        'https://dapp.example',
        {}
      )
    ).resolves.toBe('0x7')
    await expect(
      state.handler.request(
        {
          method: 'eth_estimateGas',
          params: [
            {
              to: '0x2222222222222222222222222222222222222222',
              value: '0x1',
              data: '0x'
            }
          ]
        },
        'https://dapp.example',
        {}
      )
    ).resolves.toBe('0x5208')

    expect(state.rpcReads).toEqual([
      {
        method: 'eth_call',
        call: {
          from: privateExecutionAddress,
          to: '0x2222222222222222222222222222222222222222',
          valueRaw: '0',
          data: '0x12345678'
        },
        blockTag: 'pending'
      },
      {
        method: 'eth_getTransactionCount',
        address: privateExecutionAddress,
        blockTag: 'pending'
      },
      {
        method: 'eth_estimateGas',
        call: {
          from: privateExecutionAddress,
          to: '0x2222222222222222222222222222222222222222',
          valueRaw: '1',
          data: '0x'
        }
      }
    ])
  })

  test('does not let a Private connection read or preflight as the Main Address', async () => {
    const state = harness({
      resolveExecutionIdentity: async () => ({
        mode: 'private',
        address: privateExecutionAddress
      })
    })
    await state.handler.request({ method: 'eth_requestAccounts' }, 'https://dapp.example', {})

    await expect(
      state.handler.request(
        {
          method: 'eth_call',
          params: [
            {
              from: account.chainAccount.identity.value,
              to: '0x2222222222222222222222222222222222222222'
            },
            'latest'
          ]
        },
        'https://dapp.example',
        {}
      )
    ).rejects.toMatchObject({ code: 4100 })
    await expect(
      state.handler.request(
        {
          method: 'eth_getTransactionCount',
          params: [account.chainAccount.identity.value, 'latest']
        },
        'https://dapp.example',
        {}
      )
    ).rejects.toMatchObject({ code: 4100 })
    expect(state.rpcReads).toEqual([])
  })

  test('rejects unbounded DeFi read parameters before reaching the RPC endpoint', async () => {
    const state = harness()
    await state.handler.request({ method: 'eth_requestAccounts' }, 'https://dapp.example', {})

    await expect(
      state.handler.request(
        {
          method: 'eth_call',
          params: [
            {
              from: account.chainAccount.identity.value,
              to: '0x2222222222222222222222222222222222222222',
              gas: '0x5208'
            },
            'latest'
          ]
        },
        'https://dapp.example',
        {}
      )
    ).rejects.toMatchObject({ code: 4200 })
    await expect(
      state.handler.request(
        {
          method: 'eth_getCode',
          params: ['0x2222222222222222222222222222222222222222', '0x1']
        },
        'https://dapp.example',
        {}
      )
    ).rejects.toMatchObject({ code: -32602 })
    expect(state.rpcReads).toEqual([])
  })

  test('routes account discovery, balance reads, and account events through the effective identity', async () => {
    const balanceReads = []
    const state = harness({
      resolveExecutionIdentity: async () => ({
        mode: 'private',
        address: privateExecutionAddress
      }),
      rpc: {
        getNativeBalance: async address => {
          balanceReads.push(address)
          return '42'
        }
      }
    })

    await expect(
      state.handler.request({ method: 'eth_requestAccounts' }, 'https://dapp.example', {})
    ).resolves.toEqual([privateExecutionAddress])
    await expect(
      state.handler.request(
        { method: 'eth_getBalance', params: [privateExecutionAddress, 'latest'] },
        'https://dapp.example',
        {}
      )
    ).resolves.toBe('0x2a')
    await state.handler.notifyAccountsChanged()

    expect(balanceReads).toEqual([privateExecutionAddress])
    expect(state.approvalCalls[0]).toMatchObject({
      action: 'evmConnect',
      data: { address: privateExecutionAddress, executionMode: 'private' }
    })
    expect(state.events.at(-1)).toEqual({
      origin: 'https://dapp.example',
      chainId: 'evm',
      eventName: 'accountsChanged',
      data: [privateExecutionAddress]
    })
  })

  test('routes Private transactions and messages to the PEA execution context', async () => {
    const state = harness({
      resolveExecutionIdentity: async () => ({
        mode: 'private',
        address: privateExecutionAddress
      })
    })
    await state.handler.request({ method: 'eth_requestAccounts' }, 'https://dapp.example', {})

    await expect(
      state.handler.request(
        {
          method: 'eth_sendTransaction',
          params: [
            {
              from: privateExecutionAddress,
              to: '0x2222222222222222222222222222222222222222',
              value: '0x1'
            }
          ]
        },
        'https://dapp.example',
        {}
      )
    ).resolves.toBe(`0x${'55'.repeat(32)}`)
    await expect(
      state.handler.request(
        { method: 'personal_sign', params: ['0x48656c6c6f', privateExecutionAddress] },
        'https://dapp.example',
        {}
      )
    ).resolves.toBe(`0x${'11'.repeat(65)}`)

    expect(state.preparedTransfers).toHaveLength(0)
    expect(state.privateTransferCalls[0]).toMatchObject({
      chainId: 'eip155:1',
      account: { address: privateExecutionAddress, addressIndex: 0 },
      intent: {
        assetId: 'eip155:1/slip44:60',
        recipient: '0x2222222222222222222222222222222222222222',
        amountRaw: '1'
      }
    })
    expect(state.signerPreparePayloads[0].payload).toMatchObject({
      kind: 'pea-evm-personal-message',
      chainId: 'eip155:1',
      addressIndex: 0
    })
    expect(state.approvalCalls.map(call => call.action)).toEqual(['evmConnect', 'evmMessage'])
  })

  test('never falls back to a direct PEA transaction for Private asset transfers', async () => {
    let prepareCount = 0
    const state = harness({
      resolveExecutionIdentity: async () => ({
        mode: 'private',
        address: privateExecutionAddress
      }),
      transferController: {
        async prepare(...args) {
          prepareCount += 1
          state.preparedTransfers.push(args)
          throw new Error('Direct preparation must not run')
        }
      }
    })
    await state.handler.request({ method: 'eth_requestAccounts' }, 'https://dapp.example', {})

    await expect(
      state.handler.request(
        {
          method: 'eth_sendTransaction',
          params: [
            {
              from: privateExecutionAddress,
              to: '0x2222222222222222222222222222222222222222',
              value: '0x1'
            }
          ]
        },
        'https://dapp.example',
        { pageUrl: 'https://dapp.example/swap' }
      )
    ).resolves.toBe(`0x${'55'.repeat(32)}`)

    expect(prepareCount).toBe(0)
    expect(state.privateTransferCalls).toHaveLength(1)
    expect(state.approvalCalls.map(call => call.action)).toEqual(['evmConnect'])
  })

  test('requires a separate approval for messages and returns the WASM signature', async () => {
    const { handler, approvalCalls } = harness()
    await handler.request({ method: 'eth_requestAccounts' }, 'https://dapp.example', {})

    await expect(
      handler.request(
        {
          method: 'personal_sign',
          params: ['0x48656c6c6f', account.chainAccount.identity.value]
        },
        'https://dapp.example',
        {
          favIconUrl: 'https://dapp.example/icon.png',
          pageUrl: 'https://dapp.example/sign'
        }
      )
    ).resolves.toBe(`0x${'11'.repeat(65)}`)
    expect(approvalCalls.map(call => call.action)).toEqual(['evmConnect', 'evmMessage'])
    expect(approvalCalls.at(-1).data).toMatchObject({
      favicon: 'https://dapp.example/icon.png',
      faviconPageUrl: 'https://dapp.example/sign'
    })
  })

  test('cancels an approved message command when the active Account changed', async () => {
    const changedAccount = {
      ...account,
      chainAccount: {
        ...account.chainAccount,
        id: 'chain-account-2',
        scope: { ...account.chainAccount.scope, accountId: 'account-2' },
        derivation: { scheme: 'bip44', path: "m/44'/60'/0'/0/1" },
        identity: {
          kind: 'account-identifier',
          value: '0x2222222222222222222222222222222222222222'
        }
      }
    }
    let active = account
    const state = harness({
      loadActiveContext: async () => active,
      approval: {
        requestExternalApproval: async (_origin, action) => {
          if (action === 'evmMessage') active = changedAccount
          return { approved: true, requestId: action }
        },
        broadcastProviderEvent: async () => {}
      }
    })
    await state.handler.request({ method: 'eth_requestAccounts' }, 'https://dapp.example', {})

    await expect(
      state.handler.request(
        {
          method: 'personal_sign',
          params: ['0x48656c6c6f', account.chainAccount.identity.value]
        },
        'https://dapp.example',
        {}
      )
    ).rejects.toMatchObject({ code: 4100 })
    expect(state.cancelledSigningCommands).toEqual(['signing-1'])
  })

  test('cancels an approved message command after its EVM runtime was replaced', async () => {
    let handler
    const state = harness({
      approval: {
        requestExternalApproval: async (_origin, action) => {
          if (action === 'evmMessage') handler.deactivate()
          return { approved: true, requestId: action }
        },
        broadcastProviderEvent: async () => {}
      }
    })
    handler = state.handler
    await handler.request({ method: 'eth_requestAccounts' }, 'https://dapp.example', {})

    await expect(
      handler.request(
        {
          method: 'personal_sign',
          params: ['0x48656c6c6f', account.chainAccount.identity.value]
        },
        'https://dapp.example',
        {}
      )
    ).rejects.toMatchObject({ code: 4901 })
    expect(state.cancelledSigningCommands).toEqual(['signing-1'])
  })

  test('does not return a signature when the unlock session ends during confirmation', async () => {
    let unlocked = true
    const cancelledSigningCommands = []
    const state = harness({
      hasUnlockSession: async () => unlocked,
      signer: {
        prepare: async () => ({
          commandId: 'signing-session-ended',
          chainId: account.chainAccount.scope.chainId,
          operation: 'message',
          summary: {},
          payloadFingerprint: { algorithm: 'sha256', digestHex: '00'.repeat(32) },
          execution: { kind: 'internal' },
          expiresAt: Date.now() + 60_000
        }),
        confirm: async () => {
          unlocked = false
          return {
            kind: 'signature',
            signature: { encoding: 'hex', value: `0x${'11'.repeat(65)}` },
            publicKey: `0x${'22'.repeat(65)}`,
            address: account.chainAccount.identity.value
          }
        },
        cancel: async (_keyDomainId, commandId) => cancelledSigningCommands.push(commandId)
      }
    })
    await state.handler.request({ method: 'eth_requestAccounts' }, 'https://dapp.example', {})

    await expect(
      state.handler.request(
        {
          method: 'personal_sign',
          params: ['0x48656c6c6f', account.chainAccount.identity.value]
        },
        'https://dapp.example',
        {}
      )
    ).rejects.toMatchObject({ code: 4100 })
    expect(cancelledSigningCommands).toEqual(['signing-session-ended'])
  })

  test('returns the signed network transaction hash after transfer approval', async () => {
    const { handler, approvalCalls, persistedOperations } = harness()
    await handler.request({ method: 'eth_requestAccounts' }, 'https://dapp.example', {})

    await expect(
      handler.request(
        {
          method: 'eth_sendTransaction',
          params: [
            {
              from: account.chainAccount.identity.value,
              to: '0x2222222222222222222222222222222222222222',
              value: '0x1'
            }
          ]
        },
        'https://dapp.example',
        { pageUrl: 'https://dapp.example/send' }
      )
    ).resolves.toBe(`0x${'55'.repeat(32)}`)
    expect(approvalCalls.map(call => call.action)).toEqual(['evmConnect', 'evmTransaction'])
    expect(approvalCalls.at(-1).data).toMatchObject({
      faviconPageUrl: 'https://dapp.example/send'
    })
  })

  test('re-prepares the immutable EVM review when the user changes the fee tier', async () => {
    const prepareCalls = []
    const rejected = []
    let approvedTransactionId = null
    const makeReview = index => ({
      graph: { root: { id: `transaction:evm:fee-${index}` } },
      review: {
        chainId: 'eip155:1',
        operation: 'transaction',
        summary: { schema: 'evm.transaction.v1' },
        payloadFingerprint: { algorithm: 'sha256', digestHex: `${index}`.repeat(64) },
        expiresAt: Date.now() + 60_000
      }
    })
    const state = harness({
      approval: {
        async requestExternalApproval(_origin, action, data, options) {
          if (action === 'evmTransaction') {
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
          prepareCalls.push(args)
          return makeReview(prepareCalls.length)
        },
        async approveForDApp(transactionId, _fingerprint, authorize) {
          approvedTransactionId = transactionId
          await authorize(account)
          return {
            status: 'broadcast',
            graph: {
              root: { id: transactionId },
              segments: [{ role: 'origin', evidence: { transactionHash: `0x${'55'.repeat(32)}` } }]
            }
          }
        },
        async reject(transactionId) {
          rejected.push(transactionId)
        }
      }
    })
    await state.handler.request({ method: 'eth_requestAccounts' }, 'https://dapp.example', {})
    await state.handler.request(
      {
        method: 'eth_sendTransaction',
        params: [
          {
            from: account.chainAccount.identity.value,
            to: '0x2222222222222222222222222222222222222222',
            value: '0x1'
          }
        ]
      },
      'https://dapp.example',
      {}
    )

    expect(prepareCalls).toHaveLength(2)
    expect(prepareCalls[1][2]).toEqual({ kind: 'tier', tier: 'fast' })
    expect(rejected).toEqual(['transaction:evm:fee-1'])
    expect(approvedTransactionId).toBe('transaction:evm:fee-2')
  })

  test('releases a fee replacement prepared after its approval was rejected', async () => {
    const rejected = []
    let completePreparation
    let feeUpdateResult
    let prepareCount = 0
    const makeReview = id => ({
      graph: { root: { id } },
      review: {
        chainId: 'eip155:1',
        operation: 'transaction',
        summary: { schema: 'evm.transaction.v1' },
        payloadFingerprint: { algorithm: 'sha256', digestHex: '44'.repeat(32) },
        expiresAt: Date.now() + 60_000
      }
    })
    const state = harness({
      approval: {
        async requestExternalApproval(_origin, action, _data, options) {
          if (action === 'evmTransaction') {
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
          if (prepareCount === 1) return makeReview('transaction:evm:original')
          return new Promise(resolve => {
            completePreparation = () => resolve(makeReview('transaction:evm:replacement'))
          })
        },
        async reject(transactionId) {
          rejected.push(transactionId)
        }
      }
    })
    await state.handler.request({ method: 'eth_requestAccounts' }, 'https://dapp.example', {})
    await expect(
      state.handler.request(
        {
          method: 'eth_sendTransaction',
          params: [
            {
              from: account.chainAccount.identity.value,
              to: '0x2222222222222222222222222222222222222222',
              value: '0x1'
            }
          ]
        },
        'https://dapp.example',
        {}
      )
    ).rejects.toMatchObject({ code: 4001 })

    completePreparation()
    expect((await feeUpdateResult).message).toBe('Approval request is no longer active')
    expect(rejected).toEqual(['transaction:evm:original', 'transaction:evm:replacement'])
  })

  test('submits a simulated arbitrary contract call through the transaction approval boundary', async () => {
    const { handler, approvalCalls, preparedContractCalls } = harness()
    await handler.request({ method: 'eth_requestAccounts' }, 'https://dapp.example', {})

    await expect(
      handler.request(
        {
          method: 'eth_sendTransaction',
          params: [
            {
              from: account.chainAccount.identity.value,
              to: '0x2222222222222222222222222222222222222222',
              value: '0x0',
              data: '0x12345678aabbccdd',
              gas: '0x5208'
            }
          ]
        },
        'https://dapp.example',
        {}
      )
    ).resolves.toBe(`0x${'55'.repeat(32)}`)
    expect(preparedContractCalls).toEqual([
      {
        chainId: 'eip155:1',
        contractAddress: '0x2222222222222222222222222222222222222222',
        valueRaw: '0',
        calldata: '0x12345678aabbccdd'
      }
    ])
    expect(approvalCalls.at(-1)).toMatchObject({
      action: 'evmTransaction',
      data: { token: null, intent: preparedContractCalls[0] }
    })
  })

  test('rejects and releases a prepared transfer when permission is revoked after approval', async () => {
    let state
    state = harness({
      approval: {
        async requestExternalApproval(_origin, action) {
          if (action === 'evmTransaction') await state.manager.removeChainAuthorization()
          return { approved: true, requestId: action }
        },
        async broadcastProviderEvent() {},
        cancelPendingApprovals() {
          return 0
        }
      }
    })
    await state.handler.request({ method: 'eth_requestAccounts' }, 'https://dapp.example', {})

    await expect(
      state.handler.request(
        {
          method: 'eth_sendTransaction',
          params: [
            {
              from: account.chainAccount.identity.value,
              to: '0x2222222222222222222222222222222222222222',
              value: '0x1'
            }
          ]
        },
        'https://dapp.example',
        {}
      )
    ).rejects.toMatchObject({ code: 4100 })
    expect(state.rejectedTransfers).toEqual([`0x${'33'.repeat(32)}`])
  })

  test('allows Keystone account discovery but rejects dApp signing before any software signer call', async () => {
    let transferPrepareCalls = 0
    let signerPrepareCalls = 0
    const { handler, approvalCalls } = harness({
      loadActiveContext: async () => hardwareAccount,
      transferController: {
        prepare: async () => {
          transferPrepareCalls += 1
          throw new Error('must not prepare a hardware dApp transfer')
        }
      },
      signer: {
        prepare: async () => {
          signerPrepareCalls += 1
          throw new Error('must not prepare a hardware dApp signature')
        }
      }
    })
    await expect(
      handler.request({ method: 'eth_requestAccounts' }, 'https://dapp.example', {})
    ).resolves.toEqual([account.chainAccount.identity.value])
    await expect(
      handler.request(
        {
          method: 'eth_sendTransaction',
          params: [
            {
              from: account.chainAccount.identity.value,
              to: '0x2222222222222222222222222222222222222222',
              value: '0x1'
            }
          ]
        },
        'https://dapp.example',
        {}
      )
    ).rejects.toMatchObject({
      code: 4200,
      message: 'Keystone EVM signing is available only from the Noir Wallet transaction screen.'
    })
    await expect(
      handler.request(
        {
          method: 'personal_sign',
          params: ['0x48656c6c6f', account.chainAccount.identity.value]
        },
        'https://dapp.example',
        {}
      )
    ).rejects.toMatchObject({ code: 4200 })
    const typedData = JSON.stringify({
      types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }], Mail: [] },
      primaryType: 'Mail',
      domain: { chainId: 1 },
      message: {}
    })
    await expect(
      handler.request(
        {
          method: 'eth_signTypedData_v4',
          params: [account.chainAccount.identity.value, typedData]
        },
        'https://dapp.example',
        {}
      )
    ).rejects.toMatchObject({ code: 4200 })
    expect(transferPrepareCalls).toBe(0)
    expect(signerPrepareCalls).toBe(0)
    expect(approvalCalls.map(call => call.action)).toEqual(['evmConnect'])
  })

  test('rejects a denied transaction and cancels its prepared transfer', async () => {
    const state = harness()
    await state.handler.request({ method: 'eth_requestAccounts' }, 'https://dapp.example', {})
    state.handler = new BackgroundEvmDAppHandler({
      network: EVM_NETWORKS.mainnet,
      manager: {
        getAllConnections: async () => [],
        getChainAuthorization: async () => state.getAuthorization(),
        setChainAuthorizedAccounts: async () => {},
        removeChainAuthorization: async () => {}
      },
      approval: {
        requestExternalApproval: async () => ({ approved: false, requestId: 'denied' }),
        broadcastProviderEvent: async () => {}
      },
      loadActiveContext: async () => account,
      hasUnlockSession: async () => true,
      runActiveOperation: operation => operation(),
      transferController: {
        prepare: async () => ({
          graph: { root: { id: `0x${'33'.repeat(32)}` } },
          review: {
            chainId: 'eip155:1',
            operation: 'transaction',
            summary: {},
            payloadFingerprint: { algorithm: 'sha256', digestHex: '44'.repeat(32) },
            expiresAt: Date.now() + 60_000
          }
        }),
        approve: async () => {
          throw new Error('must not approve')
        },
        reject: async transactionId => state.rejectedTransfers.push(transactionId)
      },
      operationStore: {
        put: async record => state.persistedOperations.push(record),
        delete: async transactionId => state.persistedOperations.push({ deleted: transactionId })
      },
      signer: {},
      rpc: { requestDAppRead: async () => '0x0' }
    })

    await expect(
      state.handler.request(
        {
          method: 'eth_sendTransaction',
          params: [
            {
              from: account.chainAccount.identity.value,
              to: '0x2222222222222222222222222222222222222222',
              value: '0x1'
            }
          ]
        },
        'https://dapp.example',
        {}
      )
    ).rejects.toMatchObject({ code: 4001 })
    expect(state.rejectedTransfers).toEqual([`0x${'33'.repeat(32)}`])
    expect(state.persistedOperations).toEqual([
      expect.objectContaining({ origin: 'https://dapp.example' }),
      { deleted: `0x${'33'.repeat(32)}` }
    ])
  })

  test('delegates configured chain switches and fails closed without a switch coordinator', async () => {
    const switches = []
    const { handler } = harness({
      switchNetwork: async (requested, origin, action, tabInfo) =>
        switches.push({ requested, origin, action, tabInfo })
    })
    await expect(
      handler.request(
        { method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] },
        'https://dapp.example',
        {}
      )
    ).resolves.toBeNull()
    await expect(
      handler.request(
        { method: 'wallet_switchEthereumChain', params: [{ chainId: '0xaa36a7' }] },
        'https://dapp.example',
        { pageUrl: 'https://dapp.example/network' }
      )
    ).resolves.toBeNull()
    expect(switches).toEqual([
      {
        requested: { chainId: '0xaa36a7', numericChainId: 11155111 },
        origin: 'https://dapp.example',
        action: 'switch',
        tabInfo: { pageUrl: 'https://dapp.example/network' }
      }
    ])
    await expect(
      handler.request(
        {
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: '0x7a69',
              chainName: 'Local EVM',
              nativeCurrency: { name: 'Local Ether', symbol: 'LETH', decimals: 18 },
              rpcUrls: ['http://localhost:8545']
            }
          ]
        },
        'https://dapp.example',
        {}
      )
    ).resolves.toBeNull()
    expect(switches.at(-1)).toMatchObject({
      requested: { chainId: '0x7a69', numericChainId: 31337 },
      origin: 'https://dapp.example',
      action: 'add'
    })

    const fixed = harness().handler
    await expect(
      fixed.request(
        { method: 'wallet_switchEthereumChain', params: [{ chainId: '0xaa36a7' }] },
        'https://dapp.example',
        {}
      )
    ).rejects.toMatchObject({ code: 4902 })
  })

  test('broadcasts chain changes only to origins with an EVM authorization', async () => {
    const events = []
    const manager = {
      async getAllConnections() {
        return [
          {
            origin: 'https://evm.example',
            chainAuthorizations: [
              {
                chainId: 'eip155:1',
                accounts: [{ walletId: 'wallet-1', accountId: 'account-1' }],
                binding: { walletId: 'wallet-1', accountId: 'account-1' }
              }
            ]
          },
          {
            origin: 'https://bitcoin.example',
            chainAuthorizations: [
              {
                chainId: 'bip122:000000000019d6689c085ae165831e93',
                accounts: [{ walletId: 'wallet-1', accountId: 'account-1' }],
                binding: { walletId: 'wallet-1', accountId: 'account-1' }
              }
            ]
          },
          {
            origin: 'https://zcash.example',
            boundWalletId: 'wallet-1',
            boundAccountId: 'account-1'
          },
          {
            origin: 'https://corrupt.example',
            chainAuthorizations: [{ chainId: 'eip155:1' }]
          }
        ]
      },
      async getChainAuthorization() {
        return null
      },
      async setChainAuthorizedAccounts() {},
      async removeChainAuthorization() {}
    }
    const state = harness({
      manager,
      approval: {
        async requestExternalApproval() {
          return { approved: true, requestId: 'unused' }
        },
        async broadcastProviderEvent(origin, chainId, eventName, data) {
          events.push({ origin, chainId, eventName, data })
        }
      }
    })

    await state.handler.notifyChainChanged(11155111)
    expect(events).toEqual([
      {
        origin: 'https://evm.example',
        chainId: 'evm',
        eventName: 'chainChanged',
        data: '0xaa36a7'
      }
    ])
  })

  test('clears an origin authorized only on the previous chain after a network switch', async () => {
    const active = {
      ...account,
      chainAccount: {
        ...account.chainAccount,
        scope: { ...account.chainAccount.scope, chainId: 'eip155:11155111' }
      }
    }
    const authorizations = new Map([
      [
        'https://previous.example',
        {
          chainId: 'eip155:1',
          accounts: [{ walletId: 'wallet-1', accountId: 'account-1' }],
          binding: { walletId: 'wallet-1', accountId: 'account-1' }
        }
      ],
      [
        'https://current.example',
        {
          chainId: 'eip155:11155111',
          accounts: [{ walletId: 'wallet-1', accountId: 'account-1' }],
          binding: { walletId: 'wallet-1', accountId: 'account-1' }
        }
      ]
    ])
    const events = []
    const state = harness({
      network: EVM_NETWORKS.testnet,
      loadActiveContext: async () => active,
      manager: {
        async getAllConnections() {
          return [...authorizations].map(([origin, authorization]) => ({
            origin,
            chainAuthorizations: [authorization]
          }))
        },
        async getChainAuthorization(origin, chainId) {
          const authorization = authorizations.get(origin)
          return authorization?.chainId === chainId ? authorization : null
        },
        async setChainAuthorizedAccounts() {},
        async removeChainAuthorization() {}
      },
      approval: {
        async requestExternalApproval() {
          return { approved: true, requestId: 'unused' }
        },
        async broadcastProviderEvent(origin, chainId, eventName, data) {
          events.push({ origin, chainId, eventName, data })
        }
      }
    })

    await state.handler.notifyAccountsChanged()
    expect(events).toEqual([
      {
        origin: 'https://previous.example',
        chainId: 'evm',
        eventName: 'accountsChanged',
        data: []
      },
      {
        origin: 'https://current.example',
        chainId: 'evm',
        eventName: 'accountsChanged',
        data: [account.chainAccount.identity.value]
      }
    ])
  })
})
