import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  CREDENTIAL_SESSION_DESCRIPTOR_KEY,
  didCredentialSessionEnd
} from '../../../src/core/wallet/credential-session-state.ts'

test.describe('Credential session state', () => {
  test('detects removal of an active trusted session descriptor', () => {
    expect(
      didCredentialSessionEnd(
        {
          [CREDENTIAL_SESSION_DESCRIPTOR_KEY]: {
            oldValue: { globalUnlockEpoch: 1 },
            newValue: undefined
          }
        },
        'session'
      )
    ).toBe(true)
  })

  test('ignores descriptor renewal and unrelated storage changes', () => {
    expect(
      didCredentialSessionEnd(
        {
          [CREDENTIAL_SESSION_DESCRIPTOR_KEY]: {
            oldValue: { globalUnlockEpoch: 1 },
            newValue: { globalUnlockEpoch: 1 }
          }
        },
        'session'
      )
    ).toBe(false)
    expect(
      didCredentialSessionEnd(
        { [CREDENTIAL_SESSION_DESCRIPTOR_KEY]: { oldValue: {}, newValue: undefined } },
        'local'
      )
    ).toBe(false)
  })
})
