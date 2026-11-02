import { describe, test as it } from 'node:test'
import assert from 'node:assert/strict'

import {
  createChromeWebStoreClient,
  submitPackage,
  uploadPackage
} from '../../../scripts/lib/chrome-web-store.mjs'

const NAME = 'publishers/publisher/items/extension'
const VERSION = '2.0.0'
const TOKEN = 'synthetic-access-token'
const status = (options = {}) => ({
  name: NAME,
  itemId: 'extension',
  ...options
})
const upload = (options = {}) => ({
  name: NAME,
  itemId: 'extension',
  uploadState: 'SUCCEEDED',
  crxVersion: VERSION,
  ...options
})
const publish = (options = {}) => ({
  name: NAME,
  itemId: 'extension',
  state: 'PENDING_REVIEW',
  ...options
})
const submission = (version = VERSION, state = 'PENDING_REVIEW') => ({
  state,
  distributionChannels: [{ crxVersion: version }]
})

function fixture(replies, options = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init })
    const reply = replies.shift()
    if (reply instanceof Error) throw reply
    assert.ok(reply, `Unexpected request: ${init.method} ${url}`)
    return new Response(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body), {
      status: reply.status ?? 200
    })
  }
  const client = createChromeWebStoreClient({
    publisherId: 'publisher',
    extensionId: 'extension',
    accessToken: TOKEN,
    fetchImpl,
    wait: async () => {},
    pollAttempts: 3,
    pollIntervalMs: 0,
    ...options
  })
  return { client, calls }
}

