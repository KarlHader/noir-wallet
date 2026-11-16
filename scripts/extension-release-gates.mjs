import { appendFileSync, readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sourceProfileForVersion, verifyReleaseArtifact } from './extension-release.mjs'
import { collectReleaseCommits } from './lib/extension-release-history.mjs'

const candidateWorkflow = '.github/workflows/extension-release.yml'
const shaPattern = /^[0-9a-f]{40}$/
const integerPattern = /^[1-9][0-9]*$/
const versionPattern =
  /^(?:2|[3-9]|[1-9][0-9]+)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-beta\.[1-9][0-9]*)?$/

function requireSha(value, name) {
  if (typeof value !== 'string' || !shaPattern.test(value)) {
    throw new Error(`${name} must be a full lowercase commit SHA`)
  }
  return value
}

function requireInteger(value, name) {
  if (typeof value !== 'string' || !integerPattern.test(value)) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function requireBranch(value) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
    value.includes('..') ||
    value.includes('//') ||
    value.endsWith('/') ||
    value.endsWith('.') ||
    value.endsWith('.lock')
  ) {
    throw new Error('Source must be a branch name or a full commit SHA')
  }
  return value
}

export async function resolveReleaseSource({ mode, source, confirmSha, workflowSha, request }) {
  if (!['beta', 'candidate'].includes(mode))
    throw new Error('Release mode must be beta or candidate')
  if (typeof source !== 'string' || !source)
    throw new Error('A source branch or commit SHA is required')
  const isSha = shaPattern.test(source)
  if (!isSha) requireBranch(source)
  if (mode === 'beta' && source !== 'main' && !isSha) {
    throw new Error('Beta source must be main or its current exact commit')
  }
  if (mode === 'candidate' && (isSha || !source.startsWith('release/'))) {
    throw new Error('Production candidates must use a release/X.Y.Z branch')
  }
  if (mode === 'candidate') requireSha(confirmSha, 'Confirmed candidate commit')
  const resolved = await request(
    isSha ? `commits/${source}` : `branches/${encodeURIComponent(source)}`
  )
  const sourceSha = requireSha(isSha ? resolved?.sha : resolved?.commit?.sha, 'Resolved source')
  if (mode === 'beta') {
    requireSha(confirmSha, 'Confirmed Beta commit')
    const main = await request('branches/main')
    const mainSha = requireSha(main?.commit?.sha, 'Current main commit')
    if (
      sourceSha !== confirmSha ||
      sourceSha !== mainSha ||
      (workflowSha && sourceSha !== requireSha(workflowSha, 'Workflow commit'))
    ) {
      throw new Error('Beta source must match the current dispatched main commit')
    }
  }
  const packageFile = await request(`contents/packages/extension/package.json?ref=${sourceSha}`)
  if (packageFile?.encoding !== 'base64' || typeof packageFile.content !== 'string') {
    throw new Error('Source commit has no readable extension package.json')
  }
  const { version } = JSON.parse(Buffer.from(packageFile.content, 'base64').toString('utf8'))
  if (typeof version !== 'string' || !versionPattern.test(version)) {
    throw new Error('Extension version must be V2 or newer')
  }
  if (mode === 'beta' && !version.includes('-beta.')) {
    throw new Error('Beta release requires a 2.x-beta version')
  }
  if (mode === 'candidate' && version.includes('-')) {
    throw new Error('Production candidate requires a stable 2.x version')
  }
  if (mode === 'candidate') {
    if (source !== `release/${version}`)
      throw new Error('Release branch must match the extension version')
    if (sourceSha !== confirmSha)
      throw new Error('Confirmed candidate commit must match the current release branch HEAD')
  }
  return {
    source_sha: sourceSha,
    source_ref: source,
    version,
    mode,
    source_profile: sourceProfileForVersion(version)
  }
}

