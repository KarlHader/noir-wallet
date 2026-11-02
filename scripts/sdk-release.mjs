import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SDK_PACKAGE = '@noir-wallet/sdk'
export const SDK_REPOSITORY = 'NoirWallet/noir-wallet'
export const SDK_WORKFLOW = '.github/workflows/publish-sdk.yml'
export const SDK_METADATA = 'sdk-release-metadata.json'
export const SDK_NPM_VERSION = '11.21.1'
const REGISTRY = 'https://registry.npmjs.org'
const PACKAGE_URL = `${REGISTRY}/@noir-wallet%2Fsdk`
const SHA = /^[a-f0-9]{40}$/
const STABLE_VERSION = /^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const BETA_VERSION = /^2\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.([1-9]\d*)$/
const root = fileURLToPath(new URL('../', import.meta.url))

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function supportedVersion(value) {
  assert(
    typeof value === 'string' &&
      (STABLE_VERSION.test(value) || BETA_VERSION.test(value)) &&
      value.length < 64,
    'Only stable 0.x.y and 2.x.y-beta.N SDK versions are supported'
  )
  return value
}

function releaseIdentity(version) {
  supportedVersion(version)
  return STABLE_VERSION.test(version)
    ? { releaseLine: 'stable', sourceBranch: 'main', distTag: 'latest' }
    : { releaseLine: 'beta', sourceBranch: 'v2', distTag: 'beta' }
}

function positiveInteger(value, label) {
  assert(
    /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value)),
    `${label} must be a positive safe integer`
  )
  return String(value)
}

export function compareVersions(left, right) {
  const line = releaseIdentity(left).releaseLine
  assert(releaseIdentity(right).releaseLine === line, 'SDK versions must share a release line')
  const parts = value => value.replace('-beta.', '.').split('.').map(BigInt)
  const a = parts(left)
  const b = parts(right)
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1
  return 0
}

export function validateSdkManifest(manifest) {
  assert(manifest?.name === SDK_PACKAGE, 'Unexpected SDK package name')
  supportedVersion(manifest.version)
  assert(
    manifest.private === false && manifest.publishConfig?.access === 'public',
    'SDK must explicitly allow public publication'
  )
  assert(
    manifest.repository?.url === `https://github.com/${SDK_REPOSITORY}.git` &&
      manifest.repository.directory === 'packages/sdk',
    'SDK repository does not match the trusted publisher'
  )
  for (const [key, value] of Object.entries(manifest.publishConfig)) {
    assert(
      ['access', 'registry', 'tag', 'provenance'].includes(key),
      `Unsupported SDK publishConfig setting: ${key}`
    )
    if (key === 'registry') assert(value.replace(/\/$/, '') === REGISTRY, 'Unexpected npm registry')
    if (key === 'tag')
      assert(value === releaseIdentity(manifest.version).distTag, 'Unexpected SDK dist-tag')
    if (key === 'provenance') assert(value === true, 'SDK provenance cannot be disabled')
  }
  for (const entry of ['.', './chains/zcash']) {
    const target = manifest.exports?.[entry]
    assert(
      ['types', 'import', 'require'].every(
        key =>
          typeof target?.[key] === 'string' &&
          /^\.\/dist\/[A-Za-z0-9_./-]+$/.test(target[key]) &&
          !target[key].split('/').includes('..')
      ),
      `Missing or unsafe public SDK export: ${entry}`
    )
  }
  return manifest
}

function trustedInvocation(env) {
  assert(
    env.GITHUB_REPOSITORY === SDK_REPOSITORY && env.GITHUB_REF === 'refs/heads/main',
    'SDK publication is restricted to the canonical repository main branch'
  )
  assert(env.GITHUB_EVENT_NAME === 'workflow_dispatch', 'Unsupported SDK release event')
  assert(SHA.test(env.GITHUB_SHA ?? ''), 'A full source SHA is required')
  assert(
    env.GITHUB_WORKFLOW_REF === `${SDK_REPOSITORY}/${SDK_WORKFLOW}@refs/heads/main`,
    'Unexpected SDK release workflow identity'
  )
}