describe('Chrome Web Store v2 release operations', () => {
  it('uses official endpoints and raw CRX headers without retrying POST', async () => {
    const { client, calls } = fixture([
      { body: status() },
      { body: upload() },
      { body: status() },
      { body: publish() },
      { body: status({ submittedItemRevisionStatus: submission() }) }
    ])
    const receipt = await uploadPackage({
      client,
      version: VERSION,
      crxBytes: Buffer.from('CRX bytes'),
      filename: 'noir-v2.crx'
    })
    assert.equal(receipt.status, 'succeeded')
    assert.equal(receipt.uploadState, 'SUCCEEDED')
    const submitted = await submitPackage({ client, version: VERSION, uploadReceipt: receipt })
    assert.deepEqual(submitted, {
      status: 'succeeded',
      retryable: false,
      version: VERSION,
      state: 'PENDING_REVIEW'
    })
    assert.deepEqual(
      calls.map(call => [call.method, call.url]),
      [
        ['GET', `https://chromewebstore.googleapis.com/v2/${NAME}:fetchStatus`],
        ['POST', `https://chromewebstore.googleapis.com/upload/v2/${NAME}:upload`],
        ['GET', `https://chromewebstore.googleapis.com/v2/${NAME}:fetchStatus`],
        ['POST', `https://chromewebstore.googleapis.com/v2/${NAME}:publish`],
        ['GET', `https://chromewebstore.googleapis.com/v2/${NAME}:fetchStatus`]
      ]
    )
    assert.equal(calls[1].headers.Authorization, `Bearer ${TOKEN}`)
    assert.equal(calls[1].headers['X-Goog-Upload-Protocol'], 'raw')
    assert.equal(calls[1].headers['X-Goog-Upload-File-Name'], 'noir-v2.crx')
    assert.deepEqual(JSON.parse(calls[3].body), {
      publishType: 'STAGED_PUBLISH',
      skipReview: false,
      blockOnWarnings: true
    })
    assert.doesNotMatch(
      JSON.stringify(receipt) + JSON.stringify(submitted),
      /synthetic-access-token/
    )
  })

  it('blocks another active submission and never publishes a staged revision', async () => {
    const receipt = { status: 'succeeded', version: VERSION }
    for (const [existingVersion, state] of [
      ['1.9.0', 'PENDING_REVIEW'],
      [VERSION, 'STAGED']
    ]) {
      const { client, calls } = fixture([
        { body: status({ submittedItemRevisionStatus: submission(existingVersion, state) }) }
      ])
      const outcome = await submitPackage({ client, version: VERSION, uploadReceipt: receipt })
      assert.equal(outcome.status, 'blocked')
      assert.equal(outcome.state, state)
      assert.deepEqual(
        calls.map(call => call.method),
        ['GET']
      )
    }
  })

  it('reconciles a prior submission only with a matching version and candidate receipt', async () => {
    const receipt = { status: 'succeeded', version: VERSION }
    const prior = { status: 'unknown', version: VERSION }
    for (const [state, asyncState] of [
      ['PENDING_REVIEW', 'IN_PROGRESS'],
      ['STAGED', 'SUCCEEDED']
    ]) {
      const match = fixture([
        {
          body: status({
            submittedItemRevisionStatus: submission(VERSION, state),
            lastAsyncUploadState: asyncState
          })
        }
      ])
      const outcome = await submitPackage({
        client: match.client,
        version: VERSION,
        uploadReceipt: receipt,
        previousSubmission: prior
      })
      assert.equal(outcome.status, 'succeeded')
      assert.equal(outcome.state, state)
      assert.deepEqual(
        match.calls.map(call => call.method),
        ['GET']
      )
    }

    const mismatch = fixture([
      { body: status({ submittedItemRevisionStatus: submission('1.9.0') }) }
    ])
    assert.equal(
      (
        await submitPackage({
          client: mismatch.client,
          version: VERSION,
          uploadReceipt: receipt,
          previousSubmission: prior
        })
      ).status,
      'blocked'
    )
    assert.deepEqual(
      mismatch.calls.map(call => call.method),
      ['GET']
    )
  })

  it('permits a new version after an older submitted revision reached a terminal state', async () => {
    for (const terminalState of ['PUBLISHED', 'PUBLISHED_TO_TESTERS', 'REJECTED', 'CANCELLED']) {
      const oldRevision = submission('1.9.0', terminalState)
      const publishedRevision =
        terminalState === 'REJECTED' || terminalState === 'CANCELLED'
          ? submission('1.8.0', 'PUBLISHED')
          : oldRevision
      const oldStatus = status({
        publishedItemRevisionStatus: publishedRevision,
        submittedItemRevisionStatus: oldRevision
      })
      const { client, calls } = fixture([
        { body: oldStatus },
        { body: upload() },
        { body: oldStatus },
        { body: publish() },
        {
          body: status({
            publishedItemRevisionStatus: publishedRevision,
            submittedItemRevisionStatus: submission()
          })
        }
      ])
      const uploaded = await uploadPackage({
        client,
        version: VERSION,
        crxBytes: Buffer.from('CRX'),
        filename: 'noir.crx'
      })
      assert.equal(uploaded.status, 'succeeded')
      const submitted = await submitPackage({ client, version: VERSION, uploadReceipt: uploaded })
      assert.equal(submitted.status, 'succeeded')
      assert.deepEqual(
        calls.map(call => call.method),
        ['GET', 'POST', 'GET', 'POST', 'GET']
      )
    }

    for (const terminalState of ['PUBLISHED', 'PUBLISHED_TO_TESTERS', 'REJECTED', 'CANCELLED']) {
      const sameVersion = fixture([
        {
          body: status({
            submittedItemRevisionStatus: submission(VERSION, terminalState)
          })
        }
      ])
      const blocked = await submitPackage({
        client: sameVersion.client,
        version: VERSION,
        uploadReceipt: { status: 'succeeded', version: VERSION }
      })
      assert.equal(blocked.status, 'blocked')
      assert.deepEqual(
        sameVersion.calls.map(call => call.method),
        ['GET']
      )
    }
  })

  it('keeps ambiguous POST outcomes unknown and does not issue a second POST', async () => {
    const uploaded = fixture([
      { body: status() },
      new Error(`failure ${TOKEN}`),
      { body: status() }
    ])
    const uploadResult = await uploadPackage({
      client: uploaded.client,
      version: VERSION,
      crxBytes: Buffer.from('CRX'),
      filename: 'noir.crx'
    })
    assert.equal(uploadResult.status, 'unknown')
    assert.equal(uploadResult.retryable, false)
    assert.equal(uploaded.calls.filter(call => call.method === 'POST').length, 1)
    assert.deepEqual(
      uploaded.calls.map(call => call.method),
      ['GET', 'POST', 'GET']
    )
    assert.doesNotMatch(JSON.stringify(uploadResult), /synthetic-access-token/)

    const resumed = fixture([{ body: status() }])
    assert.equal(
      (
        await uploadPackage({
          client: resumed.client,
          version: VERSION,
          previousUpload: uploadResult
        })
      ).status,
      'unknown'
    )
    assert.deepEqual(
      resumed.calls.map(call => call.method),
      ['GET']
    )

    const submitted = fixture([
      { body: status() },
      new Error('network failure'),
      { body: status() },
      { body: status() },
      { body: status() }
    ])
    const submitResult = await submitPackage({
      client: submitted.client,
      version: VERSION,
      uploadReceipt: { status: 'succeeded', version: VERSION }
    })
    assert.equal(submitResult.status, 'unknown')
    assert.equal(submitted.calls.filter(call => call.method === 'POST').length, 1)
  })

  it('reconciles an ambiguous publish response only after status confirms this version', async () => {
    const { client, calls } = fixture([
      { body: status() },
      new Error('publish connection closed'),
      { body: status({ submittedItemRevisionStatus: submission() }) }
    ])
    const outcome = await submitPackage({
      client,
      version: VERSION,
      uploadReceipt: { status: 'succeeded', version: VERSION }
    })
    assert.equal(outcome.status, 'succeeded')
    assert.equal(outcome.state, 'PENDING_REVIEW')
    assert.equal(calls.filter(call => call.method === 'POST').length, 1)
  })

  it('retries an explicitly rejected publish attempt but not an unconfirmed one', async () => {
    const rejected = fixture([
      { body: status() },
      { status: 400, body: { error: { message: TOKEN } } },
      { body: status() }
    ])
    const first = await submitPackage({
      client: rejected.client,
      version: VERSION,
      uploadReceipt: { status: 'succeeded', version: VERSION }
    })
    assert.equal(first.status, 'failed')
    assert.equal(first.retryable, true)
    assert.doesNotMatch(JSON.stringify(first), /synthetic-access-token/)

    const retried = fixture([
      { body: status() },
      { body: publish() },
      { body: status({ submittedItemRevisionStatus: submission() }) }
    ])
    const second = await submitPackage({
      client: retried.client,
      version: VERSION,
      uploadReceipt: { status: 'succeeded', version: VERSION },
      previousSubmission: first
    })
    assert.equal(second.status, 'succeeded')
    assert.equal(retried.calls.filter(call => call.method === 'POST').length, 1)

    const unconfirmed = fixture([{ body: status() }])
    assert.equal(
      (
        await submitPackage({
          client: unconfirmed.client,
          version: VERSION,
          uploadReceipt: { status: 'succeeded', version: VERSION },
          previousSubmission: { status: 'unknown', version: VERSION }
        })
      ).status,
      'unknown'
    )
    assert.deepEqual(
      unconfirmed.calls.map(call => call.method),
      ['GET']
    )
  })

  it('keeps a malformed successful POST response unknown', async () => {
    const malformed = fixture([
      { body: status() },
      { body: upload({ itemId: 'another-item' }) },
      { body: status() }
    ])
    const result = await uploadPackage({
      client: malformed.client,
      version: VERSION,
      crxBytes: Buffer.from('CRX'),
      filename: 'noir.crx'
    })
    assert.equal(result.status, 'unknown')
    assert.equal(result.retryable, false)
    assert.deepEqual(
      malformed.calls.map(call => call.method),
      ['GET', 'POST', 'GET']
    )
  })

  it('does not mistake an unrelated 24-hour upload result for the current upload', async () => {
    const prior = fixture([{ body: status({ lastAsyncUploadState: 'SUCCEEDED' }) }])
    const blocked = await uploadPackage({
      client: prior.client,
      version: VERSION,
      crxBytes: Buffer.from('CRX'),
      filename: 'noir.crx'
    })
    assert.equal(blocked.status, 'blocked')
    assert.deepEqual(
      prior.calls.map(call => call.method),
      ['GET']
    )

    const immediate = fixture([
      { body: status() },
      { body: upload({ uploadState: 'IN_PROGRESS', crxVersion: null }) },
      { body: status({ lastAsyncUploadState: 'SUCCEEDED' }) }
    ])
    assert.equal(
      (
        await uploadPackage({
          client: immediate.client,
          version: VERSION,
          crxBytes: Buffer.from('CRX'),
          filename: 'noir.crx'
        })
      ).status,
      'succeeded'
    )

    const current = fixture([
      { body: status() },
      { body: upload({ uploadState: 'IN_PROGRESS', crxVersion: null }) },
      { body: status({ lastAsyncUploadState: 'IN_PROGRESS' }) },
      { body: status({ lastAsyncUploadState: 'SUCCEEDED' }) }
    ])
    const completed = await uploadPackage({
      client: current.client,
      version: VERSION,
      crxBytes: Buffer.from('CRX'),
      filename: 'noir.crx'
    })
    assert.equal(completed.status, 'succeeded')
    assert.equal(completed.uploadState, 'IN_PROGRESS')
  })

  it('rejects identity and version mismatches before treating an upload as successful', async () => {
    const identity = fixture([{ body: status({ itemId: 'another-item' }) }])
    const identityOutcome = await uploadPackage({
      client: identity.client,
      version: VERSION,
      crxBytes: Buffer.from('CRX'),
      filename: 'noir.crx'
    })
    assert.equal(identityOutcome.status, 'failed')
    assert.equal(identityOutcome.retryable, true)
    assert.deepEqual(
      identity.calls.map(call => call.method),
      ['GET']
    )

    const version = fixture([{ body: status() }, { body: upload({ crxVersion: '1.9.0' }) }])
    const outcome = await uploadPackage({
      client: version.client,
      version: VERSION,
      crxBytes: Buffer.from('CRX'),
      filename: 'noir.crx'
    })
    assert.equal(outcome.status, 'failed')
    assert.equal(outcome.state, 'VERSION_MISMATCH')
    assert.equal(outcome.retryable, false)
  })

  it('allows a new attempt only after an explicitly retryable upload failure', async () => {
    const failed = fixture([{ body: status() }, { body: upload({ uploadState: 'FAILED' }) }])
    const first = await uploadPackage({
      client: failed.client,
      version: VERSION,
      crxBytes: Buffer.from('CRX'),
      filename: 'noir.crx'
    })
    assert.equal(first.status, 'failed')
    assert.equal(first.retryable, true)

    const retried = fixture([
      { body: status({ lastAsyncUploadState: 'FAILED' }) },
      { body: upload() }
    ])
    const second = await uploadPackage({
      client: retried.client,
      version: VERSION,
      crxBytes: Buffer.from('CRX'),
      filename: 'noir.crx',
      previousUpload: first
    })
    assert.equal(second.status, 'succeeded')
    assert.equal(retried.calls.filter(call => call.method === 'POST').length, 1)

    const unknown = fixture([{ body: status({ lastAsyncUploadState: 'FUTURE_STATE' }) }])
    const unknownOutcome = await uploadPackage({
      client: unknown.client,
      version: VERSION,
      crxBytes: Buffer.from('CRX'),
      filename: 'noir.crx'
    })
    assert.equal(unknownOutcome.status, 'failed')
    assert.equal(unknownOutcome.retryable, true)
    assert.deepEqual(
      unknown.calls.map(call => call.method),
      ['GET']
    )
  })

  it('retries bounded GET failures but never exposes response bodies', async () => {
    const { client, calls } = fixture([
      { status: 503, body: { error: { message: TOKEN } } },
      { status: 429, body: { error: { message: TOKEN } } },
      { body: status() }
    ])
    const checked = await client.fetchStatus()
    assert.equal(checked.ok, true)
    assert.equal(calls.length, 3)
    assert.doesNotMatch(JSON.stringify(checked), /synthetic-access-token/)
  })

  it('requires a verified upload receipt before any publish request', async () => {
    const { client, calls } = fixture([])
    const outcome = await submitPackage({
      client,
      version: VERSION,
      uploadReceipt: { status: 'unknown', version: VERSION }
    })
    assert.equal(outcome.status, 'blocked')
    assert.equal(calls.length, 0)
  })

  it('blocks a later asynchronous upload that could replace the verified draft', async () => {
    const { client, calls } = fixture([{ body: status({ lastAsyncUploadState: 'IN_PROGRESS' }) }])
    const outcome = await submitPackage({
      client,
      version: VERSION,
      uploadReceipt: { status: 'succeeded', version: VERSION, uploadState: 'SUCCEEDED' }
    })
    assert.equal(outcome.status, 'blocked')
    assert.equal(outcome.state, 'UNATTRIBUTED_UPLOAD')
    assert.deepEqual(
      calls.map(call => call.method),
      ['GET']
    )

    const current = fixture([
      { body: status({ lastAsyncUploadState: 'SUCCEEDED' }) },
      { body: publish() },
      {
        body: status({
          lastAsyncUploadState: 'SUCCEEDED',
          submittedItemRevisionStatus: submission()
        })
      }
    ])
    const recovered = await submitPackage({
      client: current.client,
      version: VERSION,
      uploadReceipt: { status: 'succeeded', version: VERSION, uploadState: 'IN_PROGRESS' }
    })
    assert.equal(recovered.status, 'succeeded')
  })
})
