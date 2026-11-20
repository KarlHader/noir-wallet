import { test } from 'node:test'
import { expect } from '@playwright/test'

import { AccountContextTransitionCoordinator } from '../../../src/background/account-context-transition.ts'
import { forwardPageWorkerRpcWithAccountAuthority } from '../../../src/background/page-worker-account-authority.ts'

const account0 = Object.freeze({ walletId: 'wallet:0', accountId: 'account:0' })
const account1 = Object.freeze({ walletId: 'wallet:0', accountId: 'account:1' })

test('serializes active operations with Account invalidation and pointer commit', async () => {
  const coordinator = new AccountContextTransitionCoordinator()
  const events = []
  let current = account0
  let releaseOperation
  let markOperationStarted
  const operationBlocked = new Promise(resolve => {
    releaseOperation = resolve
  })
  const operationStarted = new Promise(resolve => {
    markOperationStarted = resolve
  })
  coordinator.registerInvalidator({
    invalidate: async request => {
      events.push(['invalidate', request])
    }
  })

  const active = coordinator.runActiveOperation(async () => {
    events.push(['operation-start', current])
    markOperationStarted()
    await operationBlocked
    events.push(['operation-end', current])
  })
  const switched = coordinator.runAccountSwitch(account1, {
    readCurrent: () => current,
    validateTarget: () => events.push(['validate', account1]),
    commit: async () => {
      events.push(['commit', current, account1])
      current = account1
      return 'switched'
    }
  })
  const afterSwitch = coordinator.runActiveOperation(async () => {
    events.push(['after-switch', current])
  })

  await operationStarted
  expect(events).toEqual([['operation-start', account0]])
  releaseOperation()
  await expect(Promise.all([active, switched, afterSwitch])).resolves.toEqual([
    undefined,
    'switched',
    undefined
  ])
  expect(events).toEqual([
    ['operation-start', account0],
    ['operation-end', account0],
    ['validate', account1],
    ['invalidate', { mode: 'scope', scope: account0 }],
    ['commit', account0, account1],
    ['after-switch', account1]
  ])
})

test('does not change the active pointer when context invalidation fails', async () => {
  const coordinator = new AccountContextTransitionCoordinator()
  let current = account0
  let committed = false
  coordinator.registerInvalidator({
    invalidate: async () => {
      throw new Error('signing cancellation unavailable')
    }
  })

  await expect(
    coordinator.runAccountSwitch(account1, {
      readCurrent: () => current,
      validateTarget: () => {},
      commit: async () => {
        committed = true
        current = account1
      }
    })
  ).rejects.toThrow(/cancellation unavailable/)
  expect(committed).toBe(false)
  expect(current).toBe(account0)
})

test('keeps a sync wait out of the shared queue and rejects work for an old account', async () => {
  const coordinator = new AccountContextTransitionCoordinator()
  const events = []
  let current = account0
  let finishSync
  const syncing = new Promise(resolve => {
    finishSync = resolve
  })
  const queuedSpend = coordinator.runActiveOperationWhenReady(
    async whenReady => {
      events.push('pause sync')
      try {
        await syncing
        return await whenReady()
      } finally {
        events.push('resume sync')
      }
    },
    async () => {
      if (current !== account0) throw new Error('Active account changed')
      events.push('sign Zcash')
    }
  )

  await coordinator.runActiveOperation(async () => {
    events.push('submit EVM')
  })
  await coordinator.runAccountSwitch(account1, {
    readCurrent: () => current,
    validateTarget: () => {},
    commit: async () => {
      current = account1
    }
  })
  expect(events).toEqual(['pause sync', 'submit EVM'])
  finishSync()
  await expect(queuedSpend).rejects.toThrow('Active account changed')
  expect(events).toEqual(['pause sync', 'submit EVM', 'resume sync'])
})

test('skips invalidation when selecting the already active Account', async () => {
  const coordinator = new AccountContextTransitionCoordinator()
  let invalidations = 0
  coordinator.registerInvalidator({
    invalidate: async () => {
      invalidations += 1
    }
  })

  await coordinator.runAccountSwitch(account0, {
    readCurrent: () => account0,
    validateTarget: () => {},
    commit: async () => {}
  })
  expect(invalidations).toBe(0)
})

const frostAccount = Object.freeze({
  id: 'frost-account',
  source: Object.freeze({ kind: 'frost-vault', version: 1, groupId: 'group', network: 'mainnet' })
})
const rawSensitiveMethods = [
  'transaction.send',
  'transaction.oneclick_shield',
  'pczt.create',
  'pczt.shieldCreate',
  'pczt.proveSend',
  'pczt.ledgerPayload',
  'pczt.applyLedgerSignatures',
  'message.sign',
  'wallet.getPublicKey',
  'voting.prepareRound',
  'voting.submitDelegation',
  'voting.submitBallot',
  'voting.resumeRound',
  'voting.clearRound'
]

