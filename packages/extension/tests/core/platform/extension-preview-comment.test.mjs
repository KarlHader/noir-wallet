import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reportExtensionPreview } from '../../../../../scripts/extension-preview-comment.mjs'

const repository = 'NoirWallet/noir-wallet'
const sha = 'a'.repeat(40)
const runId = 100
const runAttempt = 1

function fixture() {
  const run = {
    id: runId,
    run_attempt: runAttempt,
    repository: { full_name: repository },
    head_repository: { id: 9 },
    path: '.github/workflows/extension-ci.yml',
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
    head_sha: sha,
    run_started_at: '2026-10-14T10:00:00Z',
    pull_requests: [{ number: 20 }]
  }
  const pr = {
    number: 20,
    state: 'open',
    head: { sha, repo: { id: 9, full_name: repository } },
    base: { ref: 'main', repo: { full_name: repository } },
    labels: []
  }
  const artifact = {
    id: 300,
    name: 'noir-wallet-development-v2.0.0-pr.20.bbbbbbb',
    expired: false,
    size_in_bytes: 100,
    created_at: '2026-10-14T10:05:00Z',
    expires_at: '2026-10-21T10:05:00Z',
    workflow_run: { id: runId, head_sha: sha }
  }
  const comments = []
  const writes = []
  const routes = []
  const responses = new Map()
  let prReads = 0
  const state = { run, pr, artifact, artifacts: [artifact], comments, writes, routes, responses }
  state.request = async (route, options = {}) => {
    routes.push(route)
    if (options.method) {
      writes.push({ route, ...options })
      return { id: 400 }
    }
    if (responses.has(route)) return responses.get(route)
    if (route === `actions/runs/${runId}`) return run
    if (route === 'pulls/20') return ++prReads > 1 && state.currentPr ? state.currentPr : pr
    if (route.startsWith(`actions/runs/${runId}/artifacts?`)) return { artifacts: state.artifacts }
    if (route.startsWith('actions/artifacts?'))
      return { artifacts: state.repositoryArtifacts ?? state.artifacts }
    if (
      route.startsWith(`actions/workflows/extension-ci.yml/runs?event=pull_request&head_sha=${sha}`)
    )
      return { workflow_runs: state.buildRuns ?? [run] }
    if (route.startsWith('issues/20/comments?')) return comments
    if (route.startsWith(`commits/${sha}/pulls?`)) return [{ number: 20 }]
    throw new Error(`Unexpected request: ${route}`)
  }
  state.report = (eventAction = 'completed') =>
    reportExtensionPreview({ repository, runId, runAttempt, eventAction, request: state.request })
  return state
}

function botComment(body, id = 400) {
  return { id, body, user: { login: 'github-actions[bot]', type: 'Bot' } }
}

for (const base of ['main', 'release/2.0.0']) {
  test(`links the exact V2 artifact to its ${base} PR`, async () => {
    const state = fixture()
    state.pr.base.ref = base
    assert.deepEqual(await state.report(), [20])
    assert.equal(state.writes[0].route, 'issues/20/comments')
    assert.equal(state.writes[0].method, 'POST')
    const { body } = state.writes[0].body
    assert.match(body, /actions\/runs\/100\/artifacts\/300/)
    assert.match(body, /V2 development/)
    assert.match(body, /Expires: 2026-10-21T10:05:00 UTC/)
    assert.match(body, /Built: 2026-10-14T10:05:00 UTC/)
    assert.match(body, /Preview package: \*\*ready\*\*/)
    assert.doesNotMatch(body, /Swap is unavailable/)
    assert.match(body, new RegExp(`/commit/${sha}`))
  })
}

test('updates only its own comment and deduplicates repeated completion events', async () => {
  const state = fixture()
  const forged = {
    ...botComment('<!-- noir-extension-preview:999:1 -->'),
    user: { login: 'attacker', type: 'User' }
  }
  state.comments.push(forged, botComment('<!-- noir-extension-preview:99:1 -->\nOld package'))
  await state.report()
  assert.equal(state.writes[0].route, 'issues/comments/400')
  assert.equal(state.writes[0].method, 'PATCH')
  state.comments[1].body = state.writes[0].body.body
  assert.deepEqual(await state.report(), [])
  assert.equal(state.writes.length, 1)
})

test('rejects unrelated runs and malformed identities before any comment write', async () => {
  for (const change of [
    { event: 'push' },
    { path: '.github/workflows/docs.yml' },
    { id: 101 },
    { repository: { full_name: 'attacker/repo' } },
    { head_sha: 'bad' },
    { head_repository: null },
    { pull_requests: [{ number: '../21' }] },
    { conclusion: 'success\n[click](https://evil.example)' }
  ]) {
    const state = fixture()
    Object.assign(state.run, change)
    await assert.rejects(state.report)
    assert.equal(state.writes.length, 0)
  }
  await assert.rejects(
    reportExtensionPreview({
      repository: 'owner/repo/../../evil',
      runId,
      runAttempt,
      request: () => assert.fail()
    })
  )
})

