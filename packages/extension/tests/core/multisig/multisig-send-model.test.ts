import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getMultisigSendSlots,
  getUnresolvedMultisigTransactions,
  mergeMultisigSendTransactions,
  parseMultisigSendAmount,
  parseMultisigSendRecovery,
  resolveMultisigSendContext,
  settleMultisigSendReview,
  validateMultisigSendReview
} from '../../../src/popup/pages/multisig/send-model'
import type { MultisigGroupRecord, MultisigThreshold } from '../../../src/core/multisig/types'
import type { VaultSendReview } from '../../../src/core/multisig/send-rpc'
import type { VaultSendTransaction } from '../../../src/core/multisig/send-rpc'
import {
  decodeMultisigSendError,
  getMultisigSendErrorMessage,
  MultisigSendError,
  toMultisigSendError
} from '../../../src/core/multisig/send-errors'

test('multisig errors retain only allowlisted failure categories across page messages', () => {
  const privateText = 'synthetic-private-request-content'
  for (const value of [undefined, '__proto__', 'constructor', privateText]) {
    const error = decodeMultisigSendError(value)
    assert.equal(error.code, 'signing_unavailable')
    assert.equal(getMultisigSendErrorMessage(error).includes(privateText), false)
  }
  const error = new MultisigSendError('credential_not_bound')
  error.message = privateText
  assert.equal(toMultisigSendError(error).message.includes(privateText), false)
  assert.equal(decodeMultisigSendError('credential_not_bound').code, 'credential_not_bound')
  assert.equal(
    toMultisigSendError(new Error('Account not initialized')).code,
    'account_not_initialized'
  )
  assert.equal(toMultisigSendError(new Error(privateText)).code, 'signing_unavailable')
})

const scope = { network: 'testnet' as const, walletId: 'wallet', accountId: 'account' }
const active = {
  ...scope,
  source: {
    kind: 'frost-vault' as const,
    version: 1 as const,
    network: 'testnet' as const,
    groupId: 'group'
  }
}
function group(threshold: MultisigThreshold): MultisigGroupRecord {
  return {
    groupId: 'group',
    threshold,
    transportKind: 'qr',
    fingerprint: 'ab'.repeat(32),
    createdAt: 1,
    mock: false,
    devices: [
      { slot: 1, role: 'owner', name: 'Noir', model: 'Extension', platform: 'extension' },
      { slot: 2, role: 'guardian', name: 'Phone A', model: 'Phone', platform: 'ios' },
      ...(threshold === '2-of-2'
        ? []
        : [
            {
              slot: 3 as const,
              role: 'guardian' as const,
              name: 'Phone B',
              model: 'Phone',
              platform: 'android' as const
            }
          ])
    ]
  }
}

test('send selects the exact threshold from real roster members and always includes extension zero', () => {
  assert.deepEqual(getMultisigSendSlots(group('2-of-2'), null), [0, 1])
  assert.deepEqual(getMultisigSendSlots(group('3-of-3'), null), [0, 1, 2])
  assert.equal(getMultisigSendSlots(group('2-of-3'), null), null)
  assert.deepEqual(getMultisigSendSlots(group('2-of-3'), 2), [0, 1])
  assert.deepEqual(getMultisigSendSlots(group('2-of-3'), 3), [0, 2])
  assert.equal(getMultisigSendSlots(group('2-of-3'), 1), null)
  for (const invalid of [
    { ...group('2-of-3'), mock: true },
    { ...group('2-of-3'), devices: group('2-of-3').devices.slice(1) },
    {
      ...group('2-of-3'),
      devices: [group('2-of-3').devices[0], group('2-of-3').devices[1], group('2-of-3').devices[1]]
    },
    {
      ...group('2-of-3'),
      devices: group('2-of-3').devices.map(device => ({
        ...device,
        platform: 'extension' as const
      }))
    }
  ])
    assert.equal(getMultisigSendSlots(invalid, 2), null)
})

test('send context fails closed on changed account, network, source or display-only group', () => {
  const ready = group('2-of-3')
  assert.ok(resolveMultisigSendContext(scope, active, ready))
  for (const changed of [
    { ...active, accountId: 'other' },
    { ...active, walletId: 'other' },
    { ...active, network: 'mainnet' as const },
    { ...active, source: undefined },
    { ...active, source: { ...active.source, network: 'mainnet' as const } },
    { ...active, source: { ...active.source, groupId: 'other' } }
  ])
    assert.equal(resolveMultisigSendContext(scope, changed, ready), null)
  assert.equal(resolveMultisigSendContext(scope, active, { ...ready, mock: true }), null)
  assert.equal(resolveMultisigSendContext(scope, active, null), null)
})

