import { test } from 'node:test'
import { expect } from '@playwright/test'

import { checkZcashMcaAccount } from '../../../src/core/services/zcash-mca-account.ts'
import { createNearRpcClient } from '../../../src/infrastructure/chains/near/near-rpc-client.ts'
import {
  clearZcashMcaCache,
  getMcaCacheKey,
  runMcaCheckDeduped
} from '../../../src/core/services/zcash-mca-cache.ts'

const noMca = Object.freeze({
  mcaId: null,
  publicKey: null,
  signingMode: 'derived',
  identity: null
})

const testPublicKeys = { legacy: '02' + '11'.repeat(32), derived: '03' + '22'.repeat(32) }
const boundMca = '42.multica.near'

function checkMcaWithRpc(respond) {
  const requestedKeys = []
  const rpc = createNearRpcClient(
    { chainId: 'near:mainnet', rpcUrl: 'https://near.example' },
    async (_input, init) => {
      const { id, method, params } = JSON.parse(init.body)
      expect(method).toBe('query')
      expect(params).toMatchObject({
        request_type: 'call_function',
        account_id: 'multica.near',
        method_name: 'get_mca_by_wallet',
        finality: 'optimistic'
      })
      const { wallet } = JSON.parse(Buffer.from(params.args_base64, 'base64').toString())
      expect(wallet).toEqual({ Zcash: expect.any(String) })
      requestedKeys.push(wallet.Zcash)
      return Response.json({
        jsonrpc: '2.0',
        id,
        result: {
          block_hash: '11111111111111111111111111111111',
          block_height: 42,
          logs: [],
          result: [...Buffer.from(JSON.stringify(respond(wallet.Zcash)))]
        }
      })
    }
  )
  return {
    requestedKeys,
    status: checkZcashMcaAccount('wallet', 'account', async mode => testPublicKeys[mode], rpc)
  }
}

test.afterEach(() => {
  clearZcashMcaCache()
})

test('queries the NEAR MCA contract using the legacy identity before the derived identity', async () => {
  const legacy = checkMcaWithRpc(() => boundMca)
  expect(await legacy.status).toEqual({
    mcaId: boundMca,
    publicKey: testPublicKeys.legacy,
    signingMode: 'legacy_index0'
  })
  expect(legacy.requestedKeys).toEqual([testPublicKeys.legacy])

  clearZcashMcaCache()
  const derived = checkMcaWithRpc(key => (key === testPublicKeys.legacy ? null : boundMca))
  expect(await derived.status).toEqual({
    mcaId: boundMca,
    publicKey: testPublicKeys.derived,
    signingMode: 'derived'
  })
  expect(derived.requestedKeys).toEqual([testPublicKeys.legacy, testPublicKeys.derived])
})

test('does not fall back to the derived identity when the contract returns a malformed MCA', async () => {
  const result = checkMcaWithRpc(() => ({ mcaId: boundMca }))
  await expect(result.status).rejects.toThrow('MCA account ID')
  expect(result.requestedKeys).toEqual([testPublicKeys.legacy])
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
