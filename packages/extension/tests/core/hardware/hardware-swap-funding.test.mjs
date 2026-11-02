import assert from 'node:assert/strict'
import test from 'node:test'

import { parseHardwareSignRequest } from '../../../src/lib/hardware-tab.ts'

const swapRequest = {
  kind: 'swap',
  walletId: 'ledger-wallet',
  accountId: 'ledger-account',
  to: 't1deposit',
  amount: '0.5',
  marginalFeeZats: 5_000,
  createdAt: 1_000
}

test('hardware Swap preserves the selected Zcash funding source through request validation', () => {
  for (const fundingSource of ['shielded', 'transparent']) {
    const request = parseHardwareSignRequest({ ...swapRequest, fundingSource })
    assert.equal(request.kind, 'swap')
    assert.equal(request.fundingSource, fundingSource)
    assert.equal(request.amount, '0.5')
    assert.equal(request.to, 't1deposit')
  }
  assert.equal(parseHardwareSignRequest(swapRequest).fundingSource, undefined)
})

test('hardware funding source validation rejects unsupported actions and malformed sources', () => {
  for (const kind of ['shield', 'unshield']) {
    assert.throws(
      () => parseHardwareSignRequest({ ...swapRequest, kind, fundingSource: 'transparent' }),
      /Invalid hardware funding source/
    )
  }
  for (const fundingSource of ['all', '', true]) {
    assert.throws(
      () => parseHardwareSignRequest({ ...swapRequest, fundingSource }),
      /Invalid hardware funding source/
    )
  }
  assert.throws(
    () =>
      parseHardwareSignRequest({ ...swapRequest, fundingSource: 'transparent', maxTransfer: true }),
    /Invalid hardware maximum transfer/
  )
})
