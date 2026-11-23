import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { resolveConfidentialIdentity } from '../../../src/core/accounts/confidential-identity.ts'

function identity(walletSource, accountIndex = 0) {
  return resolveConfidentialIdentity({ walletSource, accountIndex }).kind
}

describe('Confidential identity dispatch', () => {
  it('prefers an EVM software key, then a NEAR software key, then a NEAR Ledger account', () => {
    assert.equal(identity({ kind: 'software' }), 'evm')
    assert.equal(identity({ kind: 'software', mnemonicWordCount: 24 }, 3), 'evm')
    assert.equal(identity({ kind: 'private-key', chainFamily: 'eip155' }, 0), 'evm')
    assert.equal(identity({ kind: 'private-key', chainFamily: 'eip155' }, 4), 'evm')
    assert.equal(identity({ kind: 'private-key', chainFamily: 'near' }, 0), 'near')
    assert.equal(identity({ kind: 'private-key', chainFamily: 'near', accountIndex: 4 }, 0), 'near')
    assert.equal(identity({ kind: 'private-key', chainFamily: 'near' }, 1), 'unavailable')
    assert.equal(identity({ kind: 'private-key', chainFamily: 'bip122' }, 0), 'unavailable')
    assert.equal(identity({ kind: 'private-key', chainFamily: 'solana' }, 0), 'unavailable')
    assert.equal(
      identity({
        kind: 'hardware',
        vendor: 'ledger',
        firmwareProfile: 'multi-app',
        capabilities: ['evm', 'near']
      }),
      'near-ledger'
    )
    assert.equal(
      identity(
        {
          kind: 'hardware',
          hardware: { vendor: 'ledger', capabilities: ['near'] }
        },
        2
      ),
      'near-ledger'
    )
    assert.equal(
      identity({
        kind: 'hardware',
        vendor: 'ledger',
        firmwareProfile: 'zcash',
        capabilities: ['zcash']
      }),
      'unavailable'
    )
    assert.equal(
      identity({
        kind: 'hardware',
        vendor: 'keystone',
        firmwareProfile: 'multi-coin',
        capabilities: ['near']
      }),
      'unavailable'
    )
    assert.equal(identity({ kind: 'hardware' }), 'unavailable')
    assert.equal(resolveConfidentialIdentity(null).kind, 'unavailable')
    assert.equal(resolveConfidentialIdentity(undefined).kind, 'unavailable')
  })
})
