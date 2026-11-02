import { appendFileSync, readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const shaPattern = /^[0-9a-f]{40}$/
const shared = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.node-version',
  'tsconfig.base.json',
  '.npmrc',
  'scripts/ci-validated-scope.mjs'
])
const scopes = {
  sdk: {
    workflow: 'sdk.yml',
    relevant: path =>
      path.startsWith('packages/sdk/') ||
      shared.has(path) ||
      path === 'scripts/sdk-release.mjs' ||
      path === 'scripts/sdk-package-check.mjs' ||
      path === 'scripts/run-core-tests.mjs' ||
      path === 'scripts/register-test-loader.mjs' ||
      path === 'scripts/typescript-test-loader.mjs' ||
      path === '.github/workflows/sdk.yml' ||
      path === '.github/workflows/publish-sdk.yml'
  },
  docs: {
    workflow: 'docs.yml',
    relevant: path =>
      path.startsWith('packages/docs/') ||
      path.startsWith('packages/sdk/') ||
      shared.has(path) ||
      path === '.github/workflows/docs.yml'
  }
}

export async function needsScopeValidation({ scope, event, runId, repository, request }) {
  const config = scopes[scope]
  if (
    !config ||
    !Number.isSafeInteger(runId) ||
    runId <= 0 ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
  )
    throw new Error('Invalid scope validation identity')
  if (event.action !== 'synchronize') return true
  const pr = event.pull_request
  if (
    !Number.isSafeInteger(pr?.number) ||
    pr.number <= 0 ||
    pr.head?.repo?.full_name?.toLowerCase() !== repository.toLowerCase() ||
    !shaPattern.test(pr.head.sha)
  )
    return true
  const result = await request(
    `actions/workflows/${config.workflow}/runs?event=pull_request&per_page=100`
  )
  if (!Array.isArray(result?.workflow_runs)) return true
  const earlier = result.workflow_runs
    .filter(
      run =>
        run.id !== runId &&
        run.id < runId &&
        run.head_repository?.id === pr.head.repo.id &&
        run.pull_requests?.some(
          other =>
            other.number === pr.number &&
            other.base?.ref === pr.base?.ref &&
            other.base?.sha === pr.base?.sha &&
            shaPattern.test(other.base.sha)
        )
    )
    .sort((a, b) => b.id - a.id)[0]
  if (
    !earlier ||
    earlier.status !== 'completed' ||
    earlier.conclusion !== 'success' ||
    !shaPattern.test(earlier.head_sha)
  )
    return true
  if (earlier.head_sha === pr.head.sha) return false
  const comparison = await request(`compare/${earlier.head_sha}...${pr.head.sha}`)
  if (
    !Array.isArray(comparison?.files) ||
    comparison.files.length >= 300 ||
    !['ahead', 'identical'].includes(comparison.status)
  )
    return true
  return comparison.files.some(
    file =>
      typeof file.filename !== 'string' ||
      config.relevant(file.filename) ||
      (file.previous_filename && config.relevant(file.previous_filename))
  )
}

export function isSdkGateSuccessful({
  verifyResult,
  dryRunResult,
  reused,
  artifactId,
  version,
  sourceSha,
  buildAttempt
}) {
  if (verifyResult !== 'success') return false
  const hasArtifact =
    /^[1-9]\d*$/.test(artifactId ?? '') &&
    /^(?:0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)|2\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-beta\.[1-9]\d*)$/.test(
      version ?? ''
    ) &&
    shaPattern.test(sourceSha ?? '') &&
    /^[1-9]\d*$/.test(buildAttempt ?? '')
  if (reused === 'true')
    return dryRunResult === 'skipped' && !artifactId && !version && !sourceSha && !buildAttempt
  return reused === 'false' && dryRunResult === 'success' && hasArtifact
}

async function githubRequest(repository, token, route) {
  const response = await fetch(`https://api.github.com/repos/${repository}/${route}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28'
    },
    signal: AbortSignal.timeout(30000)
  })
  if (!response.ok) throw new Error(`Scope validation request failed (${response.status})`)
  return response.json()
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'sdk-gate') {
    const env = process.env
    const success = isSdkGateSuccessful({
      verifyResult: env.SDK_VERIFY_RESULT,
      dryRunResult: env.SDK_DRY_RUN_RESULT,
      reused: env.SDK_REUSED,
      artifactId: env.SDK_ARTIFACT_ID,
      version: env.SDK_VERSION,
      sourceSha: env.SDK_SOURCE_SHA,
      buildAttempt: env.SDK_BUILD_ATTEMPT
    })
    if (!success) {
      console.error('SDK validation or explicit reuse did not complete successfully')
      process.exitCode = 1
    }
  } else {
    try {
      const env = process.env
      if (!env.GH_TOKEN) throw new Error('GH_TOKEN is required')
      const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
      const run = await needsScopeValidation({
        scope: process.argv[2],
        event,
        runId: Number(env.GITHUB_RUN_ID),
        repository: env.GITHUB_REPOSITORY,
        request: route => githubRequest(env.GITHUB_REPOSITORY, env.GH_TOKEN, route)
      })
      appendFileSync(env.GITHUB_OUTPUT, `run=${run}\n`)
      console.log(
        run ? 'Run validation' : 'Relevant inputs match the last successful PR validation'
      )
    } catch (error) {
      appendFileSync(process.env.GITHUB_OUTPUT, 'run=true\n')
      console.error(
        error instanceof Error ? error.message : 'Scope check failed; running validation'
      )
    }
  }
}
