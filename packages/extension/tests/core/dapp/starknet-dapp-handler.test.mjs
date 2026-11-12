import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  createStarknetDAppHandler,
  revokeAllStarknetPermissions
} from '../../../src/background/starknet-dapp-handler.ts'
import { StarknetProviderError } from '../../../src/core/dapp/starknet-provider.ts'

const origin = 'https://example.test'
const address = '0x58ac366fa8dc98e25a85c7343bcca64324c2e7e65c017785c363d1066ce072a'
const publicKey = '0x7f0ecd1ec6159e6a7c70084aaa7d693d9113149b80ab72618602a185e2c1f2b'
const strk = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d'

function account(overrides = {}) {
  return {
    address,
    publicKey,
    classHash: '0x05b4b537eaa2399e3aa99c4e2e0208ebd6c71bc1467938cd52c798c601e43564',
    implementation: 'open_zeppelin',
    accountIndex: 0,
    addressIndex: 0,
    keyDomainId: 'key-domain:test',
    accountId: 'account:test',
    ...overrides
  }
}

const wasmInvokeHash = '0x47925e9fbb257d423cff737a67c87d38c652eba94ab17d6647d27b8df4f48ff'

function invokeRequest() {
  return {
    method: 'wallet_addInvokeTransaction',
    params: {
      invoke_transaction: [
        { contract_address: strk, entry_point: 'transfer', calldata: [address, '0x1', '0x0'] }
      ]
    }
  }
}

function harness({
  approved = true,
  quote = true,
  signer = true,
  network = 'mainnet',
  changeAccountAfterApproval = false,
  confirmInvoke = async () => ({ transactionHash: wasmInvokeHash }),
  ensureUnlocked = async () => {}
} = {}) {
  const calls = []
  let current = account()
  const handler = createStarknetDAppHandler({
    getNetwork: () => network,
    isUnlocked: () => true,
    ensureUnlocked,
    getAccount: () => current,
    requestApproval: async (_origin, action) => {
      calls.push(['approval', action])
      if (changeAccountAfterApproval && action === 'starknetTransaction') {
        current = account({ address: '0x1234' })
      }
      return { approved }
    },
    quoteInvoke: quote
      ? {
          quote: async () => ({
            nonce: '0x1',
            resourceBounds: {
              l1Gas: { maxAmount: '1', maxPricePerUnit: '1' },
              l2Gas: { maxAmount: '1', maxPricePerUnit: '1' },
              l1DataGas: { maxAmount: '1', maxPricePerUnit: '1' }
            }
          })
        }
      : null,
    signer: signer
      ? {
          prepare: async payload => {
            calls.push(['prepare', payload])
            return { signingCommandId: 'signing-command:test' }
          },
          confirmInvoke,
          confirmTypedData: async () => ({ signature: ['0x1', '0x2'] })
        }
      : null,
    broadcast: async () => {}
  })
  return {
    handler,
    calls,
    replaceAccount(next) {
      current = next
    }
  }
}

test.beforeEach(() => {
  revokeAllStarknetPermissions()
})

test('STRK20 methods are unsupported and a proof is rejected before signing', async () => {
  const { handler, calls } = harness()
  await expect(
    handler.request({ method: 'wallet_strk20InvokeTransaction' }, origin)
  ).rejects.toMatchObject({
    code: 4200
  })
  await expect(handler.request({ method: 'wallet_strk20Balances' }, origin)).rejects.toMatchObject({
    code: 4200
  })
  await expect(
    handler.request({ method: 'wallet_addDeclareTransaction' }, origin)
  ).rejects.toMatchObject({
    code: 4200
  })
  await expect(
    handler.request(
      {
        method: 'wallet_addInvokeTransaction',
        params: { invoke_transaction: [], proof: { proof: '0x1' } }
      },
      origin
    )
  ).rejects.toBeInstanceOf(StarknetProviderError)
  expect(calls.some(call => call[0] === 'prepare')).toBe(false)
})

test('a silent account read does not unlock or open connect approval', async () => {
  let unlocks = 0
  const { handler, calls } = harness({
    ensureUnlocked: async () => {
      unlocks += 1
    }
  })
  await expect(
    handler.request({ method: 'wallet_requestAccounts', params: { silent_mode: true } }, origin)
  ).resolves.toEqual([])
  expect(unlocks).toBe(0)
  expect(calls).toEqual([])
})

