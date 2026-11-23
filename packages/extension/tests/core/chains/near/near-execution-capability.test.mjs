import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { supportsNearPrivateExecution } from '../../../../src/core/chains/near/execution-capability.ts'

describe('NEAR private execution capability', () => {
  it('allows mnemonic software accounts and imported NEAR keys at account index 0', () => {
    for (const [source, expected] of [
      [{ kind: 'software' }, true],
      [{ kind: 'software', mnemonicWordCount: 12 }, true],
      [{ kind: 'software', mnemonicWordCount: 24 }, true],
      [{ kind: 'private-key', chainFamily: 'near', accountIndex: 0 }, true],
      [{ kind: 'private-key', chainFamily: 'near', accountIndex: 1 }, false],
      [{ kind: 'private-key', chainFamily: 'near' }, false],
      [{ kind: 'private-key', chainFamily: 'eip155', accountIndex: 0 }, false],
      [{ kind: 'private-key', chainFamily: 'bip122', accountIndex: 0 }, false],
      [{ kind: 'private-key', chainFamily: 'solana', accountIndex: 0 }, false],
      [{ kind: 'hardware' }, false],
      [{ kind: 'hardware', vendor: 'ledger', capabilities: ['near'] }, false],
      [{ kind: 'hardware', vendor: 'keystone', capabilities: ['near'] }, false],
      [null, false],
      [undefined, false]
    ]) {
      assert.equal(supportsNearPrivateExecution(source), expected, JSON.stringify(source))
    }
  })
})
