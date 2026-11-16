import { test } from 'node:test'
import { expect } from '@playwright/test'

import { parseEvmPrivateTransferApproval } from '../../../src/popup/services/dapp-approval-summary.ts'

const valid = {
  chainId: 8453,
  chainName: 'Base',
  iconChain: 'base',
  sourceAddress: '0x1111111111111111111111111111111111111111',
  recipient: '0x2222222222222222222222222222222222222222',
  asset: { symbol: 'USDC', decimals: 6 },
  amountRaw: '1000000',
  estimatedOutputRaw: '999000',
  minimumOutputRaw: '995000',
  router: 'nearintents',
  expiresAt: 5_000,
  approvalRequired: true
}

test('strictly parses the bound dApp Private transfer approval', () => {
  expect(parseEvmPrivateTransferApproval(valid)).toEqual(valid)
})

test('requires exact receive amount and network fee for a dApp privacy route', () => {
  const exactOutput = {
    ...valid,
    estimatedOutputRaw: '999000',
    minimumOutputRaw: '999000',
    approvalRequired: false,
    exactOutput: true,
    networkFeeRaw: '21000000000000',
    nativeCurrency: { symbol: 'ETH', decimals: 18 }
  }
  expect(parseEvmPrivateTransferApproval(exactOutput)).toEqual(exactOutput)
  for (const value of [
    { ...exactOutput, minimumOutputRaw: '998999' },
    { ...exactOutput, amountRaw: '998999' },
    { ...exactOutput, networkFeeRaw: undefined },
    { ...exactOutput, approvalRequired: true }
  ]) {
    expect(parseEvmPrivateTransferApproval(value)).toBeNull()
  }
})

test('rejects approval data that can disguise a non-Confidential or substituted transfer', () => {
  for (const value of [
    { ...valid, router: 'direct' },
    { ...valid, recipient: '0x1234' },
    { ...valid, minimumOutputRaw: '1000001' },
    { ...valid, amountRaw: '0' },
    { ...valid, asset: { ...valid.asset, decimals: 256 } },
    { ...valid, extra: true }
  ]) {
    expect(parseEvmPrivateTransferApproval(value)).toBeNull()
  }
})
