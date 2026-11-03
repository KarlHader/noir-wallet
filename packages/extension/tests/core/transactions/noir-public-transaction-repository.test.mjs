import { test } from 'node:test'
import { expect } from '@playwright/test'

import { mapTransactionGraphToActivityItem } from '../../../src/core/activity/activity-read-model.ts'
import {
  computePublicSubmissionId,
  createPublicCandidate,
  parsePublicCandidate,
  serializePublicCandidate
} from '../../../src/core/services/noir-protocol/public/protocol.ts'
import { parseNoirPublicTransactionBinding } from '../../../src/core/transactions/domain/protocol.ts'
import { NoirPublicClient } from '../../../src/infrastructure/noir-protocol/public-client.ts'
import { PUBLIC_MAINNET_CONFIG } from '../../../src/core/services/noir-protocol/public/config.ts'
import { InMemoryTransactionRepository } from '../../../src/infrastructure/persistence/repositories/in-memory-transaction-repository.ts'
import { assertPersistableTransactionGraph } from '../../../src/infrastructure/persistence/repositories/transaction-repository-support.ts'
import {
  NoirPublicTransactionRepository,
  fingerprintPublicRequests
} from '../../../src/infrastructure/noir-protocol/public-transaction-repository.ts'

const scope = { keyDomainId: 'key-domain:public', accountId: 'account:public' }
const publicKey = `04${'11'.repeat(64)}`
const candidate = createPublicCandidate({
  tgas: 200,
  address: 'mca.parent.testnet',
  nonce: '7',
  deadline: '2000000000',
  txRequests: [
    {
      FunctionCall: {
        receiver_id: 'zec.omft.near',
        function_calls: [
          {
            method_name: 'ft_transfer',
            args: '{"receiver_id":"fees.near","amount":"6400"}',
            gas: '30000000000000',
            deposit: '1'
          }
        ]
      }
    },
    {
      FunctionCall: {
        receiver_id: 'token.testnet',
        function_calls: [
          { method_name: 'ft_transfer', args: '{}', gas: '30000000000000', deposit: '1' }
        ]
      }
    }
  ],
  publicKey,
  signature: `1b${'22'.repeat(64)}`
})
const common = {
  scope,
  network: 'testnet',
  origin: 'https://app.example',
  requestId: 'request-1',
  accountAddress: candidate.address,
  parentContractId: 'parent.testnet',
  identityPublicKey: publicKey,
  now: 1_000
}

test('Public activation persists the exact payment intent before payment and deduplicates across origins', async () => {
  const repository = new NoirPublicTransactionRepository(new InMemoryTransactionRepository())
  const paymentIntent = {
    depositAddress: 't1deposit',
    amountInRaw: '1000',
    amountOutRaw: '900',
    feeRaw: '100',
    expiresAt: 2_000,
    refundAddress: 't1refund',
    recipient: 'parent.testnet',
    parentMessage: '{"account":"mca.parent.testnet"}'
  }
  const created = await repository.createPreparedActivation({
    ...common,
    requestId: 'activation-1',
    activationId: 'activation-1',
    paymentIntent
  })
  expect(created.graph.root.status).toBe('prepared')
  expect(created.binding.paymentIntent).toEqual(paymentIntent)
  expect(() => assertPersistableTransactionGraph(created.graph)).not.toThrow()
  const pending = await repository.getPendingActivation(
    scope,
    'testnet',
    common.parentContractId,
    publicKey
  )
  expect(pending?.graph.root.id).toBe(created.graph.root.id)
  await expect(
    repository.applyActivationBound(
      scope,
      created.graph.root.id,
      {
        chain: 'zcash-l2',
        network: 'testnet',
        publicKey: `04${'33'.repeat(64)}`,
        address: 't1public',
        mcaId: candidate.address,
        parentContractId: common.parentContractId,
        status: 'active'
      },
      1_050
    )
  ).rejects.toThrow(/does not match/)
  await expect(
    repository.createPreparedActivation({
      ...common,
      origin: 'https://other.example',
      requestId: 'activation-2',
      activationId: 'activation-2',
      paymentIntent
    })
  ).rejects.toThrow(/already exists/)
  const paid = await repository.applyActivationPayment(
    scope,
    created.graph.root.id,
    'zcash-payment-hash',
    'confirming',
    1_075
  )
  expect(paid.graph.root.status).toBe('confirming')
  expect(paid.graph.segments[0].evidence.transactionHash).toBe('zcash-payment-hash')
  const bound = await repository.applyActivationBound(
    scope,
    created.graph.root.id,
    {
      chain: 'zcash-l2',
      network: 'testnet',
      publicKey,
      address: 't1public',
      mcaId: candidate.address,
      parentContractId: common.parentContractId,
      status: 'active'
    },
    1_100
  )
  expect(bound.graph.root.status).toBe('final')
})

