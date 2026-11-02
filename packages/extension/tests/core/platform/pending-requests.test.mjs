import { test } from 'node:test'
import { expect } from '@playwright/test'
import { PendingRequestsManager } from '../../../src/background/pending-requests.ts'

test.describe('Pending request context cancellation', () => {
  test('cancels requests outside the active Wallet and Account context', () => {
    const manager = new PendingRequestsManager()
    const retained = manager.create('https://one.example', 'send', {}, 'wallet-1', 'account-1')
    const staleWallet = manager.create('https://two.example', 'send', {}, 'wallet-2', 'account-1')
    const staleAccount = manager.create(
      'https://three.example',
      'sign',
      {},
      'wallet-1',
      'account-2'
    )
    const cancelled = []
    manager.onCancel(retained, () => cancelled.push(retained))
    manager.onCancel(staleWallet, () => cancelled.push(staleWallet))
    manager.onCancel(staleAccount, () => cancelled.push(staleAccount))

    expect(manager.cancelExceptContext('wallet-1', 'account-1')).toBe(2)
    expect(manager.get(retained)?.id).toBe(retained)
    expect(manager.get(staleWallet)).toBeNull()
    expect(manager.get(staleAccount)).toBeNull()
    expect(new Set(cancelled)).toEqual(new Set([staleWallet, staleAccount]))

    manager.complete(retained)
    expect(cancelled).not.toContain(retained)
  })

  test('global cancellation settles each request once and clears its timer', () => {
    const manager = new PendingRequestsManager()
    const first = manager.create('https://one.example', 'send', {}, 'wallet-1', 'account-1')
    const second = manager.create('https://two.example', 'sign', {}, 'wallet-1', 'account-1')
    const cancelled = []
    manager.onCancel(first, () => cancelled.push(first))
    manager.onCancel(second, () => cancelled.push(second))

    expect(manager.cancelAll()).toBe(2)
    expect(manager.cancelAll()).toBe(0)
    expect(cancelled).toEqual([first, second])
    expect(manager.consume(first)).toBeNull()
  })

  test('updates review data only while the approval is pending', () => {
    const manager = new PendingRequestsManager()
    const requestId = manager.create(
      'https://one.example',
      'evmTransaction',
      { feeTier: 'standard' },
      'wallet-1',
      'account-1'
    )

    expect(manager.updateData(requestId, { feeTier: 'fast' })).toBe(true)
    expect(manager.get(requestId)?.data).toEqual({ feeTier: 'fast' })
    manager.complete(requestId)
    expect(manager.updateData(requestId, { feeTier: 'low' })).toBe(false)
  })

  test('cancels only requests bound to a removed Account or Wallet', () => {
    const manager = new PendingRequestsManager()
    const removedAccount = manager.create(
      'https://one.example',
      'send',
      {},
      'wallet-1',
      'account-1'
    )
    const retainedAccount = manager.create(
      'https://two.example',
      'send',
      {},
      'wallet-1',
      'account-2'
    )
    const retainedWallet = manager.create(
      'https://three.example',
      'sign',
      {},
      'wallet-2',
      'account-1'
    )

    expect(manager.cancelContext('wallet-1', 'account-1')).toBe(1)
    expect(manager.get(removedAccount)).toBeNull()
    expect(manager.get(retainedAccount)).not.toBeNull()
    expect(manager.get(retainedWallet)).not.toBeNull()
    expect(manager.cancelContext('wallet-1')).toBe(1)
    expect(manager.get(retainedAccount)).toBeNull()
    expect(manager.get(retainedWallet)).not.toBeNull()
    manager.cancelAll()
  })

  test('cancels only matching approval actions for one origin', () => {
    const manager = new PendingRequestsManager()
    const zcash = manager.create('https://one.example', 'signMessage', {}, 'wallet-1', 'account-1')
    const evm = manager.create('https://one.example', 'evmMessage', {}, 'wallet-1', 'account-1')
    const other = manager.create('https://two.example', 'signMessage', {}, 'wallet-1', 'account-1')

    expect(manager.cancelOrigin('https://one.example', action => action === 'signMessage')).toBe(1)
    expect(manager.get(zcash)).toBeNull()
    expect(manager.get(evm)).not.toBeNull()
    expect(manager.get(other)).not.toBeNull()
    expect(manager.cancelOrigin('https://one.example')).toBe(1)
    expect(manager.get(evm)).toBeNull()
    manager.cancelAll()
  })

  test('counts and cancels matching actions only within one Account context', () => {
    const manager = new PendingRequestsManager()
    const evmTransaction = manager.create(
      'https://one.example',
      'evmTransaction',
      {},
      'wallet-1',
      'account-1'
    )
    const evmMessage = manager.create(
      'https://two.example',
      'evmMessage',
      {},
      'wallet-1',
      'account-1'
    )
    const zcash = manager.create('https://one.example', 'signMessage', {}, 'wallet-1', 'account-1')
    const otherAccount = manager.create(
      'https://three.example',
      'evmTransaction',
      {},
      'wallet-1',
      'account-2'
    )
    const isEvm = action => action === 'evmTransaction' || action === 'evmMessage'

    expect(manager.countContext('wallet-1', 'account-1', isEvm)).toBe(2)
    expect(manager.cancelContextMatching('wallet-1', 'account-1', isEvm)).toBe(2)
    expect(manager.get(evmTransaction)).toBeNull()
    expect(manager.get(evmMessage)).toBeNull()
    expect(manager.get(zcash)).not.toBeNull()
    expect(manager.get(otherAccount)).not.toBeNull()
    manager.cancelAll()
  })
})
