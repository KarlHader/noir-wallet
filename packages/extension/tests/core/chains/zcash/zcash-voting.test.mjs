import { test } from 'node:test'
import { expect } from '@playwright/test'
import { validateVotingCheckpoint } from '../../../../src/lib/indexed-db.ts'
import {
  advanceVotingBallot,
  createVotingBallot,
  parseVotingDiscovery,
  validateVotingDecisions
} from '../../../../src/lib/voting.ts'

test('voting checkpoints only advance monotonically and equal revisions are idempotent', () => {
  const current = { revision: '8', bytes: new Uint8Array([1, 2]), updatedAt: 1 }
  expect(validateVotingCheckpoint(undefined, new Uint8Array([1]), 0n)).toBe('write')
  expect(validateVotingCheckpoint(current, new Uint8Array([1, 2]), 8n)).toBe('unchanged')
  expect(validateVotingCheckpoint(current, new Uint8Array([3]), 9n)).toBe('write')
  expect(() => validateVotingCheckpoint(current, new Uint8Array([3]), 7n)).toThrow(/stale/i)
  expect(() => validateVotingCheckpoint(current, new Uint8Array([3]), 8n)).toThrow(/conflicting/i)
  expect(() => validateVotingCheckpoint(undefined, new Uint8Array(), -1n)).toThrow(/negative/i)
})

test('a reviewed ballot survives preparation and stops at pending confirmation', async () => {
  const decisions = [
    { kind: 'choice', proposalId: 4, option: 2 },
    { kind: 'skip', proposalId: 9 }
  ]
  const status = {
    roundId: 'round',
    phase: 'eligible',
    completedBundles: 0,
    totalBundles: 1,
    nextAction: 'prepare_round',
    confirmedVotes: 0,
    totalVotes: 0,
    confirmedHelpers: 0,
    requiredHelpers: 0
  }
  let submitted = null
  const request = async input => {
    if (input.action === 'roundStatus') return { ...status }
    if (input.action === 'prepareRound') {
      status.phase = 'round_prepared'
      return {
        roundId: 'round',
        bundleCount: 1,
        selectedNoteCount: 1,
        votingPower: '12500000',
        state: 'round_prepared'
      }
    }
    if (input.action === 'submitDelegation') {
      status.phase = 'delegation_confirmed'
      status.completedBundles = 1
    } else if (input.action === 'submitBallot') {
      submitted = input.decisions
      status.phase = 'vote_pending'
      status.totalVotes = 1
    } else {
      throw new Error('Pending submission must await confirmation')
    }
    return { ...status }
  }
  const result = await advanceVotingBallot('round', decisions, request, () => {})
  expect(result.phase).toBe('vote_pending')
  expect(result.confirmedVotes).toBe(0)
  expect(submitted).toEqual(decisions)

  status.phase = 'delegation_confirmed'
  submitted = null
  await advanceVotingBallot('round', null, request, () => {})
  expect(submitted).toBeNull()
})

test('ballot validation requires one allowed choice or skip for every proposal', () => {
  const proposals = [
    { proposalId: 4, title: 'First', options: ['Yes', 'No'] },
    { proposalId: 9, title: 'Second', options: ['A', 'B'] }
  ]
  expect(
    validateVotingDecisions(proposals, [
      { kind: 'choice', proposalId: 4, option: 1 },
      { kind: 'skip', proposalId: 9 }
    ])
  ).toEqual([
    { kind: 'choice', proposalId: 4, option: 1 },
    { kind: 'skip', proposalId: 9 }
  ])
  expect(() => validateVotingDecisions(proposals, [{ kind: 'skip', proposalId: 4 }])).toThrow(
    /each proposal/i
  )
  expect(() =>
    validateVotingDecisions(proposals, [
      { kind: 'choice', proposalId: 4, option: 2 },
      { kind: 'skip', proposalId: 9 }
    ])
  ).toThrow(/decision is invalid/i)

  // An unanswered proposal must never silently become a skipped vote at review.
  expect(() => createVotingBallot(proposals, { 4: 1 })).toThrow(/choose an option or skip/i)
  expect(() => createVotingBallot(proposals, { 4: 'skip', 9: 'skip' })).toThrow(/at least one/i)
  expect(createVotingBallot(proposals, { 4: 0, 9: 'skip' })).toEqual([
    { kind: 'choice', proposalId: 4, option: 0 },
    { kind: 'skip', proposalId: 9 }
  ])
})

test('discovery rejects unknown rejection codes from the worker boundary', () => {
  expect(() =>
    parseVotingDiscovery({
      accepted: [],
      rejected: [{ roundId: 'round', code: 'UNKNOWN', message: 'invalid' }],
      configFingerprint: 'fingerprint'
    })
  ).toThrow(/rejection code/i)
})

test('public voting reads reuse only the unlocked active network and account core', async () => {
  const previousLocation = globalThis.location
  const previousChrome = globalThis.chrome
  globalThis.location = {
    href: 'chrome-extension://test/background.html',
    pathname: '/background.html'
  }
  globalThis.chrome = {
    storage: {
      local: {},
      session: {},
      onChanged: { addListener() {} }
    },
    runtime: {}
  }
  try {
    const { BackgroundZcashWalletRuntime } =
      await import('../../../../src/background/zcash-wallet-runtime.ts')
    const account = { derivationIndex: 2 }
    const core = {
      accountId: 7,
      accountIndex: 2,
      hasWasmInitialized: () => true,
      isReady: () => true
    }
    const runtime = Object.create(BackgroundZcashWalletRuntime.prototype)
    runtime.network = 'mainnet'
    runtime.password = null
    runtime.sessionCredentialWalletId = 'wallet-1'
    runtime.activeRestorePromise = null
    runtime.walletCoreLocks = new Map()
    runtime.walletCores = new Map([['wallet-1', core]])
    Object.defineProperty(runtime, 'store', {
      value: {
        currentNetwork: 'mainnet',
        getAccount: (walletId, accountId) =>
          walletId === 'wallet-1' && accountId === 'account-1' ? account : null
      }
    })

    expect(runtime.getReadyVotingReadCore('wallet-1', 'account-1')).toBe(core)
    expect(runtime.getReadyVotingReadCore('wallet-2', 'account-1')).toBeNull()
    expect(runtime.getReadyVotingReadCore('wallet-1', 'account-2')).toBeNull()
    account.networkSelections = { mainnet: ['evm'] }
    expect(runtime.getReadyVotingReadCore('wallet-1', 'account-1')).toBeNull()
    delete account.networkSelections
    core.accountIndex = 3
    expect(runtime.getReadyVotingReadCore('wallet-1', 'account-1')).toBeNull()
    core.accountIndex = 2
    runtime.store.currentNetwork = 'testnet'
    expect(runtime.getReadyVotingReadCore('wallet-1', 'account-1')).toBeNull()
    runtime.store.currentNetwork = 'mainnet'
    runtime.sessionCredentialWalletId = null
    expect(runtime.getReadyVotingReadCore('wallet-1', 'account-1')).toBeNull()
  } finally {
    globalThis.location = previousLocation
    globalThis.chrome = previousChrome
  }
})
