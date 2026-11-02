import { test } from 'node:test'
import { expect } from '@playwright/test'
import { encodeFunctionResult, parseAbi } from 'viem'

import { readEvmTokenAllowance } from '../../../../src/infrastructure/chains/evm/evm-token-allowance.ts'
import { requiredRheaEvmApproval } from '../../../../src/popup/services/rhea-evm-approval.ts'

const token = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const owner = '0x1111111111111111111111111111111111111111'
const spender = '0x2222222222222222222222222222222222222222'
const allowanceAbi = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)'
])
const approval = Object.freeze({
  transaction: { chainId: 1, to: token, data: '0x', value: '0', from: owner },
  spender,
  amountRaw: '2000000'
})

test('reads the exact ERC-20 allowance from the attested EVM chain', async () => {
  const calls = []
  const rpc = {
    assertExpectedChain: async () => calls.push(['chain']),
    callContract: async (contract, data) => {
      calls.push(['call', contract, data])
      return encodeFunctionResult({
        abi: allowanceAbi,
        functionName: 'allowance',
        result: 2_000_000n
      })
    }
  }

  await expect(readEvmTokenAllowance(rpc, token, owner, spender)).resolves.toBe('2000000')
  expect(calls).toEqual([
    ['chain'],
    [
      'call',
      token,
      `0xdd62ed3e${owner.slice(2).padStart(64, '0')}${spender.slice(2).padStart(64, '0')}`
    ]
  ])
  await expect(readEvmTokenAllowance(rpc, 'not-an-address', owner, spender)).rejects.toThrow(
    /allowance address/
  )
  expect(calls).toHaveLength(2)
})

test('skips a repeated approval only when the current spender allowance covers the new quote', async () => {
  const reads = []
  const getTokenAllowance = async (...args) => {
    reads.push(args)
    return args[2] === spender ? '2000000' : '0'
  }
  const input = {
    approval,
    chainId: 'eip155:1',
    owner,
    executionMode: 'main',
    getTokenAllowance
  }

  await expect(requiredRheaEvmApproval(input)).resolves.toBeNull()
  await expect(
    requiredRheaEvmApproval({ ...input, approval: { ...approval, amountRaw: '2000001' } })
  ).resolves.toMatchObject({ amountRaw: '2000001' })
  await expect(
    requiredRheaEvmApproval({
      ...input,
      approval: { ...approval, spender: '0x3333333333333333333333333333333333333333' }
    })
  ).resolves.toMatchObject({ spender: '0x3333333333333333333333333333333333333333' })
  await expect(requiredRheaEvmApproval({ ...input, approval: null })).resolves.toBeNull()
  expect(reads).toEqual([
    ['eip155:1', token, spender, owner, 'main'],
    ['eip155:1', token, spender, owner, 'main'],
    ['eip155:1', token, '0x3333333333333333333333333333333333333333', owner, 'main']
  ])
  await expect(
    requiredRheaEvmApproval({
      ...input,
      getTokenAllowance: async () => {
        throw new Error('RPC unavailable')
      }
    })
  ).rejects.toThrow('RPC unavailable')
})
