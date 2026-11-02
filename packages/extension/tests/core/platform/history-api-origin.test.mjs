import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveHistoryApiOrigin } from '../../../scripts/lib/extension-build-config.ts'

test('Beta history proxy overrides require HTTPS, including on loopback', () => {
  assert.equal(
    resolveHistoryApiOrigin('https://custom-history.example/', 'beta'),
    'https://custom-history.example'
  )
  for (const origin of ['http://localhost:8799', 'http://127.0.0.1:8799']) {
    assert.throws(() => resolveHistoryApiOrigin(origin, 'beta'), /credential-free HTTPS origin/)
    assert.equal(resolveHistoryApiOrigin(origin, 'development'), origin)
  }
})
