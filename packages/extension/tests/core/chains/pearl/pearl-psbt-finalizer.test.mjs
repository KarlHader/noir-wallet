import { test } from 'node:test'
import { expect } from '@playwright/test'

import { finalizePearlPsbt } from '../../../../src/infrastructure/chains/pearl/index.ts'

test('rejects malformed Pearl finalization input without leaking details', () => {
  expect(() =>
    finalizePearlPsbt({
      prepared: {},
      signedPsbtBase64: 'not-a-psbt'
    })
  ).toThrow(
    expect.objectContaining({
      code: 'invalid-signed-transaction',
      message: 'Invalid signed Pearl transaction'
    })
  )
})