test('an explicit account request opens connect approval after unlock', async () => {
  let unlocks = 0
  const { handler, calls } = harness({
    ensureUnlocked: async () => {
      unlocks += 1
    }
  })
  await expect(handler.request({ method: 'wallet_requestAccounts' }, origin)).resolves.toEqual([
    address
  ])
  expect(unlocks).toBe(1)
  expect(calls).toEqual([['approval', 'starknetConnect']])
  unlocks = 0
  calls.length = 0
  await expect(
    handler.request({ method: 'wallet_requestAccounts', params: { silent_mode: true } }, origin)
  ).resolves.toEqual([address])
  expect(unlocks).toBe(0)
  expect(calls).toEqual([])
})

test('force_review opens connect approval again after the account is authorized', async () => {
  const { handler, calls } = harness()
  await handler.request({ method: 'wallet_requestAccounts' }, origin)
  calls.length = 0
  await expect(
    handler.request({ method: 'wallet_requestAccounts', params: { force_review: true } }, origin)
  ).resolves.toEqual([address])
  expect(calls).toEqual([['approval', 'starknetConnect']])
  calls.length = 0
  await expect(
    handler.request(
      {
        method: 'wallet_requestAccounts',
        params: { silent_mode: true, force_review: true }
      },
      origin
    )
  ).resolves.toEqual([address])
  expect(calls).toEqual([])
})

test('typed data approval shows the message text and network name', async () => {
  const approvals = []
  const handler = createStarknetDAppHandler({
    getNetwork: () => 'testnet',
    isUnlocked: () => true,
    ensureUnlocked: async () => {},
    getAccount: () => account(),
    requestApproval: async (_origin, action, data) => {
      approvals.push({ action, data })
      return { approved: action !== 'starknetMessage' }
    },
    quoteInvoke: null,
    signer: {
      prepare: async () => ({ signingCommandId: 'signing-command:test' }),
      confirmInvoke: async () => ({ transactionHash: '0x1' }),
      confirmTypedData: async () => ({ signature: ['0x1', '0x2'] })
    },
    broadcast: async () => {}
  })
  await handler.request({ method: 'wallet_requestAccounts' }, origin)
  await expect(
    handler.request(
      {
        method: 'wallet_signTypedData',
        params: {
          typed_data: {
            types: {
              StarknetDomain: [
                { name: 'name', type: 'shortstring' },
                { name: 'version', type: 'shortstring' },
                { name: 'chainId', type: 'shortstring' },
                { name: 'revision', type: 'shortstring' }
              ],
              Message: [{ name: 'contents', type: 'shortstring' }]
            },
            primaryType: 'Message',
            domain: { name: 'Noir', version: '1', chainId: 'SN_SEPOLIA', revision: '1' },
            message: { contents: 'Hello Noir Wallet' }
          }
        }
      },
      origin
    )
  ).rejects.toMatchObject({ code: 113 })
  const review = approvals.find(item => item.action === 'starknetMessage')
  expect(review.data.message).toBe('Hello Noir Wallet')
  expect(review.data.networkName).toBe('Starknet Sepolia')
  expect(review.data.primaryType).toBe('Message')
})

test('switch succeeds only for the current network mode', async () => {
  const { handler } = harness({ network: 'mainnet' })
  await expect(
    handler.request(
      { method: 'wallet_switchStarknetChain', params: { chainId: '0x534e5f4d41494e' } },
      origin
    )
  ).resolves.toBe(true)
  await expect(
    handler.request(
      { method: 'wallet_switchStarknetChain', params: { chainId: '0x534e5f5345504f4c4941' } },
      origin
    )
  ).rejects.toMatchObject({ code: 117 })
})