test('Public signed request survives submission recovery and is scoped to its origin', async () => {
  const repository = new NoirPublicTransactionRepository(new InMemoryTransactionRepository())
  const created = await repository.createSigned({ ...common, candidate })
  expect(created.transaction.status).toBe('signed')
  expect(created.candidate).toEqual(candidate)
  expect(created.graph.root.intent.recipient.address).toBe(candidate.address)
  expect(() => assertPersistableTransactionGraph(created.graph)).not.toThrow()
  expect(
    (await repository.getByRequestId(scope, 'testnet', common.origin, common.requestId))
      ?.transaction.operationId
  ).toBe(created.transaction.operationId)
  expect(
    await repository.getByOperationId(
      scope,
      'testnet',
      'https://other.example',
      created.transaction.operationId
    )
  ).toBeNull()
  const activity = mapTransactionGraphToActivityItem(created.graph)
  expect(activity.snapshot.protocol).toBeUndefined()
  expect(JSON.stringify(activity)).not.toContain(candidate.signature)
  expect(created.binding.requestFingerprint).toBe(
    await fingerprintPublicRequests(candidate.tx_requests.slice(1))
  )
  await expect(
    repository.createSigned({
      ...common,
      requestId: 'mismatched-original',
      candidate,
      originalTxRequests: candidate.tx_requests
    })
  ).rejects.toThrow(/original request/)

  const changed = createPublicCandidate({
    tgas: 200,
    address: candidate.address,
    nonce: '8',
    deadline: candidate.deadline,
    txRequests: candidate.tx_requests,
    publicKey,
    signature: candidate.signature
  })
  await expect(repository.createSigned({ ...common, candidate: changed })).rejects.toThrow(
    /different signed payload/
  )
})

test('persisted V1 Public requests retain their original ID and cannot be resubmitted', async () => {
  const repository = new NoirPublicTransactionRepository(new InMemoryTransactionRepository())
  const created = await repository.createSigned({ ...common, candidate })
  const legacy = parsePublicCandidate({
    address: candidate.address,
    nonce: candidate.nonce,
    deadline: candidate.deadline,
    tx_requests: candidate.tx_requests.slice(1),
    signer_wallet: candidate.signer_wallet,
    signature: candidate.signature
  })
  const binding = parseNoirPublicTransactionBinding({
    ...created.binding,
    requestFingerprint: await fingerprintPublicRequests(legacy.tx_requests),
    submissionId: computePublicSubmissionId(legacy),
    signedRequest: serializePublicCandidate(legacy)
  })
  expect(binding.submissionId).toBe(computePublicSubmissionId(legacy))
  expect(binding.signedRequest).not.toContain('"tgas"')
  const client = new NoirPublicClient(PUBLIC_MAINNET_CONFIG, 'https://free.rpc.fastnear.com')
  await expect(client.submitPublicTransaction(legacy)).rejects.toThrow(/Legacy Public transaction/)
})

test('Public execution finality and anchor progress are independent of provisional backend failure', async () => {
  const repository = new NoirPublicTransactionRepository(new InMemoryTransactionRepository())
  const created = await repository.createSigned({ ...common, candidate })
  const operationId = created.transaction.operationId
  const submissionId = created.transaction.submissionId
  const submitted = await repository.markSubmitted(scope, operationId, submissionId, 1_100)
  expect(submitted.transaction.status).toBe('broadcast')
  const failed = await repository.applyObservation(
    scope,
    operationId,
    { submission_id: submissionId, status: 'FAILED', failure_reason: 'retryable' },
    1_200
  )
  expect(failed.transaction.status).toBe('broadcast')
  const unverified = await repository.applyObservation(
    scope,
    operationId,
    { submission_id: submissionId, status: 'EXECUTED', tx_hash: 'near-execution-hash' },
    1_250
  )
  expect(unverified.transaction.status).toBe('broadcast')
  const executed = await repository.applyObservation(
    scope,
    operationId,
    {
      submission_id: submissionId,
      status: 'EXECUTED',
      tx_hash: 'near-execution-hash',
      verifiedExecution: 'success'
    },
    1_300
  )
  expect(executed.transaction.status).toBe('final')
  expect(executed.transaction.transactionHash).toBe('near-execution-hash')
  expect((await repository.listPending([scope], 'testnet')).length).toBe(1)
  const anchored = await repository.applyObservation(
    scope,
    operationId,
    {
      submission_id: submissionId,
      status: 'ANCHORED',
      anchor: { txid_hex: 'zcash-anchor-hash' }
    },
    1_400
  )
  expect(anchored.transaction.status).toBe('final')
  expect(anchored.transaction.anchor).toEqual({
    status: 'final',
    transactionHash: 'zcash-anchor-hash'
  })
  expect(await repository.listPending([scope], 'testnet')).toEqual([])
})

