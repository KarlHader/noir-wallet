import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  clearLendingMcaCache,
  getMcaCacheKey,
  runMcaCheckDeduped
} from '../../../src/core/services/lending-mca-cache.ts'

const noMca = Object.freeze({
  mcaId: null,
  publicKey: null,
  signingMode: 'derived',
  identity: null
})

test.afterEach(() => {
  clearLendingMcaCache()
})

test('does not persist a negative MCA lookup while an account may still be created by a relay', async () => {
  let calls = 0
  const operation = async () => {
    calls += 1
    return noMca
  }

  await runMcaCheckDeduped('wallet:account', operation)
  await runMcaCheckDeduped('wallet:account', operation)

  expect(calls).toBe(2)
})

test('persists a discovered MCA and reuses it on later refreshes', async () => {
  let calls = 0
  const status = Object.freeze({
    ...noMca,
    mcaId: 'mca.test.near'
  })
  const operation = async () => {
    calls += 1
    return status
  }

  expect(await runMcaCheckDeduped('wallet:account', operation)).toBe(status)
  expect(await runMcaCheckDeduped('wallet:account', operation)).toBe(status)
  expect(calls).toBe(1)
})

test('keeps Main and Private MCA lookups in separate account-mode scopes', async () => {
  const calls = []
  const operation = mode => async () => {
    calls.push(mode)
    return Object.freeze({ ...noMca, mcaId: `${mode}.multica.near` })
  }

  await runMcaCheckDeduped(getMcaCacheKey('wallet', 'account', 'main'), operation('main'))
  await runMcaCheckDeduped(getMcaCacheKey('wallet', 'account', 'private'), operation('private'))
  await runMcaCheckDeduped(getMcaCacheKey('wallet', 'account', 'main'), operation('main'))

  expect(calls).toEqual(['main', 'private'])
})
