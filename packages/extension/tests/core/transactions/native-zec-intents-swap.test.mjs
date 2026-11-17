import { test } from 'node:test'
import { expect } from '@playwright/test'
import { zatsToZec, zecToZats } from '../../../src/core/services/native-zec-intents-swap.ts'
import {
  markNativeZecIntentsSwapTerminal,
  NativeZecIntentsSwapCoordinator
} from '../../../src/background/native-zec-intents-swap.ts'

test('native ZEC Intents spend binds the approved quote and survives coordinator recreation', async () => {
  const walletId = 'wallet-one'
  const accountId = 'account-one'
  const quoteId = 'quote-one'
  const refundAddress = `t1${'A'.repeat(33)}`
  const depositAddress = `t1${'B'.repeat(33)}`
  const expiresAt = Date.now() + 600_000
  const destination = {
    chainId: 'eip155:1',
    assetId: 'eip155:1/slip44:60',
    protocolAssetId: 'nep141:eth.omft.near',
    recipient: '0x1111111111111111111111111111111111111111'
  }
  const quoteBinding = {
    provider: 'near-intents',
    quoteHandle: quoteId,
    isCrossChain: true,
    destinationChain: destination.chainId,
    depositAddress,
    originAsset: 'nep141:zec.omft.near',
    destinationAsset: destination.protocolAssetId,
    expectedAmountOut: '1000',
    minAmountOut: '900',
    recipient: destination.recipient,
    refundTo: refundAddress,
    deadline: expiresAt
  }
  const record = {
    schemaVersion: 1,
    quoteId,
    network: 'mainnet',
    walletId,
    accountId,
    amountZats: '125000000',
    amountZec: '1.25',
    depositAddress,
    destination,
    destinationBlockchain: 'eth',
    destinationSymbol: 'ETH',
    destinationDecimals: 18,
    refundAddress,
    expectedOutputRaw: '1000',
    minimumOutputRaw: '900',
    expiresAt,
    quoteBinding,
    slippageBps: 50,
    createdAt: Date.now()
  }
  const values = new Map([
    [`native_zec_intents_swap:${quoteId}`, structuredClone(record)],
    [
      'native_zec_intents_swap:quote-two',
      {
        ...structuredClone(record),
        quoteId: 'quote-two',
        quoteBinding: { ...quoteBinding, quoteHandle: 'quote-two' }
      }
    ],
    [
      'native_zec_intents_swap:quote-three',
      {
        ...structuredClone(record),
        schemaVersion: 2,
        quoteId: 'quote-three',
        recipientType: 'CONFIDENTIAL_INTENTS',
        fundingSource: 'transparent',
        quoteBinding: {
          ...quoteBinding,
          quoteHandle: 'quote-three',
          recipientType: 'CONFIDENTIAL_INTENTS',
          fundingSource: 'transparent'
        }
      }
    ],
    ['native_zec_intents_swap:index', [quoteId, 'quote-two', 'quote-three']]
  ])
  const previousChrome = globalThis.chrome
  const previousLocks = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks')
  globalThis.chrome = {
    storage: {
      onChanged: { addListener: () => {} },
      local: {
        get: async key =>
          key === null
            ? Promise.reject(new Error('Full storage read is forbidden'))
            : Object.fromEntries(
                (Array.isArray(key) ? key : [key])
                  .filter(item => values.has(item))
                  .map(item => [item, structuredClone(values.get(item))])
              ),
        set: async entries => {
          for (const [key, value] of Object.entries(entries))
            values.set(key, structuredClone(value))
        },
        remove: async key => {
          for (const item of Array.isArray(key) ? key : [key]) values.delete(item)
        }
      }
    }
  }
  Object.defineProperty(globalThis.navigator, 'locks', {
    configurable: true,
    value: { request: async (_name, operation) => operation() }
  })
  try {
    const options = {
      network: 'mainnet',
      assets: { get: () => undefined },
      evmNetworks: [],
      assetMappings: [],
      isUnlocked: async () => true,
      resolveConfidentialIdentity: async () => destination.recipient,
      getActiveAccount: () => ({
        network: 'mainnet',
        walletId,
        accountId,
        refundAddresses: [refundAddress, `u1${'q'.repeat(55)}`]
      })
    }
    const coordinator = new NativeZecIntentsSwapCoordinator(options)
    const lockedCoordinator = new NativeZecIntentsSwapCoordinator({
      ...options,
      isUnlocked: async () => false
    })
    const spend = {
      walletId,
      accountId,
      transactionId: 'transaction-one',
      binding: quoteBinding,
      to: depositAddress,
      amount: '1.25',
      fundingSource: 'shielded'
    }
    await expect(coordinator.claimSpend({ ...spend, to: refundAddress })).rejects.toThrow()
    await expect(lockedCoordinator.get(quoteId)).rejects.toThrow('Wallet is locked')
    await expect(lockedCoordinator.claimSpend(spend)).rejects.toThrow('Wallet is locked')
    await expect(
      coordinator.claimSpend({ ...spend, fundingSource: 'transparent' })
    ).rejects.toThrow()
    await expect(
      coordinator.claimSpend({
        ...spend,
        binding: { ...quoteBinding, recipient: refundAddress }
      })
    ).rejects.toThrow()
    expect(await coordinator.claimSpend(spend)).toBe(expiresAt)
    expect(await coordinator.claimSpend(spend)).toBe(expiresAt)
    expect(values.get(`native_zec_intents_swap:${quoteId}`).claimedTransactionId).toBe(
      'transaction-one'
    )
    expect(await coordinator.cancel(quoteId)).toBe(false)
    expect(await coordinator.cancel('quote-two')).toBe(true)
    expect(values.get('native_zec_intents_swap:index')).toEqual([quoteId, 'quote-three'])
    const confidentialSpend = {
      ...spend,
      transactionId: 'transaction-three',
      binding: values.get('native_zec_intents_swap:quote-three').quoteBinding,
      fundingSource: 'transparent'
    }
    await expect(
      coordinator.claimSpend({ ...confidentialSpend, fundingSource: 'shielded' })
    ).rejects.toThrow()
    await expect(
      coordinator.claimSpend({
        ...confidentialSpend,
        binding: { ...confidentialSpend.binding, recipientType: 'DESTINATION_CHAIN' }
      })
    ).rejects.toThrow()
    expect(await coordinator.claimSpend(confidentialSpend)).toBe(expiresAt)
    expect(await coordinator.claimSpend(confidentialSpend)).toBe(expiresAt)
    await expect(
      new NativeZecIntentsSwapCoordinator(options).claimSpend({
        ...spend,
        transactionId: 'transaction-two'
      })
    ).rejects.toThrow()
    const expiredAt = Date.now() - 26 * 60 * 60_000
    for (const id of [quoteId, 'quote-three']) {
      const key = `native_zec_intents_swap:${id}`
      const stored = values.get(key)
      values.set(key, {
        ...stored,
        expiresAt: expiredAt,
        quoteBinding: { ...stored.quoteBinding, deadline: expiredAt }
      })
    }
    const newRequest = {
      network: 'mainnet',
      walletId,
      accountId,
      amountZats: '1',
      destination,
      refundAddress,
      slippageBps: 50
    }
    await expect(coordinator.prepare(newRequest)).rejects.toThrow('Native ZEC asset is unavailable')
    expect(values.has(`native_zec_intents_swap:${quoteId}`)).toBe(false)
    expect(values.has('native_zec_intents_swap:quote-three')).toBe(true)
    const terminalBinding = values.get('native_zec_intents_swap:quote-three').quoteBinding
    await markNativeZecIntentsSwapTerminal(terminalBinding, 'transaction-three', 'SUCCESS')
    expect(values.get('native_zec_intents_swap:quote-three').terminalStatus).toBe('SUCCESS')
    const settled = values.get('native_zec_intents_swap:quote-three')
    values.set('native_zec_intents_swap:quote-three', { ...settled, terminalAt: expiredAt })
    await expect(coordinator.prepare(newRequest)).rejects.toThrow('Native ZEC asset is unavailable')
    expect(values.has('native_zec_intents_swap:quote-three')).toBe(false)
  } finally {
    globalThis.chrome = previousChrome
    if (previousLocks === undefined) delete globalThis.navigator.locks
    else Object.defineProperty(globalThis.navigator, 'locks', previousLocks)
  }
})

test('native ZEC conversion preserves exact zats', () => {
  expect(zatsToZec('125000001')).toBe('1.25000001')
  expect(zecToZats('1.25000001')).toBe('125000001')
  expect(() => zecToZats('1.000000001')).toThrow()
})