export function resolveSdkRelease({ env, manifest, branchHeadSha }) {
  trustedInvocation(env)
  const operation = env.OPERATION
  assert(['stage', 'verify'].includes(operation), 'Choose stage or verify')
  if (operation === 'verify') return { operation, should_stage: 'false' }
  const releaseLine = env.RELEASE_LINE || 'stable'
  assert(['stable', 'beta'].includes(releaseLine), 'Choose stable or beta release line')
  const sourceBranch = releaseLine === 'stable' ? 'main' : 'v2'
  assert(SHA.test(branchHeadSha ?? ''), 'Selected branch has no valid head commit')
  assert(
    env.CONFIRM_SHA === branchHeadSha,
    'Confirmed source SHA must match the selected branch head'
  )
  validateSdkManifest(manifest)
  assert(
    env.CONFIRM_VERSION === manifest.version,
    'Confirmed SDK version does not match the source'
  )
  assert(
    releaseIdentity(manifest.version).releaseLine === releaseLine,
    'SDK version does not match release line'
  )
  return {
    operation,
    should_stage: 'true',
    version: manifest.version,
    source_sha: branchHeadSha,
    source_branch: sourceBranch,
    release_line: releaseLine,
    dist_tag: releaseIdentity(manifest.version).distTag,
    workflow_sha: env.GITHUB_SHA
  }
}

function readJson(filename) {
  return JSON.parse(readFileSync(filename, 'utf8'))
}

function hash(bytes, algorithm, encoding = 'hex') {
  return createHash(algorithm).update(bytes).digest(encoding)
}

