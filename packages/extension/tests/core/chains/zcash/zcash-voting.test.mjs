import { test } from 'node:test'
import { expect } from '@playwright/test'
import { validateVotingCheckpoint } from '../../../../src/lib/indexed-db.ts'
import { parseVotingDiscovery, validateVotingDecisions } from '../../../../src/lib/voting.ts'

test('voting checkpoints only advance monotonically and equal revisions are idempotent', () => {
  const current = { revision: '8', bytes: new Uint8Array([1, 2]), updatedAt: 1 }
  expect(validateVotingCheckpoint(undefined, new Uint8Array([1]), 0n)).toBe('write')
  expect(validateVotingCheckpoint(current, new Uint8Array([1, 2]), 8n)).toBe('unchanged')
  expect(validateVotingCheckpoint(current, new Uint8Array([3]), 9n)).toBe('write')
  expect(() => validateVotingCheckpoint(current, new Uint8Array([3]), 7n)).toThrow(/stale/i)
  expect(() => validateVotingCheckpoint(current, new Uint8Array([3]), 8n)).toThrow(/conflicting/i)
  expect(() => validateVotingCheckpoint(undefined, new Uint8Array(), -1n)).toThrow(/negative/i)
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