test('Public expiry requires matching final-chain nonce and no execution hash', async () => {
  const repository = new NoirPublicTransactionRepository(new InMemoryTransactionRepository())
  const created = await repository.createSigned({ ...common, candidate })
  const operationId = created.transaction.operationId
  const expiredBlock = { nonce: candidate.nonce, finalBlockTimestampMs: 2_000_000_001_000 }

  await expect(
    repository.markExpiredUnexecuted(scope, operationId, { ...expiredBlock, nonce: '8' }, 1_100)
  ).rejects.toThrow(/proof does not match/)
  await expect(
    repository.markExpiredUnexecuted(
      scope,
      operationId,
      { ...expiredBlock, finalBlockTimestampMs: Number(candidate.deadline) },
      1_100
    )
  ).rejects.toThrow(/proof does not match/)
  expect(
    (await repository.getByOperationId(scope, 'testnet', common.origin, operationId)).candidate
  ).toEqual(candidate)

  const expired = await repository.markExpiredUnexecuted(scope, operationId, expiredBlock, 1_200)
  expect(expired.transaction).toMatchObject({ status: 'failed', error: 'expired' })
  expect(expired.candidate).toEqual(candidate)
  expect(
    (await repository.markExpiredUnexecuted(scope, operationId, expiredBlock, 1_300)).graph
  ).toEqual(expired.graph)

  const observed = await repository.createSigned({
    ...common,
    requestId: 'request-with-hash',
    candidate
  })
  await repository.applyObservation(
    scope,
    observed.transaction.operationId,
    { submission_id: observed.binding.submissionId, status: 'EXECUTED', tx_hash: 'near-hash' },
    1_300
  )
  await expect(
    repository.markExpiredUnexecuted(scope, observed.transaction.operationId, expiredBlock, 1_400)
  ).rejects.toThrow(/execution hash must be verified/)
  expect(
    (
      await repository.getByOperationId(
        scope,
        'testnet',
        common.origin,
        observed.transaction.operationId
      )
    ).transaction.status
  ).toBe('broadcast')
})

test('Public pending scan survives more than 200 newer unrelated account transactions', async () => {
  const storage = new InMemoryTransactionRepository()
  const repository = new NoirPublicTransactionRepository(storage)
  const created = await repository.createSigned({ ...common, candidate })
  for (let index = 0; index < 205; index += 1) {
    const id = `tx:unrelated:${index}`
    const segmentId = `segment:unrelated:${index}`
    const now = 2_000 + index
    await storage.create({
      root: {
        id,
        scope,
        kind: 'transfer',
        status: 'broadcast',
        segmentIds: [segmentId],
        createdAt: now,
        updatedAt: now,
        revision: 0
      },
      segments: [
        {
          id: segmentId,
          transactionId: id,
          role: 'origin',
          target: { kind: 'onchain', chainId: 'near:testnet' },
          status: 'broadcast',
          requiredForFinality: true,
          dependsOn: [],
          evidence: { transactionHash: `unrelated-hash-${index}` },
          createdAt: now,
          updatedAt: now,
          revision: 0
        }
      ]
    })
  }

  await expect(storage.list({ scope, limit: 201 })).rejects.toThrow(/query limit/)
  expect(await storage.list({ scope, provider: 'noir-public', limit: 201 })).toHaveLength(1)
  expect(
    (await repository.listPending([scope], 'testnet')).map(item => item.graph.root.id)
  ).toEqual([created.graph.root.id])

  const final = await repository.applyObservation(
    scope,
    created.graph.root.id,
    {
      submission_id: created.binding.submissionId,
      status: 'EXECUTED',
      tx_hash: 'near-execution-hash',
      verifiedExecution: 'success'
    },
    2_500
  )
  expect(final.graph.root.status).toBe('final')
  expect(
    (await repository.listPending([scope], 'testnet')).map(item => item.graph.root.id)
  ).toEqual([created.graph.root.id])
})