test('skips closed, advanced, retargeted and unrelated PRs', async () => {
  for (const change of [
    { state: 'closed' },
    { head: { sha: 'b'.repeat(40), repo: { id: 9 } } },
    { head: { sha, repo: { id: 10 } } },
    { number: 21 },
    { base: { ref: 'other', repo: { full_name: repository } } },
    { base: { ref: 'main', repo: { full_name: 'attacker/repo' } } },
    { base: { ref: 'v2', repo: { full_name: repository } } }
  ]) {
    const state = fixture()
    Object.assign(state.pr, change)
    assert.deepEqual(await state.report(), [])
    assert.equal(state.writes.length, 0)
  }
})

test('checks PR identity again before writing after an intervening push', async () => {
  const state = fixture()
  state.currentPr = { ...state.pr, head: { ...state.pr.head, sha: 'b'.repeat(40) } }
  assert.deepEqual(await state.report(), [])
  assert.equal(state.writes.length, 0)
})

test('finds fork PR associations when the run has no pull_requests entries', async () => {
  const state = fixture()
  state.run.pull_requests = []
  state.run.head_repository.id = state.pr.head.repo.id = 42
  state.pr.head.repo.full_name = 'contributor/noir-wallet'
  await state.report()
  assert.ok(state.routes.includes(`commits/${sha}/pulls?per_page=100&page=1`))
  assert.equal(state.writes.length, 1)
  assert.match(state.writes[0].body.body, /Swap is unavailable in fork previews/)
})

test('does not let an older run or attempt overwrite a newer comment', async () => {
  for (const identity of ['101:1', '100:2']) {
    const state = fixture()
    state.comments.push(botComment(`<!-- noir-extension-preview:${identity} -->\nNew package`))
    assert.deepEqual(await state.report(), [])
    assert.equal(state.writes.length, 0)
  }
  const state = fixture()
  state.run.run_attempt = 2
  assert.deepEqual(await state.report(), [])
  assert.equal(state.writes.length, 0)
})

test('replaces a previous download with the current failed or cancelled build result', async () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out']) {
    const state = fixture()
    state.run.conclusion = conclusion
    state.comments.push(botComment('<!-- noir-extension-preview:99:1 -->\nOld download'))
    await state.report()
    const body = state.writes[0].body.body
    assert.ok(body.includes(`**${conclusion}**`))
    assert.doesNotMatch(body, /\/artifacts\//)
    assert.equal(
      state.routes.some(route => route.includes('/artifacts?')),
      false
    )
  }
})