function tarballManifest(filename) {
  return JSON.parse(
    execFileSync('tar', ['-xzOf', filename, 'package/package.json'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  )
}

function artifactName(metadata) {
  const prefix = metadata.mode === 'check' ? 'noir-sdk-check' : 'noir-sdk'
  return `${prefix}-${metadata.version}-${metadata.runId}-${metadata.runAttempt}`
}

export function packageSdkRelease(directory, env, { sourceRoot = root, run = execFileSync } = {}) {
  trustedInvocation(env)
  assert(SHA.test(env.SDK_SOURCE_SHA ?? ''), 'A pinned SDK source SHA is required')
  return packageSdkArtifact(directory, env, 'release', { sourceRoot, run })
}

export function packageSdkCheck(directory, env, { sourceRoot = root, run = execFileSync } = {}) {
  assert(SHA.test(env.GITHUB_SHA ?? ''), 'A full checked source SHA is required')
  return packageSdkArtifact(directory, env, 'check', { sourceRoot, run })
}

function packageSdkArtifact(directory, env, mode, { sourceRoot, run }) {
  const manifest = validateSdkManifest(readJson(path.join(sourceRoot, 'packages/sdk/package.json')))
  const sourceSha = mode === 'release' ? env.SDK_SOURCE_SHA : env.GITHUB_SHA
  const identity = releaseIdentity(manifest.version)
  if (mode === 'release') {
    assert(
      env.SDK_SOURCE_BRANCH === identity.sourceBranch &&
        env.SDK_RELEASE_LINE === identity.releaseLine &&
        env.SDK_DIST_TAG === identity.distTag,
      'Pinned SDK source identity does not match its version'
    )
  }
  assert(
    run('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() === sourceSha,
    'SDK checkout does not match the release commit'
  )
  const output = path.resolve(directory)
  mkdirSync(output, { recursive: true })
  assert(readdirSync(output).length === 0, 'SDK artifact directory must be empty')
  const result = JSON.parse(
    run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', output], {
      cwd: path.join(sourceRoot, 'packages/sdk'),
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024
    })
  )
  const filename = `noir-wallet-sdk-${manifest.version}.tgz`
  assert(result.length === 1 && result[0].filename === filename, 'Unexpected npm pack output')
  const bytes = readFileSync(path.join(output, filename))
  const integrity = `sha512-${hash(bytes, 'sha512', 'base64')}`
  assert(result[0].integrity === integrity, 'npm pack integrity mismatch')
  const metadata = {
    schemaVersion: 2,
    mode,
    packageName: SDK_PACKAGE,
    version: manifest.version,
    repository: SDK_REPOSITORY,
    sourceSha,
    workflowSha: env.GITHUB_SHA,
    sourceBranch: mode === 'release' ? identity.sourceBranch : null,
    releaseLine: mode === 'release' ? identity.releaseLine : null,
    distTag: mode === 'release' ? identity.distTag : null,
    runId: positiveInteger(env.GITHUB_RUN_ID, 'Run ID'),
    runAttempt: positiveInteger(env.GITHUB_RUN_ATTEMPT, 'Run attempt'),
    tarball: filename,
    size: bytes.length,
    sha256: hash(bytes, 'sha256'),
    integrity
  }
  writeFileSync(path.join(output, SDK_METADATA), `${JSON.stringify(metadata, null, 2)}\n`)
  validateSdkArtifact(output, {
    sourceSha,
    workflowSha: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    version: manifest.version
  })
  return metadata
}

export function validateSdkArtifact(directory, expected = {}) {
  const output = path.resolve(directory)
  const metadataPath = path.join(output, SDK_METADATA)
  assert(
    lstatSync(metadataPath).isFile() && !lstatSync(metadataPath).isSymbolicLink(),
    'SDK metadata must be a regular file'
  )
  const metadata = readJson(metadataPath)
  assert(
    metadata.schemaVersion === 2 &&
      ['check', 'release'].includes(metadata.mode) &&
      metadata.packageName === SDK_PACKAGE &&
      metadata.repository === SDK_REPOSITORY,
    'Unexpected SDK release metadata identity'
  )
  supportedVersion(metadata.version)
  assert(
    SHA.test(metadata.sourceSha) && SHA.test(metadata.workflowSha),
    'Invalid SDK source or workflow SHA'
  )
  const identity = releaseIdentity(metadata.version)
  assert(
    metadata.mode === 'release'
      ? metadata.sourceBranch === identity.sourceBranch &&
          metadata.releaseLine === identity.releaseLine &&
          metadata.distTag === identity.distTag
      : metadata.sourceBranch === null &&
          metadata.releaseLine === null &&
          metadata.distTag === null &&
          metadata.sourceSha === metadata.workflowSha,
    'SDK artifact release identity does not match its version'
  )
  positiveInteger(metadata.runId, 'Artifact run ID')
  positiveInteger(metadata.runAttempt, 'Artifact run attempt')
  assert(
    metadata.tarball === `noir-wallet-sdk-${metadata.version}.tgz`,
    'Unexpected SDK tarball filename'
  )
  for (const [key, value] of Object.entries(expected)) {
    if (value !== undefined && value !== '')
      assert(
        String(metadata[key]) === String(value),
        `SDK artifact ${key} does not match the expected build`
      )
  }
  const files = readdirSync(output).sort()
  assert(
    JSON.stringify(files) === JSON.stringify([SDK_METADATA, metadata.tarball].sort()),
    'SDK artifact must contain exactly one tarball and its metadata'
  )
  const filename = path.join(output, metadata.tarball)
  const stat = lstatSync(filename)
  assert(
    stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 50 * 1024 * 1024,
    'SDK tarball must be a regular file within the supported size limit'
  )
  const bytes = readFileSync(filename)
  assert(
    bytes.length === metadata.size &&
      hash(bytes, 'sha256') === metadata.sha256 &&
      `sha512-${hash(bytes, 'sha512', 'base64')}` === metadata.integrity,
    'SDK tarball checksum mismatch'
  )
  const manifest = validateSdkManifest(tarballManifest(filename))
  assert(manifest.version === metadata.version, 'SDK tarball version does not match metadata')
  return metadata
}

async function requestJson(url, { token, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, {
    headers: token
      ? {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28'
        }
      : { Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
    redirect: 'error'
  })
  assert(response.ok, `Release metadata request failed (${response.status})`)
  return response.json()
}

export function validateRegistryTarget(packument, version) {
  const { distTag } = releaseIdentity(version)
  assert(
    packument?.name === SDK_PACKAGE && packument.versions && packument['dist-tags'],
    'Invalid SDK registry response'
  )
  assert(
    !Object.hasOwn(packument.versions, version),
    'SDK version is already published; it cannot be overwritten'
  )
  if (distTag === 'beta') {
    assert(
      STABLE_VERSION.test(packument['dist-tags'].latest ?? ''),
      'npm latest must remain on the V1 stable line'
    )
  }
  const latest = packument['dist-tags'][distTag]
  assert(
    (latest === undefined && distTag === 'beta') ||
      (typeof latest === 'string' && compareVersions(version, latest) > 0),
    `SDK publication would not advance ${distTag}`
  )
}

function verificationCommand(metadata) {
  return (
    `gh workflow run publish-sdk.yml --repo ${SDK_REPOSITORY} --ref main ` +
    `-f operation=verify -f candidate_run_id=${metadata.runId} ` +
    `-f candidate_run_attempt=${metadata.runAttempt}`
  )
}

function verificationInstruction(metadata) {
  return `After npm approval, verify the original build:\n\n\`\`\`sh\n${verificationCommand(metadata)}\n\`\`\`\n`
}

function unconfirmedStageSummary(metadata) {
  return (
    `## SDK staging result unconfirmed\n\n${describe(metadata)}\n${verificationInstruction(metadata)}\n` +
    'Check npm Staged Packages and the public package version before another upload:\n\n' +
    '- No staged version and no public version: rerun the failed upload job with the original artifact.\n' +
    `- Staged version exists: confirm package, version, and ${metadata.distTag} tag; compare its downloaded tarball SHA-256 with the artifact above, complete real-extension acceptance, then approve with 2FA and verify.\n` +
    '- Public version exists: run the verification command above.\n' +
    '- Status unknown or contents conflict: stop and investigate.\n'
  )
}

export async function stageSdkRelease(
  directory,
  expected,
  env,
  { fetchImpl = fetch, run = execFileSync } = {}
) {
  trustedInvocation(env)
  assert(
    env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    'GitHub OIDC is required; npm token authentication is not supported'
  )
  const metadata = validateSdkArtifact(directory, { ...expected, mode: 'release' })
  assert(
    metadata.workflowSha === env.GITHUB_SHA && metadata.runId === env.GITHUB_RUN_ID,
    'SDK upload must use a build from this trusted workflow run'
  )
  const registry = await requestJson(PACKAGE_URL, { fetchImpl })
  validateRegistryTarget(registry, metadata.version)
  assert(
    run('npm', ['--version'], { encoding: 'utf8' }).trim() === SDK_NPM_VERSION,
    `SDK staging requires npm ${SDK_NPM_VERSION}`
  )
  const scratch = mkdtempSync(path.join(tmpdir(), 'noir-sdk-stage-'))
  try {
    writeFileSync(path.join(scratch, '.npmrc'), '')
    const uploadEnv = Object.fromEntries(
      Object.entries(env).filter(
        ([key]) =>
          !/^(NPM_TOKEN|NODE_AUTH_TOKEN|YARN_NPM_AUTH_TOKEN)$/i.test(key) &&
          !/^npm_config_/i.test(key)
      )
    )
    let contents
    try {
      const result = run(
        'npm',
        [
          'stage',
          'publish',
          path.resolve(directory, metadata.tarball),
          '--access=public',
          `--tag=${metadata.distTag}`,
          `--registry=${REGISTRY}`,
          '--ignore-scripts',
          '--provenance',
          '--json',
          `--userconfig=${path.join(scratch, '.npmrc')}`,
          '--workspaces=false'
        ],
        {
          cwd: scratch,
          env: uploadEnv,
          encoding: 'utf8',
          maxBuffer: 4 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 180000
        }
      )
      const output = JSON.parse(result)
      contents = output.stageId ? output : output[SDK_PACKAGE]
      assert(
        typeof contents?.stageId === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(contents.stageId),
        'npm reported success without a valid stageId'
      )
      assert(
        contents.name === SDK_PACKAGE &&
          contents.version === metadata.version &&
          contents.integrity === metadata.integrity,
        'npm stage receipt does not match the accepted tarball'
      )
    } catch (error) {
      summary(env, unconfirmedStageSummary(metadata))
      throw new Error(`SDK staging result unconfirmed: ${error.message}`, { cause: error })
    }
    summary(
      env,
      `## SDK staged; approval pending\n\n${describe(metadata)}\nStage ID: \`${contents.stageId}\`\n\n` +
        'Open Staged Packages in your [npm account](https://www.npmjs.com/), ' +
        'complete real-extension acceptance using this artifact, then approve with 2FA. ' +
        `The package is not publicly released yet.\n\n${verificationInstruction(metadata)}`
    )
    return { ...metadata, stageId: contents.stageId }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

export function dryRunSdkRelease(directory, expected, env, { run = execFileSync } = {}) {
  const metadata = validateSdkArtifact(directory, { ...expected, mode: 'check' })
  const scratch = mkdtempSync(path.join(tmpdir(), 'noir-sdk-dry-run-'))
  try {
    // npm must not see user credentials or any CI/OIDC identity, even if called from a privileged shell.
    const cleanEnv = {
      PATH: env.PATH ?? '',
      HOME: scratch,
      TMPDIR: scratch,
      npm_config_cache: path.join(scratch, 'cache'),
      npm_config_userconfig: path.join(scratch, 'user.npmrc'),
      npm_config_globalconfig: path.join(scratch, 'global.npmrc'),
      npm_config_update_notifier: 'false',
      ...(process.platform === 'win32' ? { SystemRoot: env.SystemRoot } : {})
    }
    writeFileSync(cleanEnv.npm_config_userconfig, '')
    writeFileSync(cleanEnv.npm_config_globalconfig, '')
    const options = {
      cwd: scratch,
      env: cleanEnv,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180000
    }
    assert(
      run('npm', ['--version'], options).trim() === SDK_NPM_VERSION,
      `SDK dry-run requires npm ${SDK_NPM_VERSION}`
    )
    const output = JSON.parse(
      run(
        'npm',
        [
          'stage',
          'publish',
          path.resolve(directory, metadata.tarball),
          '--dry-run',
          // This local rehearsal also accepts already-published versions; registry policy is tested separately.
          '--force',
          '--access=public',
          `--tag=${releaseIdentity(metadata.version).distTag}`,
          `--registry=${REGISTRY}`,
          '--ignore-scripts',
          '--provenance',
          '--json',
          '--workspaces=false'
        ],
        options
      )
    )
    const receipt = output[SDK_PACKAGE] ?? output
    assert(
      receipt.name === SDK_PACKAGE &&
        receipt.version === metadata.version &&
        receipt.integrity === metadata.integrity &&
        !receipt.stageId,
      'npm dry-run receipt does not match the checked tarball'
    )
    validateSdkArtifact(directory, { ...expected, mode: 'check' })
    summary(
      env,
      `## SDK npm CLI dry-run passed; nothing uploaded\n\n${describe(metadata)}\n` +
        'The pinned npm CLI accepted this tarball in dry-run mode without credentials. ' +
        'OIDC authorization and npm server-side staging have not been tested.\n'
    )
    return metadata
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function safeRegistryUrl(value, pathnamePrefix) {
  const url = new URL(value)
  assert(
    url.origin === REGISTRY &&
      !url.username &&
      !url.password &&
      url.pathname.startsWith(pathnamePrefix) &&
      !url.hash &&
      !url.search,
    'Unexpected registry asset URL'
  )
  return url.href
}

export function validatePublishedProvenance(attestations, metadata) {
  const proofs =
    attestations?.attestations?.filter(
      proof => proof.predicateType === 'https://slsa.dev/provenance/v1'
    ) ?? []
  assert(proofs.length === 1, 'Expected one npm SLSA provenance attestation')
  const payload = proofs[0].bundle?.dsseEnvelope?.payload
  assert(typeof payload === 'string', 'npm provenance has no signed payload')
  const statement = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
  const definition = statement.predicate?.buildDefinition
  const workflow = definition?.externalParameters?.workflow
  const subject = statement.subject
  const digest = Buffer.from(metadata.integrity.slice('sha512-'.length), 'base64').toString('hex')
  assert(
    statement.predicateType === 'https://slsa.dev/provenance/v1' &&
      subject?.length === 1 &&
      subject[0].name === `pkg:npm/%40noir-wallet/sdk@${metadata.version}` &&
      subject[0].digest?.sha512 === digest,
    'npm provenance subject does not match the SDK tarball'
  )
  assert(
    workflow?.repository === `https://github.com/${SDK_REPOSITORY}` &&
      workflow.path === SDK_WORKFLOW &&
      workflow.ref === 'refs/heads/main',
    'Unexpected npm provenance workflow'
  )
  assert(
    definition.resolvedDependencies?.some(
      dependency =>
        dependency.uri === `git+https://github.com/${SDK_REPOSITORY}@refs/heads/main` &&
        dependency.digest?.gitCommit === metadata.workflowSha
    ),
    'npm provenance workflow commit mismatch'
  )
  const invocation = statement.predicate?.runDetails?.metadata?.invocationId
  const match = new RegExp(
    `^https://github\\.com/${SDK_REPOSITORY}/actions/runs/${metadata.runId}/attempts/([1-9]\\d*)$`
  ).exec(invocation ?? '')
  assert(
    match && BigInt(match[1]) >= BigInt(metadata.runAttempt),
    'npm provenance run identity mismatch'
  )
  // Only call this on bundles returned by npm audit signatures, which verifies the DSSE signatures.
}

export async function verifyPublishedSdk(
  directory,
  expected,
  { fetchImpl = fetch, onPublicationState = () => {} } = {}
) {
  const metadata = validateSdkArtifact(directory, { ...expected, mode: 'release' })
  const packument = await requestJson(PACKAGE_URL, { fetchImpl })
  assert(
    packument?.name === SDK_PACKAGE &&
      packument.versions &&
      typeof packument.versions === 'object' &&
      !Array.isArray(packument.versions),
    'Invalid SDK registry response'
  )
  if (!Object.hasOwn(packument.versions, metadata.version)) {
    onPublicationState('not-published')
    throw new Error('SDK version is not published; npm approval may still be pending')
  }
  const published = packument.versions?.[metadata.version]
  assert(
    published?.name === SDK_PACKAGE && published.version === metadata.version,
    'Published SDK identity does not match the accepted version'
  )
  onPublicationState('published')
  assert(
    packument['dist-tags']?.[metadata.distTag] === metadata.version,
    `npm ${metadata.distTag} does not match the accepted SDK version`
  )
  if (metadata.releaseLine === 'beta') {
    assert(
      STABLE_VERSION.test(packument['dist-tags']?.latest ?? ''),
      'npm latest must remain on the V1 stable line'
    )
  }
  assert(
    published.dist?.integrity === metadata.integrity,
    'Published npm integrity differs from the accepted SDK artifact'
  )
  const repository = published.repository
  assert(
    repository?.url?.replace(/^git\+/, '') === `https://github.com/${SDK_REPOSITORY}.git` &&
      repository.directory === 'packages/sdk',
    'Published SDK repository metadata mismatch'
  )
  const response = await fetchImpl(
    safeRegistryUrl(published.dist.tarball, '/@noir-wallet/sdk/-/'),
    {
      signal: AbortSignal.timeout(30000),
      redirect: 'error'
    }
  )
  assert(response.ok, `Published SDK tarball download failed (${response.status})`)
  const bytes = Buffer.from(await response.arrayBuffer())
  assert(
    bytes.length === metadata.size &&
      hash(bytes, 'sha256') === metadata.sha256 &&
      `sha512-${hash(bytes, 'sha512', 'base64')}` === metadata.integrity,
    'Downloaded npm tarball differs from the accepted artifact'
  )
  safeRegistryUrl(published.dist.attestations?.url, '/-/npm/v1/attestations/')
  return metadata
}

export async function locateSdkArtifact(env, { request } = {}) {
  trustedInvocation(env)
  const runId = positiveInteger(env.CANDIDATE_RUN_ID, 'Candidate run ID')
  const runAttempt = positiveInteger(env.CANDIDATE_RUN_ATTEMPT, 'Candidate run attempt')
  const get =
    request ??
    (route => {
      assert(env.GH_TOKEN, 'GH_TOKEN is required to locate an SDK build')
      return requestJson(`https://api.github.com/repos/${SDK_REPOSITORY}/${route}`, {
        token: env.GH_TOKEN
      })
    })
  const workflow = await get(`actions/workflows/publish-sdk.yml`)
  const run = await get(`actions/runs/${runId}/attempts/${runAttempt}`)
  assert(
    run.id === Number(runId) &&
      run.run_attempt === Number(runAttempt) &&
      run.workflow_id === workflow.id &&
      [SDK_WORKFLOW, `${SDK_WORKFLOW}@main`].includes(run.path) &&
      run.head_branch === 'main' &&
      run.head_repository?.full_name === SDK_REPOSITORY &&
      run.head_repository?.fork === false &&
      run.event === 'workflow_dispatch' &&
      SHA.test(run.head_sha),
    'Candidate was not built by the trusted main SDK workflow'
  )
  const jobs = await get(`actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`)
  assert(
    jobs.jobs?.some(job => job.name === 'Build SDK package' && job.conclusion === 'success'),
    'The selected attempt has no successful SDK build job'
  )
  const name = new RegExp(
    `^noir-sdk-(0\\.[0-9]+\\.[0-9]+|2\\.[0-9]+\\.[0-9]+-beta\\.[0-9]+)-${runId}-${runAttempt}$`
  )
  const matches = []
  for (let page = 1; page <= 20; page++) {
    const result = await get(`actions/runs/${runId}/artifacts?per_page=100&page=${page}`)
    assert(
      Array.isArray(result.artifacts) && Number.isSafeInteger(result.total_count),
      'Invalid SDK artifact inventory'
    )
    matches.push(...result.artifacts.filter(artifact => name.test(artifact.name)))
    if (page * 100 >= result.total_count) break
    assert(page < 20, 'SDK artifact inventory is too large')
  }
  assert(
    matches.length === 1 &&
      matches[0].expired === false &&
      Number.isSafeInteger(matches[0].id) &&
      matches[0].id > 0,
    'Exactly one unexpired SDK artifact is required; an expired original cannot be repacked as the same candidate'
  )
  return {
    artifact_id: String(matches[0].id),
    workflow_sha: run.head_sha,
    build_attempt: runAttempt
  }
}

function expectedFromEnv(env) {
  return {
    sourceSha: env.SDK_SOURCE_SHA,
    workflowSha: env.SDK_WORKFLOW_SHA,
    runId: positiveInteger(env.SDK_RUN_ID, 'Expected run ID'),
    runAttempt: positiveInteger(env.SDK_RUN_ATTEMPT, 'Expected run attempt'),
    version: env.SDK_VERSION,
    mode: env.SDK_ARTIFACT_MODE,
    sourceBranch: env.SDK_SOURCE_BRANCH,
    releaseLine: env.SDK_RELEASE_LINE,
    distTag: env.SDK_DIST_TAG
  }
}

function outputs(env, values) {
  if (env.GITHUB_OUTPUT)
    for (const [key, value] of Object.entries(values)) {
      assert(!/[\r\n]/.test(String(value)), 'Unsafe workflow output')
      appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`)
    }
}

function metadataOutputs(metadata) {
  return {
    tarball: metadata.tarball,
    version: metadata.version,
    source_sha: metadata.sourceSha,
    source_branch: metadata.sourceBranch ?? '',
    release_line: metadata.releaseLine ?? '',
    dist_tag: metadata.distTag ?? '',
    workflow_sha: metadata.workflowSha,
    build_attempt: metadata.runAttempt,
    artifact_name: artifactName(metadata)
  }
}

function describe(metadata) {
  const release =
    metadata.mode === 'release'
      ? `Release line: \`${metadata.releaseLine}\`\n\nnpm tag: \`${metadata.distTag}\`\n\n`
      : ''
  return (
    `Package: \`${SDK_PACKAGE}@${metadata.version}\`\n\n${release}Source (${metadata.sourceBranch ?? 'check'}): \`${metadata.sourceSha}\`\n\nWorkflow: \`${metadata.workflowSha}\`\n\n` +
    `Build: [${metadata.runId}, attempt ${metadata.runAttempt}](https://github.com/${SDK_REPOSITORY}/actions/runs/${metadata.runId}/attempts/${metadata.runAttempt})\n\n` +
    `SHA-256: \`${metadata.sha256}\`\n\nIntegrity: \`${metadata.integrity}\`\n`
  )
}

function summary(env, value) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, value)
}

async function main() {
  const env = process.env
  const [command, directory] = process.argv.slice(2)
  if (command === 'resolve') {
    trustedInvocation(env)
    const operation = env.OPERATION
    const releaseLine = env.RELEASE_LINE || 'stable'
    assert(['stage', 'verify'].includes(operation), 'Choose stage or verify')
    assert(['stable', 'beta'].includes(releaseLine), 'Choose stable or beta release line')
    let branchHeadSha
    let manifest
    if (operation === 'stage') {
      assert(env.GH_TOKEN, 'GH_TOKEN is required to resolve SDK source')
      const sourceBranch = releaseLine === 'stable' ? 'main' : 'v2'
      const get = route =>
        requestJson(`https://api.github.com/repos/${SDK_REPOSITORY}/${route}`, {
          token: env.GH_TOKEN
        })
      const branch = await get(`branches/${sourceBranch}`)
      branchHeadSha = branch.commit?.sha
      assert(
        SHA.test(branchHeadSha ?? '') && branch.name === sourceBranch,
        'Selected SDK source branch is not trusted'
      )
      assert(
        env.CONFIRM_SHA === branchHeadSha,
        'Confirmed source SHA must match the selected branch head'
      )
      const packageData = await get(`contents/packages/sdk/package.json?ref=${branchHeadSha}`)
      manifest = JSON.parse(Buffer.from(packageData.content, 'base64').toString('utf8'))
    }
    outputs(env, resolveSdkRelease({ env, manifest, branchHeadSha }))
  } else if (command === 'locate') {
    outputs(env, await locateSdkArtifact(env))
  } else if (
    ['pack', 'pack-check', 'validate', 'dry-run', 'stage', 'verify-published'].includes(command)
  ) {
    if (command === 'verify-published' && !directory) outputs(env, { publication_state: 'unknown' })
    assert(directory, 'SDK artifact directory is required')
    let metadata
    if (command === 'pack' || command === 'pack-check') {
      metadata =
        command === 'pack'
          ? packageSdkRelease(directory, env, {
              sourceRoot: path.resolve(env.SDK_SOURCE_ROOT ?? root)
            })
          : packageSdkCheck(directory, env)
      summary(
        env,
        `## SDK ${metadata.mode === 'check' ? 'rehearsal' : 'acceptance'} artifact\n\n${describe(metadata)}\nDownload this run's \`${artifactName(metadata)}\` artifact.\n` +
          (metadata.mode === 'release' ? `\n${verificationInstruction(metadata)}` : '')
      )
    } else if (command === 'validate') {
      metadata = validateSdkArtifact(directory, expectedFromEnv(env))
    } else if (command === 'dry-run') {
      metadata = dryRunSdkRelease(directory, expectedFromEnv(env), env)
    } else if (command === 'stage') {
      metadata = await stageSdkRelease(directory, expectedFromEnv(env), env)
    } else {
      let publicationState = 'unknown'
      try {
        trustedInvocation(env)
        metadata = await verifyPublishedSdk(directory, expectedFromEnv(env), {
          onPublicationState(state) {
            publicationState = state
            outputs(env, { publication_state: state })
          }
        })
      } catch (error) {
        if (publicationState === 'unknown') outputs(env, { publication_state: 'unknown' })
        throw error
      }
      summary(
        env,
        `## Published SDK bytes match\n\n${describe(metadata)}\n` +
          'Consumer installation and signed provenance identity verification must also succeed.\n'
      )
    }
    outputs(env, metadataOutputs(metadata))
  } else {
    throw new Error(
      'Usage: sdk-release.mjs resolve | pack|pack-check|validate|dry-run|stage|verify-published <artifact-dir> | locate'
    )
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`SDK release failed: ${error.message}`)
    process.exitCode = 1
  })
}