export function validateCandidateRun(run, { repository, runId, runAttempt, workflowId }) {
  requireInteger(runId, 'Candidate run ID')
  requireInteger(runAttempt, 'Candidate run attempt')
  if (
    String(run?.id) !== runId ||
    String(run?.run_attempt) !== runAttempt ||
    run?.workflow_id !== workflowId ||
    ![candidateWorkflow, `${candidateWorkflow}@main`].includes(run?.path) ||
    run?.event !== 'workflow_dispatch' ||
    run?.head_branch !== 'main' ||
    run?.status !== 'completed' ||
    run?.conclusion !== 'success' ||
    run?.repository?.full_name?.toLowerCase() !== repository.toLowerCase()
  ) {
    throw new Error(
      'Candidate must come from a successful manual release workflow on this repository main branch'
    )
  }
  requireSha(run.head_sha, 'Candidate workflow commit')
}

export function selectCandidateArtifact(artifacts, { runId, runAttempt }) {
  requireInteger(runId, 'Candidate run ID')
  requireInteger(runAttempt, 'Candidate run attempt')
  const pattern = new RegExp(
    `^noir-wallet-v(?:2|[3-9]|[1-9][0-9]+)\\.[0-9]+\\.[0-9]+-rc\\.${runId}\\.${runAttempt}\\.[0-9a-f]{7}$`
  )
  const matches = artifacts.filter(artifact => pattern.test(artifact.name))
  if (
    matches.length !== 1 ||
    matches[0].expired ||
    !Number.isSafeInteger(matches[0].id) ||
    matches[0].id <= 0 ||
    matches[0].size_in_bytes <= 0
  ) {
    throw new Error(
      'Exactly one unexpired production candidate artifact is required; rebuild and accept a new candidate if it expired'
    )
  }
  return matches[0]
}

export async function resolvePromotion({ repository, runId, runAttempt, confirmSha, request }) {
  requireSha(confirmSha, 'Confirmed source commit')
  requireInteger(runId, 'Candidate run ID')
  requireInteger(runAttempt, 'Candidate run attempt')
  const workflow = await request('actions/workflows/extension-release.yml')
  const run = await request(`actions/runs/${runId}/attempts/${runAttempt}`)
  validateCandidateRun(run, { repository, runId, runAttempt, workflowId: workflow?.id })
  const artifacts = []
  for (let page = 1; page <= 20; page++) {
    const result = await request(`actions/runs/${runId}/artifacts?per_page=100&page=${page}`)
    if (!Array.isArray(result?.artifacts)) throw new Error('Invalid candidate artifact response')
    artifacts.push(...result.artifacts)
    if (artifacts.length >= result.total_count) break
    if (page === 20) throw new Error('Candidate artifact inventory exceeds the supported limit')
  }
  const artifact = selectCandidateArtifact(artifacts, { runId, runAttempt })
  return {
    artifact_id: String(artifact.id),
    workflow_sha: run.head_sha,
    run_id: runId,
    run_attempt: runAttempt,
    source_sha: confirmSha
  }
}

export async function validateCurrentCandidate(metadata, request) {
  if (
    sourceProfileForVersion(metadata.version) !== 'multichain' ||
    metadata.mode !== 'candidate' ||
    metadata.buildChannel !== 'production' ||
    metadata.sourceRef !== `release/${metadata.version}`
  ) {
    throw new Error('Only a production candidate from its matching release branch can be promoted')
  }
  const branch = await request(`branches/${encodeURIComponent(metadata.sourceRef)}`)
  if (branch?.commit?.sha !== metadata.sourceSha) {
    throw new Error(
      'Release branch advanced after this candidate was built; build and accept the new commit'
    )
  }
}

export async function validatePublicationTarget(metadata, directory, request) {
  const tag = `v${metadata.version}`
  const existingTag = await request(`git/ref/tags/${tag}`, { allowNotFound: true })
  if (existingTag) {
    let object = existingTag.object
    for (let depth = 0; object?.type === 'tag' && depth < 5; depth++) {
      const annotated = await request(`git/tags/${requireSha(object.sha, 'Tag object')}`)
      object = annotated.object
    }
    if (object?.type !== 'commit' || object.sha !== metadata.sourceSha) {
      throw new Error(
        'Existing production tag points to a different source commit; published tags must never move'
      )
    }
  }
  const release = await request(`releases/tags/${tag}`, { allowNotFound: true })
  if (!release) return false
  const checksumDigest = createHash('sha256')
    .update(readFileSync(path.join(directory, 'SHA256SUMS')))
    .digest('hex')
  const expected = [
    ...metadata.assets.map(asset => [asset.name, asset.sha256]),
    ['SHA256SUMS', checksumDigest]
  ]
  if (
    !existingTag ||
    release.draft ||
    release.prerelease ||
    release.assets?.length !== expected.length ||
    !expected.every(([name, digest]) =>
      release.assets.some(asset => asset.name === name && asset.digest === `sha256:${digest}`)
    )
  ) {
    throw new Error(
      'Existing Release does not match the accepted candidate; publication will not overwrite it'
    )
  }
  return true
}