test('watchAsset accepts only a registered token and deployment data uses the software preset', async () => {
  const { handler } = harness()
  await expect(
    handler.request(
      { method: 'wallet_watchAsset', params: { type: 'ERC20', options: { address: strk } } },
      origin
    )
  ).resolves.toBe(true)
  await expect(
    handler.request(
      {
        method: 'wallet_watchAsset',
        params: { type: 'ERC20', options: { address: '0x1234' } }
      },
      origin
    )
  ).rejects.toMatchObject({ code: 114 })
  await handler.request({ method: 'wallet_requestAccounts' }, origin)
  const deployment = await handler.request({ method: 'wallet_deploymentData' }, origin)
  expect(deployment.calldata).toEqual([publicKey])
  expect(deployment.version).toBe(1)
})

test('an approved invoke is rechecked and does not send a proof to the signer', async () => {
  const { handler, calls, replaceAccount } = harness()
  const result = await handler.request(
    {
      method: 'wallet_addInvokeTransaction',
      params: {
        invoke_transaction: [
          { contract_address: strk, entry_point: 'transfer', calldata: [address, '0x1', '0x0'] }
        ]
      }
    },
    origin
  )
  expect(result.transaction_hash).toBe(
    '0x47925e9fbb257d423cff737a67c87d38c652eba94ab17d6647d27b8df4f48ff'
  )
  const payload = calls.find(call => call[0] === 'prepare')[1]
  expect(payload.kind).toBe('starknet-invoke')
  expect(payload.proof).toBeUndefined()
  expect(payload.calls[0].entrypoint).toBe('transfer')
  expect(payload.calls[0].selector).toBeUndefined()
  expect(calls.some(call => call[0] === 'approval' && call[1] === 'starknetTransaction')).toBe(true)
})

test('wallet_addInvokeTransaction rejects when confirmInvoke rejects', async () => {
  const { handler, calls } = harness({
    confirmInvoke: async () => {
      throw new Error('starknet_addInvokeTransaction failed')
    }
  })
  const outcome = await handler.request(invokeRequest(), origin).then(
    value => ({ settled: 'resolved', value }),
    error => ({ settled: 'rejected', error })
  )
  expect(outcome.settled).toBe('rejected')
  expect(outcome.error).toBeInstanceOf(Error)
  expect(outcome.error.message).toContain('starknet_addInvokeTransaction failed')
  expect(calls.some(call => call[0] === 'prepare')).toBe(true)
  expect(outcome.value).toBeUndefined()
})

test('wallet_addInvokeTransaction returns the hash confirmInvoke got from the node', async () => {
  const nodeHash = '0x11c0ffee'
  const { handler } = harness({
    confirmInvoke: async () => ({ transactionHash: nodeHash })
  })
  const result = await handler.request(invokeRequest(), origin)
  expect(result.transaction_hash).toBe(nodeHash)
  expect(result.transaction_hash).not.toBe(wasmInvokeHash)
})

test('a changed account after approval is not signed', async () => {
  const { handler } = harness({ changeAccountAfterApproval: true })
  await expect(
    handler.request(
      {
        method: 'wallet_addInvokeTransaction',
        params: {
          invoke_transaction: [
            { contract_address: strk, entry_point: 'transfer', calldata: [address, '0x1', '0x0'] }
          ]
        }
      },
      origin
    )
  ).rejects.toMatchObject({ code: 4100 })
})

test('signing is not attempted when the session signer is not connected', async () => {
  const { handler, calls } = harness({ signer: false, quote: false })
  await handler.request({ method: 'wallet_requestAccounts' }, origin)
  await expect(
    handler.request(
      {
        method: 'wallet_addInvokeTransaction',
        params: {
          invoke_transaction: [
            { contract_address: strk, entry_point: 'transfer', calldata: [address, '0x1', '0x0'] }
          ]
        }
      },
      origin
    )
  ).rejects.toMatchObject({ code: 163 })
  expect(calls.some(call => call[0] === 'prepare')).toBe(false)
})

test('wallet_supportedSpecs is the JSON-RPC version, not the Wallet API version', async () => {
  const { handler } = harness()
  await expect(handler.request({ method: 'wallet_supportedSpecs' }, origin)).resolves.toEqual([
    '0.10.3'
  ])
  await expect(handler.request({ method: 'wallet_supportedWalletApi' }, origin)).resolves.toEqual([
    '0.10.4'
  ])
})

