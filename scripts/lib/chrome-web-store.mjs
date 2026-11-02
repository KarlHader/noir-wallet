const ORIGIN = 'https://chromewebstore.googleapis.com'
const ID = /^[A-Za-z0-9_-]+$/
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?$/
const MAX_RESPONSE_BYTES = 1024 * 1024
const REQUEST_TIMEOUT_MS = 15000
const UPLOAD_TIMEOUT_MS = 600000
const GET_ATTEMPTS = 3
const ACTIVE_STATES = new Set(['PENDING_REVIEW', 'STAGED'])
const ITEM_STATES = new Set([
  'PENDING_REVIEW',
  'STAGED',
  'PUBLISHED',
  'PUBLISHED_TO_TESTERS',
  'REJECTED',
  'CANCELLED'
])
const UPLOAD_STATES = new Set(['IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'NOT_FOUND'])

function validString(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Invalid ${label}`)
  return value
}

function versions(revision) {
  if (revision === undefined) return []
  if (
    !revision ||
    typeof revision !== 'object' ||
    Array.isArray(revision) ||
    !Array.isArray(revision.distributionChannels)
  )
    return null
  const values = revision.distributionChannels.map(channel => channel?.crxVersion)
  return values.every(value => typeof value === 'string' && VERSION.test(value))
    ? [...new Set(values)]
    : null
}

function normalizeStatus(body, name, itemId) {
  if (body?.name !== name || body.itemId !== itemId) return null
  const publishedVersions = versions(body.publishedItemRevisionStatus)
  const submittedVersions = versions(body.submittedItemRevisionStatus)
  if (!publishedVersions || !submittedVersions) return null
  const submittedState = body.submittedItemRevisionStatus?.state ?? null
  const publishedState = body.publishedItemRevisionStatus?.state ?? null
  if (
    (submittedState !== null && !ITEM_STATES.has(submittedState)) ||
    (publishedState !== null && !ITEM_STATES.has(publishedState)) ||
    (body.lastAsyncUploadState !== undefined && !UPLOAD_STATES.has(body.lastAsyncUploadState))
  )
    return null
  return {
    publishedVersions,
    submittedVersions,
    publishedState,
    submittedState,
    lastAsyncUploadState: body.lastAsyncUploadState ?? null,
    takenDown: body.takenDown === true,
    warned: body.warned === true
  }
}

function normalizeMutation(body, name, itemId, kind) {
  if (body?.name !== name || body.itemId !== itemId) return null
  if (kind === 'upload') {
    if (
      !UPLOAD_STATES.has(body.uploadState) ||
      (body.crxVersion !== undefined &&
        body.crxVersion !== null &&
        (typeof body.crxVersion !== 'string' || !VERSION.test(body.crxVersion)))
    )
      return null
    return {
      uploadState: body.uploadState,
      crxVersion: typeof body.crxVersion === 'string' ? body.crxVersion : null
    }
  }
  return ITEM_STATES.has(body.state) ? { state: body.state } : null
}

export function createChromeWebStoreClient({
  publisherId,
  extensionId,
  accessToken,
  fetchImpl = globalThis.fetch,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  pollAttempts = 4,
  pollIntervalMs = 1500
}) {
  validString(publisherId, ID, 'publisher ID')
  validString(extensionId, ID, 'extension ID')
  if (typeof accessToken !== 'string' || !accessToken || /[\r\n]/.test(accessToken)) {
    throw new Error('Invalid access token')
  }
  if (typeof fetchImpl !== 'function' || typeof wait !== 'function') {
    throw new Error('Invalid CWS transport')
  }
  if (
    !Number.isInteger(pollAttempts) ||
    pollAttempts < 1 ||
    pollAttempts > 20 ||
    !Number.isInteger(pollIntervalMs) ||
    pollIntervalMs < 0 ||
    pollIntervalMs > 60000
  ) {
    throw new Error('Invalid CWS polling options')
  }

  const name = `publishers/${publisherId}/items/${extensionId}`
  const base = `${ORIGIN}/v2/${name}`
  const uploadUrl = `${ORIGIN}/upload/v2/${name}:upload`

  async function request(method, url, body, headers = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const attempts = method === 'GET' ? GET_ATTEMPTS : 1
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetchImpl(url, {
          method,
          headers: { Authorization: `Bearer ${accessToken}`, ...headers },
          ...(body === undefined ? {} : { body }),
          signal: controller.signal,
          redirect: 'error'
        })
        const httpStatus = response.status
        if (!response.ok) {
          if (method === 'GET' && attempt < attempts && (httpStatus === 429 || httpStatus >= 500)) {
            await wait(200 * attempt)
            continue
          }
          return { ok: false, httpStatus, error: 'http_error' }
        }
        const raw = await response.text()
        if (raw.length > MAX_RESPONSE_BYTES)
          return { ok: false, httpStatus, error: 'invalid_response' }
        try {
          return { ok: true, httpStatus, body: JSON.parse(raw) }
        } catch {
          return { ok: false, httpStatus, error: 'invalid_response' }
        }
      } catch {
        if (method === 'GET' && attempt < attempts) {
          await wait(200 * attempt)
          continue
        }
        return { ok: false, error: 'network_error' }
      } finally {
        clearTimeout(timeout)
      }
    }
  }

  async function fetchStatus() {
    const result = await request('GET', `${base}:fetchStatus`)
    if (!result.ok) return result
    const status = normalizeStatus(result.body, name, extensionId)
    return status
      ? { ok: true, httpStatus: result.httpStatus, ...status }
      : { ok: false, httpStatus: result.httpStatus, error: 'invalid_response' }
  }

  async function upload(crxBytes, filename) {
    if (
      !(crxBytes instanceof Uint8Array) ||
      crxBytes.byteLength === 0 ||
      typeof filename !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*\.crx$/.test(filename)
    ) {
      return { ok: false, error: 'invalid_input' }
    }
    const result = await request(
      'POST',
      uploadUrl,
      crxBytes,
      {
        'Content-Type': 'application/x-chrome-extension',
        'X-Goog-Upload-Protocol': 'raw',
        'X-Goog-Upload-File-Name': filename
      },
      UPLOAD_TIMEOUT_MS
    )
    if (!result.ok) return result
    const uploadResult = normalizeMutation(result.body, name, extensionId, 'upload')
    return uploadResult
      ? { ok: true, httpStatus: result.httpStatus, ...uploadResult }
      : { ok: false, httpStatus: result.httpStatus, error: 'invalid_response' }
  }

  async function publish() {
    const result = await request(
      'POST',
      `${base}:publish`,
      JSON.stringify({
        publishType: 'STAGED_PUBLISH',
        skipReview: false,
        blockOnWarnings: true
      }),
      { 'Content-Type': 'application/json' }
    )
    if (!result.ok) return result
    const submission = normalizeMutation(result.body, name, extensionId, 'publish')
    return submission
      ? { ok: true, httpStatus: result.httpStatus, ...submission }
      : { ok: false, httpStatus: result.httpStatus, error: 'invalid_response' }
  }

  return { fetchStatus, upload, publish, wait, pollAttempts, pollIntervalMs }
}

function result(status, version, extra = {}) {
  return {
    status,
    retryable: status === 'failed',
    version,
    ...Object.fromEntries(Object.entries(extra).filter(([, value]) => value !== undefined))
  }
}

function submittedVersion(status, version) {
  return status.submittedVersions.length === 1 && status.submittedVersions[0] === version
}

function activeSubmission(status) {
  return ACTIVE_STATES.has(status.submittedState)
}

function submissionOutcome(status, version, previousSubmission) {
  if (activeSubmission(status)) {
    if (
      ['intent', 'unknown', 'succeeded'].includes(previousSubmission?.status) &&
      submittedVersion(status, version)
    ) {
      return result('succeeded', version, { state: status.submittedState, retryable: false })
    }
    return result('blocked', version, { state: status.submittedState, retryable: false })
  }
  if (
    status.submittedState === 'PUBLISHED' ||
    status.submittedState === 'PUBLISHED_TO_TESTERS' ||
    status.submittedState === 'REJECTED' ||
    status.submittedState === 'CANCELLED'
  ) {
    if (status.submittedVersions.length > 0 && !status.submittedVersions.includes(version))
      return null
    return result('blocked', version, { state: status.submittedState, retryable: false })
  }
  return null
}

export async function uploadPackage({
  client,
  version,
  crxBytes,
  filename,
  previousUpload,
  previousSubmission
}) {
  validString(version, VERSION, 'version')
  const mayStartAttempt =
    !previousUpload || (previousUpload.status === 'failed' && previousUpload.retryable === true)
  const preflight = await client.fetchStatus()
  if (!preflight.ok) {
    return result(mayStartAttempt ? 'failed' : 'unknown', version, {
      retryable: mayStartAttempt,
      httpStatus: preflight.httpStatus
    })
  }
  if (preflight.takenDown || preflight.warned) {
    return result('blocked', version, { retryable: false, state: 'STORE_RESTRICTION' })
  }
  const existingSubmission = submissionOutcome(preflight, version, previousSubmission)
  if (existingSubmission) {
    if (existingSubmission.status === 'succeeded' && previousUpload?.status === 'succeeded') {
      return result('succeeded', version, {
        retryable: false,
        state: 'SUCCEEDED',
        ...(previousUpload.uploadState ? { uploadState: previousUpload.uploadState } : {})
      })
    }
    return existingSubmission
  }
  if (preflight.publishedVersions.includes(version)) {
    return result('blocked', version, { retryable: false, state: 'PUBLISHED' })
  }
  if (previousUpload?.status === 'succeeded' && previousUpload.version === version) {
    return result('succeeded', version, {
      retryable: false,
      state: 'SUCCEEDED',
      ...(previousUpload.uploadState ? { uploadState: previousUpload.uploadState } : {})
    })
  }
  if (!mayStartAttempt) {
    return result('unknown', version, { retryable: false, state: 'UNCONFIRMED' })
  }
  if (
    preflight.lastAsyncUploadState &&
    !['NOT_FOUND', 'FAILED'].includes(preflight.lastAsyncUploadState)
  ) {
    return result('blocked', version, { retryable: false, state: 'UNATTRIBUTED_UPLOAD' })
  }

  const response = await client.upload(crxBytes, filename)
  if (!response.ok) {
    const definitelyRejected =
      response.error === 'http_error' && response.httpStatus < 500 && response.httpStatus !== 429
    if (!definitelyRejected) await client.fetchStatus()
    return result(definitelyRejected ? 'failed' : 'unknown', version, {
      retryable: definitelyRejected,
      httpStatus: response.httpStatus
    })
  }
  if (response.uploadState === 'SUCCEEDED') {
    return response.crxVersion === version
      ? result('succeeded', version, {
          retryable: false,
          state: 'SUCCEEDED',
          uploadState: 'SUCCEEDED',
          httpStatus: response.httpStatus
        })
      : result('failed', version, {
          retryable: false,
          state: 'VERSION_MISMATCH',
          httpStatus: response.httpStatus
        })
  }
  if (response.uploadState === 'FAILED') {
    return result('failed', version, {
      retryable: true,
      state: 'FAILED',
      httpStatus: response.httpStatus
    })
  }
  if (response.uploadState !== 'IN_PROGRESS') {
    return result('unknown', version, {
      retryable: false,
      state: response.uploadState,
      httpStatus: response.httpStatus
    })
  }
  if (response.crxVersion && response.crxVersion !== version) {
    return result('failed', version, {
      retryable: false,
      state: 'VERSION_MISMATCH',
      httpStatus: response.httpStatus
    })
  }

  for (let attempt = 0; attempt < client.pollAttempts; attempt++) {
    await client.wait(client.pollIntervalMs)
    const polled = await client.fetchStatus()
    if (!polled.ok) continue
    if (
      polled.takenDown ||
      polled.warned ||
      submissionOutcome(polled, version, previousSubmission)
    ) {
      return result('blocked', version, { retryable: false, state: 'STORE_CHANGED' })
    }
    if (polled.lastAsyncUploadState === 'SUCCEEDED') {
      return result('succeeded', version, {
        retryable: false,
        state: 'SUCCEEDED',
        uploadState: 'IN_PROGRESS'
      })
    }
    if (polled.lastAsyncUploadState === 'FAILED') {
      return result('failed', version, { retryable: false, state: 'FAILED' })
    }
    if (polled.lastAsyncUploadState === 'NOT_FOUND') break
  }
  return result('unknown', version, { retryable: false, state: 'IN_PROGRESS' })
}

export async function submitPackage({ client, version, uploadReceipt, previousSubmission }) {
  validString(version, VERSION, 'version')
  if (uploadReceipt?.status !== 'succeeded' || uploadReceipt.version !== version) {
    return result('blocked', version, { retryable: false, state: 'UPLOAD_UNVERIFIED' })
  }
  const mayStartAttempt =
    !previousSubmission ||
    (previousSubmission.status === 'failed' && previousSubmission.retryable === true)
  const preflight = await client.fetchStatus()
  if (!preflight.ok) {
    return result(mayStartAttempt ? 'failed' : 'unknown', version, {
      retryable: mayStartAttempt,
      httpStatus: preflight.httpStatus
    })
  }
  if (preflight.takenDown || preflight.warned) {
    return result('blocked', version, { retryable: false, state: 'STORE_RESTRICTION' })
  }
  const existingSubmission = submissionOutcome(preflight, version, previousSubmission)
  if (existingSubmission) return existingSubmission
  if (
    preflight.lastAsyncUploadState &&
    !['NOT_FOUND', 'FAILED'].includes(preflight.lastAsyncUploadState) &&
    !(preflight.lastAsyncUploadState === 'SUCCEEDED' && uploadReceipt.uploadState === 'IN_PROGRESS')
  ) {
    return result('blocked', version, { retryable: false, state: 'UNATTRIBUTED_UPLOAD' })
  }
  if (preflight.publishedVersions.includes(version)) {
    return result('blocked', version, { retryable: false, state: 'PUBLISHED' })
  }
  if (!mayStartAttempt) {
    return result('unknown', version, { retryable: false, state: 'UNCONFIRMED' })
  }

  const response = await client.publish()
  for (let attempt = 0; attempt < client.pollAttempts; attempt++) {
    if (attempt > 0) await client.wait(client.pollIntervalMs)
    const status = await client.fetchStatus()
    if (!status.ok) continue
    const outcome = submissionOutcome(status, version, { status: 'intent' })
    if (outcome) return outcome
  }
  if (
    !response.ok &&
    response.error === 'http_error' &&
    response.httpStatus < 500 &&
    response.httpStatus !== 429
  ) {
    return result('failed', version, { retryable: true, httpStatus: response.httpStatus })
  }
  return result('unknown', version, {
    retryable: false,
    httpStatus: response.httpStatus,
    state: response.ok ? response.state : 'UNCONFIRMED'
  })
}
