import { createHash } from 'node:crypto'
import { readZipEntry } from './release-zip.mjs'

const BINDING_FIELDS = [
  'repository',
  'candidateRunId',
  'candidateRunAttempt',
  'candidateWorkflowSha',
  'sourceSha',
  'version',
  'network',
  'zipName',
  'zipSha256',
  'zipSize',
  'crxName',
  'crxSha256',
  'crxSize',
  'publicKeySha256',
  'publisherId',
  'extensionId'
]
const STAGES = ['upload', 'submit', 'notify']
const PHASES = ['intent', 'result']
const RESULT_FIELDS = [
  'status',
  'retryable',
  'state',
  'version',
  'httpStatus',
  'reason',
  'itemId',
  'uploadState'
]
const SHA256 = /^[0-9a-f]{64}$/
const SHA = /^[0-9a-f]{40}$/
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/
const EXTENSION_ID = /^[a-p]{32}$/
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024
const MAX_RECEIPT_BYTES = 16 * 1024
const API = 'https://api.github.com'

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value
}

function exactKeys(value, fields, label) {
  if (
    Object.keys(value).length !== fields.length ||
    fields.some(field => !Object.hasOwn(value, field))
  ) {
    throw new Error(`${label} has unexpected or missing fields`)
  }
}

function decimal(value, label) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`${label} must be a positive safe integer`)
  }
  const text = String(value)
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  return text
}

function positiveSize(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  return value
}

