import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getMultisigSendSlots,
  parseMultisigSendAmount,
  resolveMultisigSendContext
} from '../../../src/popup/pages/multisig/send-model'
import type { MultisigGroupRecord, MultisigThreshold } from '../../../src/core/multisig/types'

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
