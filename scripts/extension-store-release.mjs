import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyReleaseArtifact } from './extension-release.mjs'
import { validatePublicationTarget } from './extension-release-gates.mjs'
import { signCrx3, verifyCrx3 } from './lib/crx3.mjs'
import { readZipManifest } from './lib/release-zip.mjs'
import {
  createChromeWebStoreClient,
  uploadPackage,
  submitPackage
} from './lib/chrome-web-store.mjs'
import {
  loadReleaseJournal,
  makeReceipt,
  receiptArtifactName,
  validateBinding
} from './lib/store-release-journal.mjs'

const REPOSITORY = 'NoirWallet/noir-wallet'
const EXTENSION_ID = 'mfoghjbpfanobmnoemoepenjjcmfpmdn'
const STAGES = ['upload', 'submit', 'notify']
const SHA = /^[0-9a-f]{40}$/
const DIGEST = /^[0-9a-f]{64}$/
const ID = /^[1-9][0-9]*$/

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const json = value => `${JSON.stringify(value, null, 2)}\n`

function requireMatch(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Invalid ${label}`)
  return value
}

function regularFile(file) {
  if (!lstatSync(file).isFile()) throw new Error('Expected a regular release file')
  return readFileSync(file)
}

function directoryInventory(directory, expected) {
  if (
    !lstatSync(directory).isDirectory() ||
    JSON.stringify(readdirSync(directory).sort()) !== JSON.stringify([...expected].sort())
  ) {
    throw new Error('Unexpected store artifact inventory')
  }
}

export function selectStoreAsset(metadata) {
  if (
    metadata.mode !== 'candidate' ||
    metadata.buildChannel !== 'production' ||
    metadata.repository !== REPOSITORY ||
    metadata.sourceRef !== `release/${metadata.version}`
  ) {
    throw new Error('Store signing requires an accepted production candidate')
  }
  const assets = metadata.assets.filter(asset => ['mainnet', 'multichain'].includes(asset.network))
  if (assets.length !== 1 || assets[0].name !== `noir-wallet-v${metadata.version}.zip`) {
    throw new Error('Exactly one production store ZIP is required')
  }
  return assets[0]
}

function checkManifest(bytes, version) {
  const manifest = readZipManifest(bytes)
  if (
    manifest.manifest_version !== 3 ||
    manifest.version !== version ||
    typeof manifest.name !== 'string' ||
    /\[(testnet|staging)\]/i.test(manifest.name)
  ) {
    throw new Error('Store ZIP manifest does not match the production candidate')
  }
}

export function signCandidate(
  directory,
  output,
  { expected, privateKey, publicKeySha256, publisherId, extensionId }
) {
  const metadata = verifyReleaseArtifact(directory, expected)
  const asset = selectStoreAsset(metadata)
  const zip = regularFile(path.join(directory, asset.name))
  checkManifest(zip, metadata.version)
  if (extensionId !== EXTENSION_ID) throw new Error('Unexpected production store extension ID')
  const signed = signCrx3(zip, privateKey, publicKeySha256)
  const binding = validateBinding({
    repository: metadata.repository,
    candidateRunId: metadata.runId,
    candidateRunAttempt: metadata.runAttempt,
    candidateWorkflowSha: metadata.workflowSha,
    sourceSha: metadata.sourceSha,
    version: metadata.version,
    network: asset.network,
    zipName: asset.name,
    zipSha256: asset.sha256,
    zipSize: asset.size,
    crxName: `noir-wallet-v${metadata.version}.crx`,
    crxSha256: digest(signed.crx),
    crxSize: signed.crx.length,
    publicKeySha256: signed.publicKeySha256,
    publisherId,
    extensionId
  })
  mkdirSync(output, { recursive: true })
  if (readdirSync(output).length) throw new Error('Store output directory must be empty')
  const manifestBytes = Buffer.from(json({ schemaVersion: 1, binding }))
  writeFileSync(path.join(output, binding.crxName), signed.crx)
  writeFileSync(path.join(output, 'store-package.json'), manifestBytes)
  verifyStoreBundle(output, { metadataSha256: digest(manifestBytes), publicKeySha256, expected })
  return { binding, metadataSha256: digest(manifestBytes) }
}

export function verifyStoreBundle(directory, { metadataSha256, publicKeySha256, expected }) {
  requireMatch(metadataSha256, DIGEST, 'signed metadata digest')
  requireMatch(publicKeySha256, DIGEST, 'signing public key digest')
  const bytes = regularFile(path.join(directory, 'store-package.json'))
  if (digest(bytes) !== metadataSha256) throw new Error('Signed metadata digest mismatch')
  const data = JSON.parse(bytes.toString('utf8'))
  if (data.schemaVersion !== 1 || Object.keys(data).sort().join(',') !== 'binding,schemaVersion') {
    throw new Error('Invalid signed package schema')
  }
  const binding = validateBinding(data.binding)
  if (
    binding.repository !== REPOSITORY ||
    binding.extensionId !== EXTENSION_ID ||
    binding.publicKeySha256 !== publicKeySha256 ||
    binding.zipName !== `noir-wallet-v${binding.version}.zip` ||
    binding.crxName !== `noir-wallet-v${binding.version}.crx`
  ) {
    throw new Error('Signed package identity mismatch')
  }
  for (const [field, value] of Object.entries({
    candidateRunId: expected.runId,
    candidateRunAttempt: expected.runAttempt,
    candidateWorkflowSha: expected.workflowSha,
    sourceSha: expected.sourceSha
  })) {
    if (binding[field] !== value) throw new Error('Signed package candidate binding mismatch')
  }
  directoryInventory(directory, ['store-package.json', binding.crxName])
  const crx = regularFile(path.join(directory, binding.crxName))
  if (crx.length !== binding.crxSize || digest(crx) !== binding.crxSha256) {
    throw new Error('Signed package CRX digest mismatch')
  }
  const verified = verifyCrx3(crx, {
    expectedZipSha256: binding.zipSha256,
    expectedZipSize: binding.zipSize,
    expectedPublicKeySha256: publicKeySha256
  })
  checkManifest(verified.zip, binding.version)
  return { binding, crx }
}

function context(env) {
  if (
    env.GITHUB_REPOSITORY !== REPOSITORY ||
    env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    env.GITHUB_REF !== 'refs/heads/main' ||
    env.GITHUB_WORKFLOW_REF !==
      `${REPOSITORY}/.github/workflows/publish-extension.yml@refs/heads/main`
  ) {
    throw new Error('Store release must be manually run from this repository main workflow')
  }
  return {
    id: requireMatch(env.GITHUB_RUN_ID, ID, 'workflow run ID'),
    attempt: requireMatch(env.GITHUB_RUN_ATTEMPT, ID, 'workflow run attempt'),
    sha: requireMatch(env.GITHUB_SHA, SHA, 'workflow commit')
  }
}

function expectedCandidate(env) {
  return {
    mode: 'candidate',
    repository: REPOSITORY,
    runId: requireMatch(env.CANDIDATE_RUN_ID, ID, 'candidate run ID'),
    runAttempt: requireMatch(env.CANDIDATE_RUN_ATTEMPT, ID, 'candidate run attempt'),
    workflowSha: requireMatch(env.CANDIDATE_WORKFLOW_SHA, SHA, 'candidate workflow commit'),
    sourceSha: requireMatch(env.CONFIRM_SHA, SHA, 'accepted source commit')
  }
}

function storeConfig(env) {
  if (env.CWS_EXTENSION_ID !== EXTENSION_ID)
    throw new Error('Unexpected production store extension ID')
  return {
    publisherId: requireMatch(env.CWS_PUBLISHER_ID, /^[A-Za-z0-9_-]{1,128}$/, 'publisher ID'),
    extensionId: EXTENSION_ID,
    publicKeySha256: requireMatch(
      env.CWS_SIGNING_PUBLIC_KEY_SHA256,
      DIGEST,
      'signing public key digest'
    )
  }
}

function workflowOutputs(values, env) {
  if (!env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required')
  for (const [key, value] of Object.entries(values)) {
    const text = String(value)
    if (/[\r\n]/.test(text)) throw new Error('Invalid workflow output')
    appendFileSync(env.GITHUB_OUTPUT, `${key}=${text}\n`)
  }
}

function githubRequest(env) {
  if (!env.GH_TOKEN) throw new Error('A read-only GitHub token is required')
  return async (route, { allowNotFound = false } = {}) => {
    let response
    try {
      response = await fetch(`https://api.github.com/repos/${REPOSITORY}/${route}`, {
        headers: {
          Authorization: `Bearer ${env.GH_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        signal: AbortSignal.timeout(30000),
        redirect: 'error'
      })
    } catch {
      throw new Error('GitHub release verification request failed')
    }
    if (response.status === 404 && allowNotFound) return null
    if (!response.ok)
      throw new Error(`GitHub release verification failed (HTTP ${response.status})`)
    return response.json()
  }
}

function writeReceipt(directory, receipt) {
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, 'receipt.json'), json(receipt))
}

export function needsWriteIntent(stage, journal) {
  const previous = journal[stage]
  if (previous && !(previous.status === 'failed' && previous.retryable === true)) return false
  if (stage === 'submit' && journal.upload?.status !== 'succeeded') return false
  if (stage === 'notify' && journal.submit?.status !== 'succeeded') return false
  return true
}

export async function sendStoreNotification({
  binding,
  submission,
  previous,
  run,
  webhookUrl,
  fetchImpl = fetch
}) {
  if (
    submission?.status !== 'succeeded' ||
    !['PENDING_REVIEW', 'STAGED'].includes(submission.state) ||
    submission.version !== binding.version
  ) {
    return { status: 'blocked', retryable: false, reason: 'submission_unconfirmed' }
  }
  if (previous?.status === 'succeeded') return previous
  if (previous && !(previous.status === 'failed' && previous.retryable === true)) {
    return { status: 'unknown', retryable: false, reason: 'delivery_unconfirmed' }
  }
  let url
  try {
    url = new URL(webhookUrl)
  } catch {
    return { status: 'failed', retryable: true, reason: 'webhook_not_configured' }
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'hooks.slack.com' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !/^\/services\/[A-Za-z0-9/]+$/.test(url.pathname)
  ) {
    return { status: 'failed', retryable: true, reason: 'invalid_webhook' }
  }
  const label =
    submission.state === 'STAGED'
      ? 'Review approved, ready for manual publication'
      : 'Submitted to Chrome Web Store for review'
  const text = [
    `Noir Wallet v${binding.version}: ${label}`,
    `Submission receipt: ${submission.state}. Check the dashboard for the current status. Publish manually after approval.`,
    `Commit: ${binding.sourceSha.slice(0, 12)}`,
    `<https://github.com/${binding.repository}/releases/tag/v${binding.version}|GitHub Release> · ` +
      `<https://github.com/${binding.repository}/actions/runs/${run.id}|Actions> · ` +
      `<https://chrome.google.com/webstore/devconsole/${binding.publisherId}/${binding.extensionId}/edit|Chrome Web Store>`
  ].join('\n')
  try {
    const response = await fetchImpl(url.href, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, unfurl_links: false, unfurl_media: false }),
      signal: AbortSignal.timeout(15000),
      redirect: 'error'
    })
    if (response.status === 200 && (await response.text()).trim() === 'ok') {
      return {
        status: 'succeeded',
        retryable: false,
        version: binding.version,
        state: submission.state,
        httpStatus: 200
      }
    }
    const rejected = response.status >= 400 && response.status < 500
    return {
      status: rejected ? 'failed' : 'unknown',
      retryable: rejected,
      reason: 'slack_delivery_failed',
      httpStatus: response.status
    }
  } catch {
    return { status: 'unknown', retryable: false, reason: 'delivery_unconfirmed' }
  }
}