function matching(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Invalid ${label}`)
  return value
}

export function validateBinding(value) {
  object(value, 'Release binding')
  exactKeys(value, BINDING_FIELDS, 'Release binding')
  const binding = {}
  for (const field of BINDING_FIELDS) {
    const entry = value[field]
    if (['candidateRunId', 'candidateRunAttempt'].includes(field)) {
      binding[field] = decimal(entry, field)
    } else if (['zipSize', 'crxSize'].includes(field)) {
      binding[field] = positiveSize(entry, field)
    } else if (['candidateWorkflowSha', 'sourceSha'].includes(field)) {
      binding[field] = matching(entry, SHA, field)
    } else if (['zipSha256', 'crxSha256', 'publicKeySha256'].includes(field)) {
      binding[field] = matching(entry, SHA256, field)
    } else if (field === 'repository') {
      binding[field] = matching(entry, REPOSITORY, field)
    } else if (field === 'version') {
      binding[field] = matching(entry, VERSION, field)
    } else if (field === 'network') {
      binding[field] = matching(entry, /^(mainnet|multichain)$/, field)
    } else if (field === 'extensionId') {
      binding[field] = matching(entry, EXTENSION_ID, field)
    } else if (field === 'publisherId') {
      binding[field] = matching(entry, /^[A-Za-z0-9_-]{1,128}$/, field)
    } else {
      binding[field] = matching(entry, /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.(?:zip|crx)$/, field)
      if (!binding[field].endsWith(field === 'zipName' ? '.zip' : '.crx')) {
        throw new Error(`Invalid ${field}`)
      }
    }
  }
  return binding
}

function validateRun(value) {
  object(value, 'Receipt run')
  exactKeys(value, ['id', 'attempt', 'sha'], 'Receipt run')
  return {
    id: decimal(value.id, 'run.id'),
    attempt: decimal(value.attempt, 'run.attempt'),
    sha: matching(value.sha, SHA, 'run.sha')
  }
}

function validateResult(value) {
  object(value, 'Receipt result')
  for (const key of Object.keys(value)) {
    if (!RESULT_FIELDS.includes(key)) throw new Error('Receipt result has an unsupported field')
  }
  if (
    !['succeeded', 'failed', 'unknown', 'blocked'].includes(value.status) ||
    typeof value.retryable !== 'boolean'
  ) {
    throw new Error('Invalid receipt result status')
  }
  const result = { status: value.status, retryable: value.retryable }
  for (const key of RESULT_FIELDS.slice(2)) {
    if (!Object.hasOwn(value, key)) continue
    const entry = value[key]
    if (key === 'httpStatus') {
      if (!Number.isInteger(entry) || entry < 100 || entry > 599) {
        throw new Error('Invalid receipt HTTP status')
      }
    } else if (typeof entry !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(entry)) {
      throw new Error(`Invalid receipt ${key}`)
    }
    result[key] = entry
  }
  return result
}

export function makeReceipt({ binding, stage, phase, run, result }) {
  const validatedBinding = validateBinding(binding)
  if (!STAGES.includes(stage) || !PHASES.includes(phase))
    throw new Error('Invalid receipt stage or phase')
  const validatedRun = validateRun(run)
  if (phase === 'intent' && result != null) throw new Error('Intent cannot contain a result')
  return {
    schemaVersion: 1,
    binding: validatedBinding,
    stage,
    phase,
    run: validatedRun,
    result: phase === 'result' ? validateResult(result) : null
  }
}

export function receiptArtifactName(receipt) {
  const checked = parseReceipt(receipt)
  const { extensionId, version } = checked.binding
  return `cws-${extensionId}-${version}-${checked.stage}-${checked.phase}-${checked.run.id}-${checked.run.attempt}`
}

function parseReceipt(value) {
  object(value, 'Receipt')
  exactKeys(value, ['schemaVersion', 'binding', 'stage', 'phase', 'run', 'result'], 'Receipt')
  if (value.schemaVersion !== 1) throw new Error('Unsupported receipt schema')
  return makeReceipt(value)
}

function same(value, expected) {
  return JSON.stringify(value) === JSON.stringify(expected)
}

function artifactIdentity(artifact, prefix) {
  if (typeof artifact.name !== 'string' || !artifact.name.startsWith(prefix)) return null
  const suffix = artifact.name.slice(prefix.length)
  const match = /^(upload|submit|notify)-(intent|result)-([1-9]\d*)-([1-9]\d*)$/.exec(suffix)
  if (!match) throw new Error('Malformed release journal artifact name')
  if (
    !Number.isSafeInteger(artifact.id) ||
    artifact.id <= 0 ||
    !Number.isSafeInteger(artifact.size_in_bytes) ||
    artifact.size_in_bytes <= 0 ||
    artifact.size_in_bytes > MAX_ARCHIVE_BYTES ||
    artifact.expired !== false ||
    !Number.isFinite(Date.parse(artifact.created_at))
  ) {
    throw new Error('Release journal artifact is missing, expired, or invalid')
  }
  if (artifact.digest !== undefined && !/^sha256:[0-9a-f]{64}$/.test(artifact.digest)) {
    throw new Error('Invalid release journal artifact digest')
  }
  return {
    stage: match[1],
    phase: match[2],
    runId: decimal(match[3], 'artifact run ID'),
    attempt: decimal(match[4], 'artifact run attempt'),
    createdAt: Date.parse(artifact.created_at)
  }
}

async function responseBytes(response, limit) {
  const length = response.headers?.get('content-length')
  if (length !== null && length !== undefined && Number(length) > limit) {
    throw new Error('Release journal archive is too large')
  }
  const chunks = []
  let size = 0
  if (response.body?.getReader) {
    const reader = response.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > limit) throw new Error('Release journal archive is too large')
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    return Buffer.concat(chunks, size)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > limit) throw new Error('Release journal archive is too large')
  return bytes
}

async function githubGet(fetchImpl, repository, token, route, archive = false) {
  const apiUrl = `${API}/repos/${repository}/${route}`
  let response
  try {
    response = await fetchImpl(apiUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28'
      },
      signal: AbortSignal.timeout(30000)
    })
    if (archive) {
      for (let redirects = 0; [301, 302, 303, 307, 308].includes(response.status); redirects++) {
        if (redirects >= 3) throw new Error('Too many release journal redirects')
        const location = response.headers?.get('location')
        const target = new URL(location, apiUrl)
        if (target.protocol !== 'https:') throw new Error('Unsafe release journal redirect')
        response = await fetchImpl(target.href, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(30000)
        })
      }
    }
  } catch (error) {
    if (
      error?.message?.startsWith('Too many release journal') ||
      error?.message?.startsWith('Unsafe release journal')
    )
      throw error
    throw new Error('GitHub release journal request failed')
  }
  if (!response.ok)
    throw new Error(`GitHub release journal request failed (HTTP ${response.status})`)
  return archive ? responseBytes(response, MAX_ARCHIVE_BYTES) : response.json()
}

async function requireHistoricalReceipts({
  fetchImpl,
  repository,
  token,
  workflowId,
  binding,
  currentRun,
  entries
}) {
  const workflowRuns = []
  for (let page = 1; page <= 10; page++) {
    const data = await githubGet(
      fetchImpl,
      repository,
      token,
      `actions/workflows/publish-extension.yml/runs?event=workflow_dispatch&branch=main&per_page=100&page=${page}`
    )
    if (
      !Number.isSafeInteger(data?.total_count) ||
      data.total_count < 0 ||
      !Array.isArray(data.workflow_runs) ||
      data.workflow_runs.length > 100 ||
      data.total_count >= 1000
    ) {
      throw new Error('Release journal workflow history is incomplete')
    }
    workflowRuns.push(...data.workflow_runs)
    if (workflowRuns.length >= data.total_count) break
    if (page === 10 || data.workflow_runs.length === 0) {
      throw new Error('Release journal workflow history is incomplete')
    }
  }

  const legacyTitle = `publish accepted build ${binding.candidateRunId} attempt ${binding.candidateRunAttempt}`
  for (const listed of workflowRuns) {
    const title = typeof listed.display_title === 'string' ? listed.display_title.toLowerCase() : ''
    const sourceTitle =
      /^publish accepted build ([1-9]\d*) attempt ([1-9]\d*) source ([0-9a-f]{40})$/.exec(title)
    if (title !== legacyTitle && sourceTitle?.[3] !== binding.sourceSha) continue
    if (
      !Number.isSafeInteger(listed.id) ||
      listed.id <= 0 ||
      !Number.isSafeInteger(listed.run_attempt) ||
      listed.run_attempt < 1 ||
      listed.run_attempt > 20 ||
      listed.workflow_id !== workflowId ||
      ![
        '.github/workflows/publish-extension.yml',
        '.github/workflows/publish-extension.yml@main'
      ].includes(listed.path) ||
      listed.event !== 'workflow_dispatch' ||
      listed.head_branch !== 'main' ||
      listed.repository?.full_name?.toLowerCase() !== repository.toLowerCase() ||
      !SHA.test(listed.head_sha ?? '')
    ) {
      throw new Error('Release journal workflow history has untrusted provenance')
    }
    for (let attempt = 1; attempt <= listed.run_attempt; attempt++) {
      if (String(listed.id) === currentRun.id && String(attempt) === currentRun.attempt) {
        if (listed.head_sha !== currentRun.sha) {
          throw new Error('Current release run does not match workflow history')
        }
        continue
      }
      const jobs = []
      for (let page = 1; page <= 20; page++) {
        const data = await githubGet(
          fetchImpl,
          repository,
          token,
          `actions/runs/${listed.id}/attempts/${attempt}/jobs?per_page=100&page=${page}`
        )
        if (
          !Number.isSafeInteger(data?.total_count) ||
          data.total_count < 0 ||
          !Array.isArray(data.jobs) ||
          data.jobs.length > 100
        ) {
          throw new Error('Invalid release journal workflow jobs')
        }
        jobs.push(...data.jobs)
        if (jobs.length >= data.total_count) break
        if (page === 20 || data.jobs.length === 0) {
          throw new Error('Release journal workflow jobs are incomplete')
        }
      }
      for (const job of jobs) {
        if (!STAGES.includes(job.name) || job.conclusion === 'skipped') continue
        if (
          String(job.run_id) !== String(listed.id) ||
          job.head_sha !== listed.head_sha ||
          !Array.isArray(job.steps)
        ) {
          throw new Error('Release journal workflow job has untrusted provenance')
        }
        const intentPersisted = job.steps.some(
          step =>
            step.name === 'Persist intent before any external write' &&
            step.conclusion === 'success'
        )
        const executionStarted = job.steps.some(
          step =>
            step.name === `Execute or reconcile ${job.name}` &&
            step.conclusion !== 'skipped' &&
            (['in_progress', 'completed'].includes(step.status) ||
              Number.isFinite(Date.parse(step.started_at)))
        )
        const recorded = entries.filter(
          entry =>
            entry.runId === String(listed.id) &&
            entry.attempt === String(attempt) &&
            entry.stage === job.name
        )
        if (
          (intentPersisted && !recorded.some(entry => entry.phase === 'intent')) ||
          (executionStarted && recorded.length === 0)
        ) {
          throw new Error('Prior store attempt has a missing release journal receipt')
        }
      }
    }
  }
}

export async function loadReleaseJournal({
  binding,
  repository,
  token,
  currentRun,
  fetchImpl = fetch
}) {
  const expected = validateBinding(binding)
  const current = validateRun(currentRun)
  if (repository !== expected.repository) throw new Error('Release journal repository mismatch')
  if (typeof token !== 'string' || !token || typeof fetchImpl !== 'function') {
    throw new Error('GitHub journal credentials and fetch are required')
  }
  const prefix = `cws-${expected.extensionId}-${expected.version}-`
  const artifacts = []
  for (let page = 1; page <= 20; page++) {
    const data = await githubGet(
      fetchImpl,
      repository,
      token,
      `actions/artifacts?per_page=100&page=${page}`
    )
    if (
      !Number.isSafeInteger(data?.total_count) ||
      data.total_count < 0 ||
      !Array.isArray(data.artifacts) ||
      data.artifacts.length > 100
    ) {
      throw new Error('Invalid release journal artifact inventory')
    }
    artifacts.push(...data.artifacts)
    if (artifacts.length >= data.total_count) break
    if (page === 20 || data.artifacts.length === 0) {
      throw new Error('Release journal artifact inventory is incomplete')
    }
  }
  const selected = artifacts
    .map(artifact => ({ artifact, identity: artifactIdentity(artifact, prefix) }))
    .filter(item => item.identity)
  const workflow = await githubGet(
    fetchImpl,
    repository,
    token,
    'actions/workflows/publish-extension.yml'
  )
  if (
    !Number.isSafeInteger(workflow?.id) ||
    workflow.id <= 0 ||
    !['publish-extension.yml', '.github/workflows/publish-extension.yml'].includes(workflow.path)
  ) {
    throw new Error('Invalid release journal workflow')
  }
  const runs = new Map()
  const entries = []
  for (const { artifact, identity } of selected) {
    const key = `${identity.runId}/${identity.attempt}`
    if (!runs.has(key)) {
      const run = await githubGet(
        fetchImpl,
        repository,
        token,
        `actions/runs/${identity.runId}/attempts/${identity.attempt}`
      )
      if (
        String(run?.id) !== identity.runId ||
        String(run?.run_attempt) !== identity.attempt ||
        run?.workflow_id !== workflow.id ||
        ![
          '.github/workflows/publish-extension.yml',
          '.github/workflows/publish-extension.yml@main'
        ].includes(run?.path) ||
        run?.event !== 'workflow_dispatch' ||
        run?.head_branch !== 'main' ||
        run?.repository?.full_name?.toLowerCase() !== repository.toLowerCase() ||
        !SHA.test(run?.head_sha ?? '')
      ) {
        throw new Error('Release journal artifact has untrusted workflow provenance')
      }
      if (!Number.isFinite(Date.parse(run.run_started_at))) {
        throw new Error('Release journal workflow run has no valid attempt start time')
      }
      runs.set(key, run)
    }
    const run = runs.get(key)
    if (
      String(artifact.workflow_run?.id) !== identity.runId ||
      artifact.workflow_run?.head_sha !== run.head_sha ||
      identity.createdAt < Date.parse(run.run_started_at)
    ) {
      throw new Error('Release journal artifact does not match its workflow run')
    }
    const archive = await githubGet(
      fetchImpl,
      repository,
      token,
      `actions/artifacts/${artifact.id}/zip`,
      true
    )
    if (
      archive.length !== artifact.size_in_bytes ||
      (artifact.digest &&
        `sha256:${createHash('sha256').update(archive).digest('hex')}` !== artifact.digest)
    ) {
      throw new Error('Release journal archive size or digest mismatch')
    }
    let receipt
    try {
      const bytes = readZipEntry(archive, 'receipt.json', { maxBytes: MAX_RECEIPT_BYTES })
      receipt = parseReceipt(JSON.parse(Buffer.from(bytes).toString('utf8')))
    } catch {
      throw new Error('Invalid release journal receipt archive')
    }
    if (
      receiptArtifactName(receipt) !== artifact.name ||
      receipt.run.id !== identity.runId ||
      receipt.run.attempt !== identity.attempt ||
      receipt.run.sha !== run.head_sha ||
      !same(receipt.binding, expected)
    ) {
      throw new Error('Release journal receipt does not match the accepted candidate and CRX')
    }
    entries.push({ ...identity, artifactId: artifact.id, receipt })
  }

  await requireHistoricalReceipts({
    fetchImpl,
    repository,
    token,
    workflowId: workflow.id,
    binding: expected,
    currentRun: current,
    entries
  })

  const restored = { upload: null, submit: null, notify: null }
  for (const stage of STAGES) {
    const records = entries.filter(entry => entry.stage === stage)
    const intents = records.filter(entry => entry.phase === 'intent')
    const results = records.filter(entry => entry.phase === 'result')
    const keys = new Set()
    for (const entry of records) {
      const key = `${entry.phase}/${entry.runId}/${entry.attempt}`
      if (keys.has(key)) throw new Error('Duplicate release journal receipt')
      keys.add(key)
    }
    const attempts = [
      ...intents,
      ...results.filter(
        result =>
          !intents.some(
            intent => intent.runId === result.runId && intent.attempt === result.attempt
          )
      )
    ]
    attempts.sort(
      (a, b) =>
        a.createdAt - b.createdAt ||
        Number(a.runId) - Number(b.runId) ||
        Number(a.attempt) - Number(b.attempt) ||
        a.artifactId - b.artifactId
    )
    const latest = attempts.at(-1)
    if (!latest) continue
    const intent = intents.find(
      entry => entry.runId === latest.runId && entry.attempt === latest.attempt
    )
    const result = results.find(
      entry => entry.runId === latest.runId && entry.attempt === latest.attempt
    )
    if (intent && result && result.createdAt < intent.createdAt) {
      throw new Error('Release journal result predates its intent')
    }
    restored[stage] = result?.receipt.result ?? {
      status: 'unknown',
      retryable: false,
      reason: 'receipt_missing'
    }
  }
  return restored
}
