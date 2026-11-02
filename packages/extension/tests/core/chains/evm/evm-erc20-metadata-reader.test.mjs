import { test } from 'node:test'
import { expect } from '@playwright/test'
import { readErc20Metadata } from '../../../../src/infrastructure/chains/evm/evm-erc20-metadata-reader.ts'

const CONTRACT = '0x1111111111111111111111111111111111111111'

function word(value) {
  return BigInt(value).toString(16).padStart(64, '0')
}

function dynamicString(value) {
  const bytes = new TextEncoder().encode(value)
  const data = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `0x${word(32)}${word(bytes.length)}${data.padEnd(Math.ceil(bytes.length / 32) * 64, '0')}`
}

function bytes32(value) {
  const bytes = new TextEncoder().encode(value)
  const data = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `0x${data.padEnd(64, '0')}`
}

function createRpc(results) {
  const selectors = []
  return {
    selectors,
    rpc: {
      assertExpectedChain: async () => {},
      getCode: async () => results.code ?? '0x6001600055',
      callContract: async (_address, selector) => {
        selectors.push(selector)
        if (selector === '0x06fdde03') return results.name
        if (selector === '0x95d89b41') return results.symbol
        if (selector === '0x313ce567') return results.decimals
        throw new Error('Unexpected selector')
      }
    }
  }
}

test('reads standard dynamic ERC-20 metadata after chain and bytecode attestation', async () => {
  const { rpc, selectors } = createRpc({
    name: dynamicString('USD Coin'),
    symbol: dynamicString('USDC'),
    decimals: `0x${word(6)}`
  })

  await expect(readErc20Metadata(rpc, CONTRACT)).resolves.toEqual({
    name: 'USD Coin',
    symbol: 'USDC',
    decimals: 6
  })
  expect(selectors).toEqual(['0x06fdde03', '0x95d89b41', '0x313ce567'])
})

test('supports legacy bytes32 name and symbol responses', async () => {
  const { rpc } = createRpc({
    name: bytes32('Legacy Token'),
    symbol: bytes32('LEG'),
    decimals: `0x${word(18)}`
  })

  await expect(readErc20Metadata(rpc, CONTRACT)).resolves.toEqual({
    name: 'Legacy Token',
    symbol: 'LEG',
    decimals: 18
  })
})

test('rejects EOAs, malformed ABI strings, invalid UTF-8, and unsupported decimals', async () => {
  const eoa = createRpc({
    code: '0x',
    name: dynamicString('Token'),
    symbol: dynamicString('TOK'),
    decimals: `0x${word(18)}`
  })
  await expect(readErc20Metadata(eoa.rpc, CONTRACT)).rejects.toThrow(/does not contain/)
  expect(eoa.selectors).toEqual([])

  for (const results of [
    {
      name: `0x${word(32)}${word(3)}fffeff${'0'.repeat(58)}`,
      symbol: dynamicString('TOK'),
      decimals: `0x${word(18)}`
    },
    {
      name: `0x${word(64)}${word(1)}61${'0'.repeat(62)}`,
      symbol: dynamicString('TOK'),
      decimals: `0x${word(18)}`
    },
    {
      name: dynamicString('Token'),
      symbol: dynamicString('TOK'),
      decimals: `0x${word(256)}`
    }
  ]) {
    const { rpc } = createRpc(results)
    await expect(readErc20Metadata(rpc, CONTRACT)).rejects.toThrow(/Invalid ERC-20/)
  }
})