test('never links missing, ambiguous, expired, unrelated, or previous-attempt artifacts', async () => {
  for (const change of [
    { expired: true },
    { id: -1 },
    { size_in_bytes: 0 },
    { name: 'noir-wallet-v1.0.39-pr.21.bbbbbbb' },
    { name: 'noir-wallet-v1.0.39-pr.20.bbbbbbb' },
    { name: 'noir-wallet-development-v1.0.39-pr.20.bbbbbbb' },
    { name: 'noir-wallet-v2.0.0-pr.20.bbbbbbb' },
    { workflow_run: { id: 99, head_sha: sha } },
    { workflow_run: { id: runId, head_sha: 'b'.repeat(40) } },
    { created_at: '2026-10-14T09:00:00Z' },
    { expires_at: 'invalid' },
    'missing',
    'duplicate'
  ]) {
    const state = fixture()
    if (change === 'missing') state.artifacts = []
    else if (change === 'duplicate') state.artifacts.push({ ...state.artifact, id: 301 })
    else Object.assign(state.artifact, change)
    await state.report()
    assert.match(state.writes[0].body.body, /unavailable or expired/)
    assert.doesNotMatch(state.writes[0].body.body, /\/artifacts\//)
  }
})

test('paginates artifact and comment inventories before selecting a download', async () => {
  const state = fixture()
  state.responses.set(`actions/runs/${runId}/artifacts?per_page=100&page=1`, {
    artifacts: Array.from({ length: 100 }, () => ({ name: 'other' }))
  })
  state.responses.set(
    'issues/20/comments?per_page=100&page=1',
    Array.from({ length: 100 }, () => ({ body: 'unrelated' }))
  )
  state.comments.push(botComment('<!-- noir-extension-preview:99:1 -->'))
  await state.report()
  assert.ok(state.routes.includes(`actions/runs/${runId}/artifacts?per_page=100&page=2`))
  assert.ok(state.routes.includes('issues/20/comments?per_page=100&page=2'))
  assert.equal(state.writes[0].method, 'PATCH')
  assert.match(state.writes[0].body.body, /\/artifacts\/300/)
})

test('fails closed on malformed API data or a comment write failure', async () => {
  const state = fixture()
  state.responses.set(`actions/runs/${runId}/artifacts?per_page=100&page=1`, { artifacts: null })
  await assert.rejects(state.report, /Invalid GitHub list/)
  assert.equal(state.writes.length, 0)
  const valid = fixture()
  await assert.rejects(
    reportExtensionPreview({
      repository,
      runId,
      runAttempt,
      request: async (route, options) => {
        if (options?.method) throw new Error('write denied')
        return valid.request(route, options)
      }
    }),
    /write denied/
  )
})

test('a requested run replaces an older download with building, then its result', async () => {
  const state = fixture()
  state.comments.push(botComment('<!-- noir-extension-preview:99:1 -->\nOld download'))
  state.run.status = 'queued'
  state.run.conclusion = null
  await state.report('requested')
  assert.match(state.writes[0].body.body, /Preview package: \*\*building\*\*/)
  assert.doesNotMatch(state.writes[0].body.body, /\/artifacts\//)
  assert.equal(state.writes[0].method, 'PATCH')
  state.run.status = 'completed'
  state.run.conclusion = 'success'
  state.comments[0].body = state.writes[0].body.body
  state.writes.length = 0
  await state.report()
  assert.ok(
    state.writes.some(write => write.method === 'PATCH' && /\/artifacts\/300/.test(write.body.body))
  )
})

test('an older request or completion cannot overwrite a newer run before it comments', async () => {
  const state = fixture()
  state.buildRuns = [{ ...state.run, id: 101, status: 'queued', conclusion: null }, state.run]
  await state.report('requested')
  assert.equal(state.writes.length, 0)
  state.writes.length = 0
  state.run.conclusion = 'failure'
  await state.report('completed')
  assert.equal(state.writes.length, 0)
})

test('finds a newer fork run through commit association on a later inventory page', async () => {
  const state = fixture()
  state.pr.head.repo.full_name = 'contributor/noir-wallet'
  state.responses.set(
    `actions/workflows/extension-ci.yml/runs?event=pull_request&head_sha=${sha}&per_page=100&page=1`,
    {
      workflow_runs: Array.from({ length: 100 }, (_, index) => ({
        ...state.run,
        id: 200 + index,
        pull_requests: [{ number: 21 }]
      }))
    }
  )
  state.responses.set(
    `actions/workflows/extension-ci.yml/runs?event=pull_request&head_sha=${sha}&per_page=100&page=2`,
    {
      workflow_runs: [{ ...state.run, id: 101, pull_requests: [] }]
    }
  )
  assert.deepEqual(await state.report(), [])
  assert.ok(state.routes.includes(`commits/${sha}/pulls?per_page=100&page=1`))
  assert.equal(state.writes.length, 0)
})

test('a push between inventory and comment write leaves the new head untouched', async () => {
  const state = fixture()
  state.currentPr = { ...state.pr, head: { ...state.pr.head, sha: 'c'.repeat(40) } }
  assert.deepEqual(await state.report('requested'), [])
  assert.equal(state.writes.length, 0)
})

test('keeps only the two newest verified preview artifacts for this PR', async () => {
  const state = fixture()
  const oldSha = 'b'.repeat(40)
  const makeArtifact = (id, createdAt, name = state.artifact.name, sourceRun = runId) => ({
    ...state.artifact,
    id,
    name,
    created_at: createdAt,
    workflow_run: { id: sourceRun, head_sha: sourceRun === runId ? sha : oldSha }
  })
  state.repositoryArtifacts = [
    makeArtifact(300, '2026-10-14T10:05:00Z'),
    makeArtifact(301, '2026-10-14T09:04:00Z', state.artifact.name, 90),
    makeArtifact(302, '2026-10-14T08:03:00Z', state.artifact.name, 89),
    makeArtifact(303, '2026-10-14T10:02:00Z', 'noir-wallet-development-v2.0.0-pr.21.bbbbbbb'),
    makeArtifact(304, '2026-10-14T10:01:00Z', state.artifact.name, 999)
  ]
  for (const [id, startedAt] of [
    [90, '2026-10-14T09:00:00Z'],
    [89, '2026-10-14T08:00:00Z']
  ])
    state.responses.set(`actions/runs/${id}`, {
      ...state.run,
      id,
      head_sha: oldSha,
      run_started_at: startedAt
    })
  state.responses.set('actions/runs/999', {
    ...state.run,
    id: 999,
    path: '.github/workflows/docs.yml'
  })
  await state.report()
  assert.deepEqual(
    state.writes.filter(write => write.method === 'DELETE').map(write => write.route),
    ['actions/artifacts/302']
  )
})

test('does not treat an unrelated newer PR run as superseding this PR', async () => {
  const state = fixture()
  state.buildRuns = [{ ...state.run, id: 101, pull_requests: [{ number: 21 }] }, state.run]
  assert.deepEqual(await state.report(), [20])
  assert.equal(state.writes[0].method, 'POST')
})
