import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  DEFAULT_CHAIN_ENDPOINT_SETTINGS,
  withChainExplorer,
  withChainRpcEndpoint
} from '../../../src/core/chains/chain-endpoint-settings.ts'
import { handleEvmDAppNetworkSwitch } from '../../../src/background/evm-dapp-network-switch.ts'

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
})