async function cli(env, [command, ...args]) {
  const run = context(env)
  const config = storeConfig(env)
  if (command === 'check-auth') {
    const client = createChromeWebStoreClient({ ...config, accessToken: env.CWS_ACCESS_TOKEN })
    const status = await client.fetchStatus()
    if (!status.ok) throw new Error('CWS read-only authorization check failed')
    if (env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        `## CWS authorization checked\n\nExtension: \`${config.extensionId}\`\n\nNo package uploaded, submitted, or notification sent.\n`
      )
    return
  }
  const expected = expectedCandidate(env)
  if (command === 'sign') {
    const [directory, output] = args
    if (!directory || !output)
      throw new Error('Candidate and signed output directories are required')
    const metadata = verifyReleaseArtifact(directory, expected)
    if (!(await validatePublicationTarget(metadata, directory, githubRequest(env)))) {
      throw new Error('The accepted GitHub Release must exist before store signing')
    }
    const signed = signCandidate(directory, output, {
      expected,
      ...config,
      privateKey: env.CWS_SIGNING_PRIVATE_KEY
    })
    workflowOutputs(
      {
        metadata_sha256: signed.metadataSha256,
        version: signed.binding.version,
        artifact_name: `cws-signed-${run.id}-${run.attempt}`
      },
      env
    )
    return
  }
  const [stage, bundleDirectory, stateDirectory] = args
  if (!STAGES.includes(stage) || !bundleDirectory || !stateDirectory)
    throw new Error('Invalid store stage arguments')
  const { binding, crx } = verifyStoreBundle(bundleDirectory, {
    metadataSha256: env.SIGNED_METADATA_SHA256,
    publicKeySha256: config.publicKeySha256,
    expected
  })
  if (binding.publisherId !== config.publisherId || binding.extensionId !== config.extensionId) {
    throw new Error('Store destination changed after signing')
  }
  if (command === 'prepare') {
    const journal = await loadReleaseJournal({
      binding,
      repository: REPOSITORY,
      token: env.GH_TOKEN,
      currentRun: run
    })
    const needsIntent = needsWriteIntent(stage, journal)
    const plan = { stage, binding, run, journal, needsIntent }
    mkdirSync(stateDirectory, { recursive: true })
    if (readdirSync(stateDirectory).length) throw new Error('Stage output directory must be empty')
    const bytes = Buffer.from(json(plan))
    writeFileSync(path.join(stateDirectory, 'plan.json'), bytes)
    const intent = makeReceipt({ binding, stage, phase: 'intent', run })
    if (needsIntent) writeReceipt(path.join(stateDirectory, 'intent'), intent)
    workflowOutputs(
      {
        needs_intent: needsIntent,
        plan_sha256: digest(bytes),
        intent_artifact_name: receiptArtifactName(intent),
        result_artifact_name: receiptArtifactName(
          makeReceipt({
            binding,
            stage,
            phase: 'result',
            run,
            result: { status: 'unknown', retryable: false }
          })
        )
      },
      env
    )
    return
  }
  if (command !== 'execute') throw new Error('Expected sign, prepare, execute, or check-auth')
  const planBytes = regularFile(path.join(stateDirectory, 'plan.json'))
  if (digest(planBytes) !== requireMatch(env.STORE_PLAN_SHA256, DIGEST, 'stage plan digest')) {
    throw new Error('Store stage plan changed after preparation')
  }
  const plan = JSON.parse(planBytes.toString('utf8'))
  if (
    plan.stage !== stage ||
    JSON.stringify(plan.binding) !== JSON.stringify(binding) ||
    JSON.stringify(plan.run) !== JSON.stringify(run) ||
    plan.needsIntent !== needsWriteIntent(stage, plan.journal)
  )
    throw new Error('Store stage plan identity mismatch')
  if (plan.needsIntent) {
    const artifactId = requireMatch(env.INTENT_ARTIFACT_ID, ID, 'persisted intent artifact ID')
    const artifact = await githubRequest(env)(`actions/artifacts/${artifactId}`)
    const intent = makeReceipt({ binding, stage, phase: 'intent', run })
    if (
      artifact.expired ||
      artifact.name !== receiptArtifactName(intent) ||
      String(artifact.workflow_run?.id) !== run.id ||
      artifact.workflow_run?.head_sha !== run.sha
    ) {
      throw new Error('Store write intent was not durably recorded by this workflow')
    }
  }
  let result
  try {
    if (stage === 'notify') {
      result = await sendStoreNotification({
        binding,
        submission: plan.journal.submit,
        previous: plan.journal.notify,
        run,
        webhookUrl: env.CWS_SLACK_WEBHOOK_URL
      })
    } else {
      const client = createChromeWebStoreClient({
        ...config,
        accessToken: env.CWS_ACCESS_TOKEN,
        pollAttempts: 20,
        pollIntervalMs: 15000
      })
      result =
        stage === 'upload'
          ? await uploadPackage({
              client,
              version: binding.version,
              crxBytes: crx,
              filename: binding.crxName,
              previousUpload: plan.journal.upload,
              previousSubmission: plan.journal.submit
            })
          : await submitPackage({
              client,
              version: binding.version,
              uploadReceipt: plan.journal.upload,
              previousSubmission: plan.journal.submit
            })
    }
  } catch {
    result = { status: 'unknown', retryable: false, reason: 'stage_result_unconfirmed' }
  }
  writeReceipt(
    path.join(stateDirectory, 'result'),
    makeReceipt({ binding, stage, phase: 'result', run, result })
  )
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `## Chrome Web Store: ${stage}\n\nVersion: \`${binding.version}\`\n\n` +
        `Result: \`${result.status}\` / \`${result.state ?? result.reason ?? 'unknown'}\`\n\n` +
        `ZIP SHA-256: \`${binding.zipSha256}\`\n\nCRX SHA-256: \`${binding.crxSha256}\`\n\n` +
        (stage === 'notify' && result.status !== 'succeeded'
          ? 'Store submission succeeded; Slack notification was not confirmed. Retry notification only after inspecting its receipt.\n'
          : '')
    )
  if (result.status !== 'succeeded')
    throw new Error(`${stage} ${result.status}; inspect the stage receipt before retrying`)
}

let isCli = false
try {
  isCli =
    process.argv[1] &&
    realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
} catch {}
if (isCli) {
  cli(process.env, process.argv.slice(2)).catch(error => {
    // Errors from credentials and HTTP responses are reduced to safe messages at their boundary.
    process.stderr.write(`Store release failed: ${error.message}\n`)
    process.exitCode = 1
  })
}
