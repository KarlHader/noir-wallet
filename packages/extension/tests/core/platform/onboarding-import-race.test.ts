import { test } from 'node:test'
import { expect } from '@playwright/test'
import { LatestAttempt } from '../../../src/lib/async-utils'
import { classifyError } from '../../../src/lib/errors'

test('ignores an obsolete import error after the recovery phrase changes', async () => {
  const attempts = new LatestAttempt()
  const obsoleteAttempt = attempts.begin()
  let error: string | null = null

  attempts.invalidate()

  if (attempts.isCurrent(obsoleteAttempt)) {
    error = 'Invalid recovery phrase. Please check and try again.'
  }

  expect(error).toBeNull()
})

test('preserves an already classified recovery phrase error', () => {
  expect(
    classifyError(new Error('Invalid recovery phrase. Please check and try again.')).userMessage
  ).toBe('Invalid recovery phrase. Please check and try again.')
})