test('a Ledger account uses the Ledger signer and leaves the software signer unused', async () => {
  const prepared = []
  const ledger = []
  const handler = createStarknetDAppHandler({
    getNetwork: () => 'mainnet',
    isUnlocked: () => true,
    ensureUnlocked: async () => {},
    getAccount: () =>
      account({
        keySource: 'ledger',
        implementation: 'argent_v0_4',
        classHash: '0x036078334509b514626504edc9fb252328d1a240e4e948bef8d0c08dff45927f'
      }),
    requestApproval: async () => ({ approved: true }),
    quoteInvoke: {
      quote: async () => ({
        nonce: '0x1',
        resourceBounds: {
          l1Gas: { maxAmount: '1', maxPricePerUnit: '1' },
          l2Gas: { maxAmount: '1', maxPricePerUnit: '1' },
          l1DataGas: { maxAmount: '0', maxPricePerUnit: '0' }
        }
      })
    },
    signer: {
      prepare: async payload => {
        prepared.push(payload)
        return { signingCommandId: 'signing-command:test' }
      },
      confirmInvoke: async () => ({ transactionHash: '0x1' }),
      confirmTypedData: async () => ['0x1', '0x2']
    },
    ledger: {
      submitInvoke: async input => {
        ledger.push(input)
        return {
          transactionHash: '0x47925e9fbb257d423cff737a67c87d38c652eba94ab17d6647d27b8df4f48ff'
        }
      },
      signTypedData: async () => ['0x1', '0x2']
    },
    broadcast: async () => {}
  })
  await handler.request({ method: 'wallet_requestAccounts' }, origin)
  const result = await handler.request(
    {
      method: 'wallet_addInvokeTransaction',
      params: {
        invoke_transaction: [
          { contract_address: strk, entry_point: 'transfer', calldata: [address, '0x1', '0x0'] }
        ]
      }
    },
    origin
  )
  expect(result.transaction_hash).toBe(
    '0x47925e9fbb257d423cff737a67c87d38c652eba94ab17d6647d27b8df4f48ff'
  )
  expect(prepared).toEqual([])
  expect(ledger[0].blindSigning).toBe(false)
})

test('wallet_requestAccounts waits for an asynchronously resolved Ledger account', async () => {
  const handler = createStarknetDAppHandler({
    getNetwork: () => 'mainnet',
    isUnlocked: () => true,
    ensureUnlocked: async () => {},
    getAccount: async () =>
      account({
        keySource: 'ledger',
        implementation: 'argent_v0_4',
        classHash: '0x036078334509b514626504edc9fb252328d1a240e4e948bef8d0c08dff45927f'
      }),
    requestApproval: async () => ({ approved: true }),
    quoteInvoke: null,
    signer: null,
    ledger: null,
    broadcast: async () => {}
  })
  await expect(handler.request({ method: 'wallet_requestAccounts' }, origin)).resolves.toEqual([
    address
  ])
})

test('a Ledger multicall above 8 calls is rejected before review', async () => {
  const approvals = []
  const handler = createStarknetDAppHandler({
    getNetwork: () => 'mainnet',
    isUnlocked: () => true,
    ensureUnlocked: async () => {},
    getAccount: async () =>
      account({
        keySource: 'ledger',
        implementation: 'argent_v0_4',
        classHash: '0x036078334509b514626504edc9fb252328d1a240e4e948bef8d0c08dff45927f'
      }),
    requestApproval: async (_origin, action) => {
      approvals.push(action)
      return { approved: true }
    },
    quoteInvoke: {
      quote: async () => {
        throw new Error('quoted')
      }
    },
    signer: null,
    ledger: {
      submitInvoke: async () => {
        throw new Error('signed')
      },
      signTypedData: async () => ['0x1', '0x2']
    },
    broadcast: async () => {}
  })
  await handler.request({ method: 'wallet_requestAccounts' }, origin)
  const call = { contract_address: strk, entry_point: 'transfer', calldata: [address, '0x1', '0x0'] }
  await expect(
    handler.request(
      {
        method: 'wallet_addInvokeTransaction',
        params: { invoke_transaction: Array.from({ length: 9 }, () => call) }
      },
      origin
    )
  ).rejects.toMatchObject({ code: 114 })
  expect(approvals).toEqual(['starknetConnect'])
})