function githubRequest(repository, token) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || ''))
    throw new Error('Invalid repository')
  if (!token) throw new Error('A GitHub token is required for release validation')
  return async (route, { allowNotFound = false } = {}) => {
    const response = await fetch(`https://api.github.com/repos/${repository}/${route}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28'
      },
      signal: AbortSignal.timeout(30000)
    })
    if (allowNotFound && response.status === 404) return null
    if (!response.ok)
      throw new Error(`GitHub release validation failed (${response.status}) for ${route}`)
    return response.json()
  }
}

function writeOutputs(values) {
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required')
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'string' || /[\r\n]/.test(value))
      throw new Error('Invalid workflow output')
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
  }
}

function isCliEntry() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

const isCli = isCliEntry()
if (isCli) {
  try {
    const env = process.env
    if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main') {
      throw new Error(
        'Release workflows must be manually run from main; select the wallet source with the workflow input'
      )
    }
    const request = githubRequest(env.GITHUB_REPOSITORY, env.GH_TOKEN)
    const [command, directory] = process.argv.slice(2)
    if (command === 'resolve') {
      const source = await resolveReleaseSource({
        mode: env.RELEASE_MODE,
        source: env.SOURCE_INPUT,
        confirmSha: env.CONFIRM_SHA,
        workflowSha: env.GITHUB_SHA,
        request
      })
      writeOutputs({
        ...source,
        commits_json: JSON.stringify(
          await collectReleaseCommits({ sourceSha: source.source_sha, request })
        )
      })
    } else if (command === 'promotion') {
      writeOutputs(
        await resolvePromotion({
          repository: env.GITHUB_REPOSITORY,
          runId: env.CANDIDATE_RUN_ID,
          runAttempt: env.CANDIDATE_RUN_ATTEMPT,
          confirmSha: env.CONFIRM_SHA,
          request
        })
      )
    } else if (command === 'publication') {
      if (!directory) throw new Error('Candidate artifact directory is required')
      const metadata = verifyReleaseArtifact(directory, {
        mode: 'candidate',
        repository: env.GITHUB_REPOSITORY,
        runId: env.CANDIDATE_RUN_ID,
        runAttempt: env.CANDIDATE_RUN_ATTEMPT,
        workflowSha: env.CANDIDATE_WORKFLOW_SHA,
        sourceSha: requireSha(env.CONFIRM_SHA, 'Confirmed source commit')
      })
      await validateCurrentCandidate(metadata, request)
      const outputs = {
        version: metadata.version,
        source_sha: metadata.sourceSha,
        source_ref: metadata.sourceRef,
        tag: `v${metadata.version}`
      }
      outputs.already_published = String(
        await validatePublicationTarget(metadata, directory, request)
      )
      writeOutputs(outputs)
      if (env.GITHUB_STEP_SUMMARY) {
        appendFileSync(
          env.GITHUB_STEP_SUMMARY,
          `## Production candidate\n\nSource: \`${metadata.sourceRef}\` at \`${metadata.sourceSha}\`\n\nBuild: ${metadata.runId}, attempt ${metadata.runAttempt}\n\n` +
            metadata.assets.map(asset => `- ${asset.name}: \`${asset.sha256}\``).join('\n') +
            '\n'
        )
      }
    } else {
      throw new Error('Expected resolve, promotion, or publication command')
    }
  } catch (error) {
    process.stderr.write(
      `Release validation failed: ${error instanceof Error ? error.message : 'Unknown error'}\n`
    )
    process.exitCode = 1
  }
}
