import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
  loadReleaseJournal,
  makeReceipt,
  receiptArtifactName,
  validateBinding
} from '../../../scripts/lib/store-release-journal.mjs'

const repository = 'NoirWallet/noir-wallet'
const sha = digit => digit.repeat(40)
const digest = digit => digit.repeat(64)
const binding = {
  repository,
  candidateRunId: '12345',
  candidateRunAttempt: '2',
  candidateWorkflowSha: sha('a'),
  sourceSha: sha('b'),
  version: '1.2.3',
  network: 'mainnet',
  zipName: 'noir-wallet-v1.2.3.zip',
  zipSha256: digest('c'),
  zipSize: 100,
  crxName: 'noir-wallet-v1.2.3.crx',
  crxSha256: digest('d'),
  crxSize: 200,
  publicKeySha256: digest('e'),
  publisherId: 'publisher_1',
  extensionId: 'a'.repeat(32)
}
const run = (id, attempt = 1) => ({ id: String(id), attempt: String(attempt), sha: sha('f') })
const result = (status = 'succeeded') => ({ status, retryable: false })

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function receiptZip(value) {
  const name = Buffer.from('receipt.json')
  const content = Buffer.from(JSON.stringify(value))
  const checksum = crc32(content)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt32LE(checksum, 14)
  local.writeUInt32LE(content.length, 18)
  local.writeUInt32LE(content.length, 22)
  local.writeUInt16LE(name.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt32LE(checksum, 16)
  central.writeUInt32LE(content.length, 20)
  central.writeUInt32LE(content.length, 24)
  central.writeUInt16LE(name.length, 28)
  const offset = local.length + name.length + content.length
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + name.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([local, name, content, central, name, end])
}

function fixtureReceipt(stage, phase, id, attempt = 1, overrides = {}) {
  return makeReceipt({
    binding: { ...binding, ...overrides },
    stage,
    phase,
    run: run(id, attempt),
    result: phase === 'result' ? result() : null
  })
}

function fixtureArtifact(receipt, id, createdAt = '2026-11-01T00:00:00Z', overrides = {}) {
  const bytes = receiptZip(receipt)
  return {
    id,
    name: receiptArtifactName(receipt),
    created_at: createdAt,
    size_in_bytes: bytes.length,
    expired: false,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    workflow_run: { id: Number(receipt.run.id), head_sha: receipt.run.sha },
    bytes,
    ...overrides
  }
}

function githubFixture(artifacts, options = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    if (url.startsWith('https://download.example/')) {
      assert.equal(init.headers?.Authorization, undefined)
      const artifact = artifacts.find(item => String(item.id) === url.split('/').at(-1))
      return new Response(artifact.bytes)
    }
    assert.match(url, /^https:\/\/api\.github\.com\/repos\/NoirWallet\/noir-wallet\//)
    assert.equal(init.headers.Authorization, 'Bearer fake-token')
    const route = url.split('/repos/NoirWallet/noir-wallet/')[1]
    if (route.startsWith('actions/artifacts?')) {
      const page = Number(new URL(url).searchParams.get('page'))
      const selected = options.pageSize
        ? artifacts.slice((page - 1) * options.pageSize, page * options.pageSize)
        : page === 1
          ? artifacts
          : []
      return Response.json({
        total_count: artifacts.length,
        artifacts: selected.map(({ bytes, ...item }) => item)
      })
    }
    if (route === 'actions/workflows/publish-extension.yml') {
      return Response.json({ id: 42, path: '.github/workflows/publish-extension.yml' })
    }
    if (route.startsWith('actions/workflows/publish-extension.yml/runs?')) {
      const history = options.historyRuns ?? []
      const page = Number(new URL(url).searchParams.get('page'))
      return Response.json({
        total_count: history.length,
        workflow_runs: history.slice((page - 1) * 100, page * 100)
      })
    }
    const jobsMatch = /^actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs\?/.exec(route)
    if (jobsMatch) {
      const jobs = options.historyJobs?.[`${jobsMatch[1]}/${jobsMatch[2]}`] ?? []
      const page = Number(new URL(url).searchParams.get('page'))
      return Response.json({
        total_count: jobs.length,
        jobs: jobs.slice((page - 1) * 100, page * 100)
      })
    }
    const runMatch = /^actions\/runs\/(\d+)\/attempts\/(\d+)$/.exec(route)
    if (runMatch) {
      return Response.json({
        id: Number(runMatch[1]),
        run_attempt: Number(runMatch[2]),
        workflow_id: 42,
        path: options.runPath ?? '.github/workflows/publish-extension.yml',
        event: options.event ?? 'workflow_dispatch',
        head_branch: options.branch ?? 'main',
        head_sha: options.headSha ?? sha('f'),
        repository: { full_name: options.repository ?? repository },
        run_started_at: '2026-10-31T00:00:00Z',
        status: 'completed',
        conclusion: 'failure'
      })
    }
    const archiveMatch = /^actions\/artifacts\/(\d+)\/zip$/.exec(route)
    if (archiveMatch) {
      return new Response(null, {
        status: 302,
        headers: { Location: `https://download.example/${archiveMatch[1]}` }
      })
    }
    throw new Error(`Unexpected test request: ${route}`)
  }
  return { fetchImpl, calls }
}

async function restore(artifacts, options = {}) {
  const { fetchImpl, calls } = githubFixture(artifacts, options)
  const value = await loadReleaseJournal({
    binding,
    repository,
    token: 'fake-token',
    currentRun: options.currentRun ?? run(99),
    fetchImpl
  })
  return { value, calls }
}

function historicRun(id, options = {}) {
  return {
    id,
    run_attempt: options.attempt ?? 1,
    workflow_id: 42,
    path: '.github/workflows/publish-extension.yml',
    event: 'workflow_dispatch',
    head_branch: 'main',
    head_sha: sha('f'),
    repository: { full_name: repository },
    display_title:
      options.title ?? `publish accepted build 54321 attempt 1 source ${binding.sourceSha}`
  }
}

function historicJob(id, stage, steps) {
  return {
    run_id: id,
    head_sha: sha('f'),
    name: stage,
    status: 'completed',
    conclusion: 'failure',
    steps
  }
}

describe('Store release journal', () => {
  it('canonicalizes identity and rejects altered CRX or unsafe result data', () => {
    assert.deepEqual(validateBinding({ ...binding, candidateRunId: 12345 }), binding)
    assert.throws(() => validateBinding({ ...binding, crxSha256: digest('0').slice(1) }))
    assert.throws(() => validateBinding({ ...binding, zipSize: '100' }))
    assert.throws(() => validateBinding({ ...binding, network: 'testnet' }))
    assert.equal(validateBinding({ ...binding, network: 'multichain' }).network, 'multichain')
    assert.throws(
      () =>
        makeReceipt({
          binding,
          stage: 'upload',
          phase: 'result',
          run: run(50),
          result: { ...result(), token: 'secret' }
        }),
      /unsupported field/
    )
    assert.throws(
      () =>
        makeReceipt({ binding, stage: 'notify', phase: 'intent', run: run(50), result: result() }),
      /Intent cannot contain/
    )
  })

  it('recovers latest exact receipts from a failed workflow and drops authorization on redirect', async () => {
    const uploaded = fixtureReceipt('upload', 'result', 51)
    uploaded.result = {
      ...result(),
      version: binding.version,
      uploadState: 'SUCCEEDED',
      priorAsyncUploadState: 'SUCCEEDED'
    }
    const artifacts = [
      fixtureArtifact(fixtureReceipt('upload', 'intent', 51), 1),
      fixtureArtifact(uploaded, 2, '2026-11-01T00:01:00Z'),
      fixtureArtifact(fixtureReceipt('submit', 'result', 51), 3, '2026-11-01T00:02:00Z')
    ]
    const { value, calls } = await restore(artifacts)
    assert.deepEqual(value, { upload: uploaded.result, submit: result(), notify: null })
    assert.equal(calls.filter(call => call.url.startsWith('https://download.example/')).length, 3)
  })

  it('uses artifact creation time, not inventory order, and treats a later intent as unknown', async () => {
    const artifacts = [
      fixtureArtifact(fixtureReceipt('upload', 'intent', 52), 10, '2026-11-01T00:03:00Z'),
      fixtureArtifact(fixtureReceipt('upload', 'result', 51), 8, '2026-11-01T00:04:00Z'),
      fixtureArtifact(fixtureReceipt('upload', 'intent', 51), 7, '2026-11-01T00:01:00Z')
    ]
    const { value } = await restore(artifacts)
    assert.deepEqual(value.upload, {
      status: 'unknown',
      retryable: false,
      reason: 'receipt_missing'
    })
  })

  it('blocks a same-version different candidate or CRX, expired archive, and corrupted archive', async () => {
    const mismatched = fixtureArtifact(
      fixtureReceipt('upload', 'result', 51, 1, { crxSha256: digest('9') }),
      1
    )
    const good = fixtureArtifact(fixtureReceipt('upload', 'result', 51), 2)
    for (const artifacts of [
      [mismatched],
      [fixtureArtifact(fixtureReceipt('upload', 'result', 51, 1, { candidateRunId: '9' }), 1)],
      [{ ...good, expired: true }],
      [{ ...good, bytes: Buffer.from('bad') }]
    ]) {
      await assert.rejects(restore(artifacts))
    }
  })

  it('rejects forged workflow provenance and receipt run SHA', async () => {
    const receipt = fixtureReceipt('notify', 'result', 51)
    const artifacts = [fixtureArtifact(receipt, 1)]
    for (const options of [
      { event: 'push' },
      { branch: 'release/1.2.3' },
      { runPath: '.github/workflows/other.yml' },
      { repository: 'other/repo' },
      { headSha: sha('a') }
    ]) {
      await assert.rejects(
        restore(artifacts, options),
        /provenance|workflow run|accepted candidate/
      )
    }
  })

  it('paginates and fails closed when the artifact inventory exceeds 20 pages', async () => {
    const target = fixtureArtifact(fixtureReceipt('upload', 'result', 51), 2001)
    const filler = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      name: `other-${index}`
    }))
    const { value, calls } = await restore([...filler, target], { pageSize: 100 })
    assert.deepEqual(value.upload, result())
    assert.ok(calls.some(call => call.url.includes('page=2')))

    const huge = Array.from({ length: 2001 }, (_, index) => ({ id: index + 1, name: 'other' }))
    await assert.rejects(restore(huge, { pageSize: 100 }), /inventory is incomplete/)
  })

  it('blocks when a previous store operation lost all same-version receipts', async () => {
    const historyRuns = [
      historicRun(51),
      historicRun(99, {
        title: `publish accepted build ${binding.candidateRunId} attempt ${binding.candidateRunAttempt} source ${binding.sourceSha}`
      })
    ]
    const historyJobs = {
      '51/1': [
        historicJob(51, 'upload', [
          {
            name: 'Persist intent before any external write',
            status: 'completed',
            conclusion: 'success'
          },
          { name: 'Execute or reconcile upload', status: 'completed', conclusion: 'failure' }
        ])
      ]
    }
    await assert.rejects(
      restore([], { historyRuns, historyJobs }),
      /missing release journal receipt/
    )
  })

  it('allows previous GitHub-only and pre-intent failures to retry', async () => {
    const historyRuns = [
      historicRun(51),
      historicRun(52, {
        title: `publish accepted build ${binding.candidateRunId} attempt ${binding.candidateRunAttempt}`
      })
    ]
    const historyJobs = {
      '51/1': [
        historicJob(51, 'upload', [
          {
            name: 'Authenticate to Chrome Web Store through WIF',
            status: 'completed',
            conclusion: 'failure'
          },
          {
            name: 'Persist intent before any external write',
            status: 'completed',
            conclusion: 'skipped',
            started_at: '2026-11-01T00:00:00Z'
          },
          {
            name: 'Execute or reconcile upload',
            status: 'completed',
            conclusion: 'skipped',
            started_at: '2026-11-01T00:00:00Z'
          }
        ])
      ],
      '52/1': [{ ...historicJob(52, 'upload', []), conclusion: 'skipped' }]
    }
    const { value } = await restore([], { historyRuns, historyJobs })
    assert.deepEqual(value, { upload: null, submit: null, notify: null })
  })

  it('checks older attempts of the current run and fails closed on truncated run history', async () => {
    const historyRuns = [historicRun(99, { attempt: 2 })]
    const historyJobs = {
      '99/1': [
        historicJob(99, 'notify', [
          { name: 'Execute or reconcile notify', status: 'completed', conclusion: 'failure' }
        ])
      ]
    }
    await assert.rejects(
      restore([], { historyRuns, historyJobs, currentRun: run(99, 2) }),
      /missing release journal receipt/
    )
    await assert.rejects(
      restore([], { historyRuns: Array.from({ length: 1000 }, (_, id) => historicRun(id + 1)) }),
      /workflow history is incomplete/
    )
  })
})
