import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  DEFAULT_CHAIN_ENDPOINT_SETTINGS,
  withChainExplorer,
  withChainRpcEndpoint
} from '../../../src/core/chains/chain-endpoint-settings.ts'
import {
  EvmDAppNetworkSwitchCoordinator,
  handleEvmDAppNetworkSwitch
} from '../../../src/background/evm-dapp-network-switch.ts'

const bscRequest = { chainId: '0x38', numericChainId: 56 }

function harness(overrides = {}) {
  let settings = DEFAULT_CHAIN_ENDPOINT_SETTINGS
  const approvals = []
  const applied = []
  const reloaded = []
  const commits = []
  return {
    options: {
      readSettings: async () => settings,
      commitActiveChain: async (chainId, origin) => {
        commits.push({ chainId, origin })
        const next = {
          ...settings,
          activeEvmChainId: chainId
        }
        settings = next
        applied.push(next)
        reloaded.push(next)
      },
      requestApproval: async (origin, action, data) => {
        approvals.push({ origin, action, data })
        return { approved: true }
      },
      ...overrides
    },
    approvals,
    applied,
    reloaded,
    commits,
    getSettings: () => settings,
    setSettings: next => {
      settings = next
    }
  }
}

test.describe('EVM dApp network switch coordinator', () => {
  test('merges an approved switch into the latest endpoint settings', async () => {
    const state = harness()
    state.options.requestApproval = async (origin, action, data) => {
      state.approvals.push({ origin, action, data })
      state.setSettings(
        withChainExplorer(
          withChainRpcEndpoint(state.getSettings(), 'eip155:1', {
            protocol: 'evm-json-rpc',
            label: 'Updated Ethereum RPC',
            url: 'https://ethereum-rpc.example'
          }),
          'eip155:56',
          {
            label: 'Updated BSC explorer',
            baseUrl: 'https://bsc-explorer.example',
            transactionPath: 'transaction'
          }
        )
      )
      return { approved: true }
    }

    await handleEvmDAppNetworkSwitch(bscRequest, 'https://dapp.example', 'switch', state.options)

    expect(state.approvals).toEqual([
      {
        origin: 'https://dapp.example',
        action: 'evmNetwork',
        data: {
          action: 'switch',
          chainId: 'eip155:56',
          chainName: 'BNB Chain',
          iconChain: 'bsc'
        }
      }
    ])
    expect(state.applied).toHaveLength(1)
    expect(state.commits).toEqual([{ chainId: 'eip155:56', origin: 'https://dapp.example' }])
    expect(state.applied[0]).toMatchObject({
      activeEvmChainId: 'eip155:56',
      overrides: [
        { chainId: 'eip155:1', rpc: { url: 'https://ethereum-rpc.example/' } },
        {
          chainId: 'eip155:56',
          explorer: {
            baseUrl: 'https://bsc-explorer.example',
            transactionPath: 'transaction'
          }
        }
      ]
    })
    expect(state.reloaded).toEqual(state.applied)
  })

  test('does not mutate settings for a rejected or unsupported switch', async () => {
    const rejected = harness({ requestApproval: async () => ({ approved: false }) })
    await expect(
      handleEvmDAppNetworkSwitch(bscRequest, 'https://dapp.example', 'switch', rejected.options)
    ).rejects.toMatchObject({ code: 4001 })
    expect(rejected.applied).toEqual([])
    expect(rejected.reloaded).toEqual([])

    const unsupported = harness()
    await expect(
      handleEvmDAppNetworkSwitch(
        { chainId: '0x7a69', numericChainId: 31337 },
        'https://dapp.example',
        'switch',
        unsupported.options
      )
    ).rejects.toMatchObject({ code: 4902 })
    expect(unsupported.approvals).toEqual([])
  })

  test('shares one pending approval for the same request and permits retry after rejection', async () => {
    const coordinator = new EvmDAppNetworkSwitchCoordinator()
    let resolveApproval
    let signalApproval
    const approvalStarted = new Promise(resolve => {
      signalApproval = resolve
    })
    const decision = new Promise(resolve => {
      resolveApproval = resolve
    })
    const state = harness({
      requestApproval: async (origin, action, data) => {
        state.approvals.push({ origin, action, data })
        signalApproval()
        return decision
      }
    })
    const first = coordinator.run(
      bscRequest,
      'https://dapp.example',
      'switch',
      'account-a',
      state.options
    )
    const second = coordinator.run(
      bscRequest,
      'https://dapp.example',
      'switch',
      'account-a',
      state.options
    )

    await approvalStarted
    expect(state.approvals).toHaveLength(1)
    resolveApproval({ approved: false })
    await expect(Promise.all([first, second])).rejects.toMatchObject({ code: 4001 })
    expect(state.commits).toEqual([])

    await expect(
      coordinator.run(bscRequest, 'https://dapp.example', 'switch', 'account-a', state.options)
    ).rejects.toMatchObject({ code: 4001 })
    expect(state.approvals).toHaveLength(2)
  })

  test('keeps different network metadata and wallet contexts separate', async () => {
    const coordinator = new EvmDAppNetworkSwitchCoordinator()
    let resolveApprovals
    const decision = new Promise(resolve => {
      resolveApprovals = resolve
    })
    const state = harness({
      requestApproval: async (origin, action, data) => {
        state.approvals.push({ origin, action, data })
        return decision
      }
    })
    const customRequest = rpcUrl => ({
      chainId: '0x7a69',
      numericChainId: 31337,
      metadata: {
        chainName: 'Example',
        nativeCurrency: { name: 'Example', symbol: 'EX', decimals: 18 },
        rpcUrls: [rpcUrl],
        blockExplorerUrls: []
      }
    })
    const requests = [
      coordinator.run(
        customRequest('https://rpc-one.example/'),
        'https://dapp.example',
        'add',
        'account-a',
        state.options
      ),
      coordinator.run(
        customRequest('https://rpc-two.example/'),
        'https://dapp.example',
        'add',
        'account-a',
        state.options
      ),
      coordinator.run(
        customRequest('https://rpc-one.example/'),
        'https://dapp.example',
        'add',
        'account-b',
        state.options
      )
    ]

    await new Promise(resolve => setImmediate(resolve))
    expect(state.approvals).toHaveLength(3)
    resolveApprovals({ approved: false })
    const results = await Promise.allSettled(requests)
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected', 'rejected'])
    expect(state.commits).toEqual([])
  })
})