test('rejects raw page account-sensitive RPC before forwarding while FROST is active', async () => {
  const coordinator = new AccountContextTransitionCoordinator()
  const forwarded = []
  const authority = {
    readActive: () => ({ account: frostAccount, network: 'mainnet' }),
    runActiveOperation: operation => coordinator.runActiveOperation(operation),
    forward: async (method, payload) => {
      forwarded.push([method, payload])
      return 'forwarded'
    }
  }
  const parentPayload = {
    walletId: 'same-parent-wallet',
    accountIndex: 0,
    accountId: 0,
    source: undefined
  }
  for (const method of rawSensitiveMethods) {
    await expect(
      forwardPageWorkerRpcWithAccountAuthority(method, parentPayload, authority)
    ).rejects.toThrow('Operation is unavailable for this FROST account')
  }
  expect(forwarded).toEqual([])
  for (const method of [
    'wallet.getBalance',
    'wallet.sync',
    'transaction.getFeeQuote',
    'transaction.estimateFee',
    'transaction.estimateMaxTransfer',
    'transaction.estimateShieldFee',
    'voting.discoverRounds',
    'voting.checkEligibility',
    'voting.roundStatus',
    'voting.roundProposals'
  ])
    await expect(
      forwardPageWorkerRpcWithAccountAuthority(method, parentPayload, authority)
    ).resolves.toBe('forwarded')
  expect(forwarded.length).toBe(10)
})

test('preserves raw page forwarding for active derived accounts and rejects missing authority', async () => {
  const coordinator = new AccountContextTransitionCoordinator()
  let current = { account: { id: 'derived', derivationIndex: 4 }, network: 'testnet' }
  const forwarded = []
  const authority = {
    readActive: () => current,
    runActiveOperation: operation => coordinator.runActiveOperation(operation),
    forward: async (method, payload) => {
      forwarded.push([method, payload])
      return payload
    }
  }
  const payload = { walletId: 'wallet', accountIndex: 4, amount: '7' }
  for (const method of rawSensitiveMethods)
    await expect(
      forwardPageWorkerRpcWithAccountAuthority(method, payload, authority)
    ).resolves.toBe(payload)
  expect(forwarded.map(([method]) => method)).toEqual(rawSensitiveMethods)
  current = { account: null, network: 'mainnet' }
  await expect(
    forwardPageWorkerRpcWithAccountAuthority('transaction.send', payload, authority)
  ).rejects.toThrow(/Active Account/)
  expect(forwarded.length).toBe(rawSensitiveMethods.length)
})

test('reads FROST authority after an earlier queued account switch rather than the stale page request', async () => {
  const coordinator = new AccountContextTransitionCoordinator()
  let current = { account: { id: 'derived', derivationIndex: 0 }, network: 'mainnet' }
  let release, started
  const barrier = new Promise(resolve => {
    release = resolve
  })
  const entered = new Promise(resolve => {
    started = resolve
  })
  const blocker = coordinator.runActiveOperation(async () => {
    started()
    await barrier
  })
  await entered
  const switched = coordinator.runAccountSwitch(account1, {
    readCurrent: () => account0,
    validateTarget: () => {},
    commit: async () => {
      current = { account: frostAccount, network: 'testnet' }
    }
  })
  let forwarded = false
  const request = forwardPageWorkerRpcWithAccountAuthority(
    'transaction.send',
    { walletId: 'wallet:0', accountIndex: 0 },
    {
      readActive: () => current,
      runActiveOperation: operation => coordinator.runActiveOperation(operation),
      forward: async () => {
        forwarded = true
      }
    }
  )
  const rejected = expect(request).rejects.toThrow(
    'Operation is unavailable for this FROST account'
  )
  release()
  await Promise.all([blocker, switched, rejected])
  expect(forwarded).toBe(false)
})

test('keeps authorization and the awaited sensitive forward inside the account transition queue', async () => {
  const coordinator = new AccountContextTransitionCoordinator()
  let current = { account: { id: 'derived', derivationIndex: 0 }, network: 'mainnet' }
  let release,
    started,
    switched = false
  const barrier = new Promise(resolve => {
    release = resolve
  })
  const entered = new Promise(resolve => {
    started = resolve
  })
  const request = forwardPageWorkerRpcWithAccountAuthority(
    'transaction.send',
    { walletId: 'wallet:0', accountIndex: 0 },
    {
      readActive: () => current,
      runActiveOperation: operation => coordinator.runActiveOperation(operation),
      forward: async () => {
        started()
        await barrier
        expect(current.account.id).toBe('derived')
        return 'done'
      }
    }
  )
  await entered
  const switching = coordinator.runAccountSwitch(account1, {
    readCurrent: () => account0,
    validateTarget: () => {},
    commit: async () => {
      switched = true
      current = { account: frostAccount, network: 'mainnet' }
    }
  })
  try {
    // Let a switch that escaped the queue commit while the Worker port is still waiting.
    await new Promise(resolve => setImmediate(resolve))
    expect(switched).toBe(false)
  } finally {
    release()
  }
  await expect(request).resolves.toBe('done')
  await switching
  expect(switched).toBe(true)
})