test('send converts ZEC exactly without rounding, exponents or zero transfers', () => {
  assert.equal(parseMultisigSendAmount('0.00000001'), '1')
  assert.equal(parseMultisigSendAmount('1.23000000'), '123000000')
  assert.equal(parseMultisigSendAmount('21000000'), '2100000000000000')
  for (const invalid of [
    '',
    '0',
    '-1',
    '01',
    '1e2',
    ' 1',
    '.1',
    '0.000000001',
    '21000000.00000001'
  ]) {
    assert.equal(parseMultisigSendAmount(invalid), null)
  }
})

const draft = {
  scope,
  groupId: 'group',
  rosterVersion: 1 as const,
  to: 'u-recipient',
  amountZats: '100000000',
  memo: 'memo',
  selectedSlots: [0, 2],
  transport: 'qr' as const
}

function review(): VaultSendReview {
  return {
    available: true,
    binding: {
      ...scope,
      groupId: 'group',
      rosterVersion: 1,
      reviewId: 'review',
      pcztDigest: 'ab'.repeat(32),
      sessionId: Buffer.alloc(16, 1).toString('base64'),
      expiresAt: 2_000_000_000_000,
      selectedSlots: [0, 2]
    },
    summary: { recipient: draft.to, amount: draft.amountZats, memo: 'memo', fee: '10000' }
  }
}

test('send review accepts only the exact bound transaction and valid money fields', () => {
  const expected = review()
  assert.doesNotThrow(() => validateMultisigSendReview(expected, draft, 1_900_000_000_000))
  const invalid = [
    { ...expected, summary: { ...expected.summary, amount: '100000001' } },
    { ...expected, summary: { ...expected.summary, fee: '1.5' } },
    { ...expected, summary: { ...expected.summary, fee: '2100000000000001' } },
    { ...expected, binding: { ...expected.binding, selectedSlots: [0, 1] } },
    { ...expected, binding: { ...expected.binding, pcztDigest: 'invalid' } },
    { ...expected, binding: { ...expected.binding, sessionId: 'invalid' } },
    { ...expected, binding: { ...expected.binding, expiresAt: Number.MAX_SAFE_INTEGER + 1 } }
  ]
  for (const candidate of invalid) {
    assert.throws(() => validateMultisigSendReview(candidate, draft, 1_900_000_000_000))
  }
})

test('send releases a review returned after the account scope was invalidated', async () => {
  const expected = review()
  const cancelled: string[] = []
  await assert.rejects(
    settleMultisigSendReview(
      expected,
      draft,
      () => {
        throw new Error('account changed')
      },
      async authority => {
        cancelled.push(authority.reviewId)
      }
    ),
    /account changed/
  )
  assert.deepEqual(cancelled, ['review'])
})

test('send keeps the highest transaction phase and rejects cross-account records', () => {
  const base: VaultSendTransaction = {
    binding: review().binding,
    phase: 'finalized',
    txId: 'cd'.repeat(32),
    outbound: []
  }
  const broadcast = { ...base, phase: 'broadcast' as const }
  const confirmed = { ...base, phase: 'confirmed' as const }
  assert.deepEqual(mergeMultisigSendTransactions([broadcast], [base], scope), [broadcast])
  assert.deepEqual(mergeMultisigSendTransactions([broadcast], [confirmed], scope), [confirmed])
  assert.deepEqual(getUnresolvedMultisigTransactions([broadcast, confirmed]), [broadcast])
  assert.throws(() =>
    mergeMultisigSendTransactions(
      [],
      [{ ...base, binding: { ...base.binding, accountId: 'other' } }],
      scope
    )
  )
  assert.throws(() =>
    mergeMultisigSendTransactions([base], [{ ...base, txId: 'ef'.repeat(32) }], scope)
  )
})

test('send recovery response rejects inconsistent blocker state', () => {
  assert.deepEqual(
    parseMultisigSendRecovery({
      signedWithoutTransaction: true,
      status: 'finalization_incomplete'
    }),
    { signedWithoutTransaction: true, status: 'finalization_incomplete' }
  )
  for (const invalid of [
    { signedWithoutTransaction: true, status: 'none' },
    { signedWithoutTransaction: false, status: 'signed_without_receipt' },
    { signedWithoutTransaction: true, status: 'unverified' },
    { signedWithoutTransaction: true, status: 'finalization_incomplete', txId: 'ab'.repeat(32) }
  ])
    assert.throws(() => parseMultisigSendRecovery(invalid))
})
