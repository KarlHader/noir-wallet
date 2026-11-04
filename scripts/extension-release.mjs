import { createHash } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { extractChangelogVersion } from './extract-changelog.mjs'
import { formatReleaseCommitLog, validateReleaseCommits } from './lib/extension-release-history.mjs'

const MODES = new Set(['preview', 'beta', 'candidate'])
const SHA = /^[0-9a-f]{40}$/i
const HASH = /^[0-9a-f]{64}$/
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const POSITIVE_ID = /^[1-9]\d*$/
const REF = /^[A-Za-z0-9._/-]+$/
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/
const BASE_FILES = ['release-metadata.json', 'release-body.md', 'SHA256SUMS']
const METADATA_KEYS = new Set([
  'schemaVersion',
  'mode',
  'buildChannel',
  'version',
  'sourceSha',
  'sourceRef',
  'repository',
  'workflowSha',
  'runId',
  'runAttempt',
  'prNumber',
  'prHeadSha',
  'prBaseSha',
  'artifactLabel',
  'assets'
])

function requireString(value, label, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function requireSha(value, label) {
  return requireString(value, label, SHA).toLowerCase()
}

function requireVersion(value) {
  const version = requireString(value, 'version', VERSION)
  if (!version.split('.').every(part => Number.isSafeInteger(Number(part)))) {
    throw new Error('Invalid version')
  }
  return version
}

export function sourceProfileForVersion(version) {
  return Number(requireVersion(version).split('.')[0]) >= 2 ? 'multichain' : 'zcash'
}

function networksForVersion(version) {
  return sourceProfileForVersion(version) === 'multichain' ? ['multichain'] : ['mainnet', 'testnet']
}

function buildChannelFor(mode, version) {
  if (mode === 'candidate') return 'production'
  return mode === 'preview' && sourceProfileForVersion(version) === 'multichain'
    ? 'development'
    : 'beta'
}

function requireId(value, label) {
  const id = requireString(value, label, POSITIVE_ID)
  if (!Number.isSafeInteger(Number(id))) throw new Error(`Invalid ${label}`)
  return id
}

function requireRef(value) {
  const ref = requireString(value, 'sourceRef', REF)
  if (
    ref.startsWith('/') ||
    ref.endsWith('/') ||
    ref.includes('//') ||
    ref.includes('..') ||
    ref.split('/').some(part => part === '.' || part === '..')
  ) {
    throw new Error('Invalid sourceRef')
  }
  return ref
}

function requireRepository(value) {
  const repository = requireString(value, 'repository', REPOSITORY)
  if (repository.includes('..')) throw new Error('Invalid repository')
  return repository
}

export function artifactLabelFor({ mode, version, sourceSha, runId, runAttempt, prNumber }) {
  if (!MODES.has(mode)) throw new Error('Invalid mode')
  requireVersion(version)
  const shortSha = requireSha(sourceSha, 'sourceSha').slice(0, 7)
  requireId(runId, 'runId')
  requireId(runAttempt, 'runAttempt')
  if (mode === 'candidate') return `v${version}-rc.${runId}.${runAttempt}.${shortSha}`
  if (mode === 'beta') return `v${version}-beta.${runId}.${runAttempt}.${shortSha}`
  return prNumber === undefined
    ? `v${version}-preview.${runId}.${runAttempt}.${shortSha}`
    : `v${version}-pr.${requireId(prNumber, 'prNumber')}.${shortSha}`
}

function assetName(mode, version, label, network) {
  const suffix = network === 'testnet' ? '-testnet' : ''
  const releaseName = mode === 'candidate' ? `v${version}` : label
  return `noir-wallet-${releaseName}${suffix}.zip`
}

function validateMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Release metadata must be an object')
  }
  const unknown = Object.keys(value).filter(key => !METADATA_KEYS.has(key))
  if (unknown.length) throw new Error(`Unknown release metadata fields: ${unknown.join(', ')}`)
  const {
    schemaVersion,
    mode,
    buildChannel,
    version,
    sourceSha,
    sourceRef,
    repository,
    workflowSha,
    runId,
    runAttempt,
    prNumber,
    prHeadSha,
    prBaseSha,
    artifactLabel,
    assets
  } = value
  if (schemaVersion !== 1) throw new Error('Invalid release metadata schemaVersion')
  if (!MODES.has(mode)) throw new Error('Invalid mode')
  requireVersion(version)
  requireSha(sourceSha, 'sourceSha')
  if (sourceSha !== sourceSha.toLowerCase()) throw new Error('Invalid sourceSha')
  requireRef(sourceRef)
  requireRepository(repository)
  requireSha(workflowSha, 'workflowSha')
  if (workflowSha !== workflowSha.toLowerCase()) throw new Error('Invalid workflowSha')
  requireId(runId, 'runId')
  requireId(runAttempt, 'runAttempt')
  if (buildChannel !== buildChannelFor(mode, version)) {
    throw new Error('Build channel does not match release mode')
  }
  if (mode === 'candidate' && sourceRef !== `release/${version}`) {
    throw new Error(`Candidate sourceRef must be release/${version}`)
  }
  if (mode !== 'preview' && [prNumber, prHeadSha, prBaseSha].some(item => item !== undefined)) {
    throw new Error('PR metadata is only valid for preview builds')
  }
  if (prNumber !== undefined) requireId(prNumber, 'prNumber')
  if (prHeadSha !== undefined && requireSha(prHeadSha, 'prHeadSha') !== prHeadSha) {
    throw new Error('Invalid prHeadSha')
  }
  if (prBaseSha !== undefined && requireSha(prBaseSha, 'prBaseSha') !== prBaseSha) {
    throw new Error('Invalid prBaseSha')
  }
  if ((prHeadSha !== undefined || prBaseSha !== undefined) && prNumber === undefined) {
    throw new Error('PR commits require prNumber')
  }
  const expectedLabel = artifactLabelFor(value)
  if (artifactLabel !== expectedLabel)
    throw new Error('Artifact label does not match release metadata')
  const networks = networksForVersion(version)
  if (!Array.isArray(assets) || assets.length !== networks.length) {
    throw new Error(`Release metadata must contain ${networks.length} assets`)
  }
  for (const [index, network] of networks.entries()) {
    const asset = assets[index]
    if (
      !asset ||
      typeof asset !== 'object' ||
      Array.isArray(asset) ||
      Object.keys(asset).some(key => !['network', 'name', 'sha256', 'size'].includes(key))
    ) {
      throw new Error(`Invalid ${network} asset metadata`)
    }
    if (
      asset.network !== network ||
      asset.name !== assetName(mode, version, artifactLabel, network)
    ) {
      throw new Error(`${network} asset name or network does not match release metadata`)
    }
    requireString(asset.sha256, `${network} sha256`, HASH)
    if (!Number.isSafeInteger(asset.size) || asset.size < 1) {
      throw new Error(`Invalid ${network} asset size`)
    }
  }
  return value
}

function regularFile(file, label) {
  const status = lstatSync(file)
  if (!status.isFile()) throw new Error(`${label} must be a regular file`)
  return status
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function sourceZip(networkBuildDir, subdir) {
  const dir = path.join(networkBuildDir, subdir)
  if (!lstatSync(dir).isDirectory()) throw new Error(`${subdir} must be a directory`)
  const zipNames = readdirSync(dir).filter(name => name.endsWith('.zip'))
  if (zipNames.length !== 1)
    throw new Error(`Expected exactly one ZIP in ${subdir}, found ${zipNames.length}`)
  const file = path.join(dir, zipNames[0])
  regularFile(file, `${subdir} ZIP`)
  return file
}

function releaseBody(metadata, changelog, commits) {
  const { mode, version, repository, sourceSha, sourceRef, artifactLabel, assets } = metadata
  const tag = mode === 'candidate' ? `v${version}` : artifactLabel
  const download = `https://github.com/${repository}/releases/download/${tag}`
  const link = name => (mode === 'preview' ? name : `${download}/${name}`)
  const title = mode === 'candidate' ? `Noir Wallet v${version}` : `Noir Wallet ${artifactLabel}`
  const lines = [
    `## ${title}`,
    '',
    `Source ref: \`${sourceRef}\``,
    `${mode === 'preview' ? (metadata.prNumber === undefined ? 'Tested commit' : 'Tested merge commit') : 'Source commit'}: [\`${sourceSha.slice(0, 7)}\`](https://github.com/${repository}/commit/${sourceSha})`,
    ...(metadata.prNumber === undefined
      ? []
      : [
          `Pull request: #${metadata.prNumber}`,
          ...(metadata.prHeadSha ? [`Head: \`${metadata.prHeadSha}\``] : []),
          ...(metadata.prBaseSha ? [`Base: \`${metadata.prBaseSha}\``] : [])
        ]),
    '',
    '| Network | Download |',
    '| --- | --- |',
    ...assets.map(
      asset =>
        `| ${asset.network === 'multichain' ? 'Mainnet + Testnet' : asset.network === 'mainnet' ? 'Mainnet' : 'Testnet'} | [${asset.name}](${link(asset.name)}) |`
    ),
    '',
    `SHA-256: [SHA256SUMS](${link('SHA256SUMS')})`
  ]
  if (changelog) lines.push('', changelog)
  if (commits !== undefined) lines.push('', formatReleaseCommitLog(repository, commits))
  return `${lines.join('\n')}\n`
}

function readPackagingInput(sourceDir, env) {
  if (!lstatSync(sourceDir).isDirectory()) throw new Error('Source directory must be a directory')
  const packageFile = path.join(sourceDir, 'packages', 'extension', 'package.json')
  regularFile(packageFile, 'Extension package.json')
  const version = requireVersion(JSON.parse(readFileSync(packageFile, 'utf8')).version)
  const mode = env.RELEASE_MODE
  const sourceProfile = sourceProfileForVersion(version)
  if (env.SOURCE_PROFILE && env.SOURCE_PROFILE !== sourceProfile) {
    throw new Error('Source profile does not match extension version')
  }
  const input = {
    schemaVersion: 1,
    mode,
    buildChannel: buildChannelFor(mode, version),
    version,
    sourceSha: requireSha(env.SOURCE_SHA, 'SOURCE_SHA'),
    sourceRef: requireRef(env.SOURCE_REF),
    repository: requireRepository(env.GITHUB_REPOSITORY),
    workflowSha: requireSha(env.WORKFLOW_SHA, 'WORKFLOW_SHA'),
    runId: requireId(env.GITHUB_RUN_ID, 'GITHUB_RUN_ID'),
    runAttempt: requireId(env.GITHUB_RUN_ATTEMPT, 'GITHUB_RUN_ATTEMPT')
  }
  if (!MODES.has(mode)) throw new Error('Invalid RELEASE_MODE')
  if (env.BUILD_CHANNEL && env.BUILD_CHANNEL !== input.buildChannel) {
    throw new Error('Build channel does not match release mode and source profile')
  }
  if (env.PR_NUMBER !== undefined && env.PR_NUMBER !== '')
    input.prNumber = requireId(env.PR_NUMBER, 'PR_NUMBER')
  if (env.PR_HEAD_SHA !== undefined && env.PR_HEAD_SHA !== '')
    input.prHeadSha = requireSha(env.PR_HEAD_SHA, 'PR_HEAD_SHA')
  if (env.PR_BASE_SHA !== undefined && env.PR_BASE_SHA !== '')
    input.prBaseSha = requireSha(env.PR_BASE_SHA, 'PR_BASE_SHA')
  input.artifactLabel = artifactLabelFor(input)
  return input
}

export async function packageReleaseArtifact(
  sourceDir,
  outputDir,
  env = process.env,
  networkBuildDir = path.join(sourceDir, 'packages', 'extension')
) {
  const input = readPackagingInput(sourceDir, env)
  const networks = networksForVersion(input.version)
  const commits =
    env.COMMIT_HISTORY === undefined
      ? undefined
      : validateReleaseCommits(JSON.parse(env.COMMIT_HISTORY))
  let changelog
  if (input.mode === 'candidate') {
    const changelogFile = path.join(sourceDir, 'CHANGELOG.md')
    const notesFile = path.join(sourceDir, 'packages', 'web', 'public', 'changelog.json')
    regularFile(changelogFile, 'CHANGELOG.md')
    regularFile(notesFile, 'changelog.json')
    changelog = extractChangelogVersion(readFileSync(changelogFile, 'utf8'), input.version)
    const { parseProductReleaseNotesManifest } =
      await import('../packages/extension/src/lib/extension-update.ts')
    parseProductReleaseNotesManifest(JSON.parse(readFileSync(notesFile, 'utf8')), input.version)
  }
  const assets = networks
    .map(network => ({
      network,
      source: sourceZip(networkBuildDir, network === 'testnet' ? 'dist-testnet' : 'dist')
    }))
    .map(({ network, source }) => ({
      network,
      name: assetName(input.mode, input.version, input.artifactLabel, network),
      sha256: sha256(source),
      size: statSync(source).size,
      source
    }))
  const metadata = validateMetadata({
    ...input,
    assets: assets.map(({ network, name, sha256: checksum, size }) => ({
      network,
      name,
      sha256: checksum,
      size
    }))
  })
  if (existsSync(outputDir)) {
    if (!lstatSync(outputDir).isDirectory() || readdirSync(outputDir).length !== 0) {
      throw new Error('Output directory must be empty')
    }
  } else {
    mkdirSync(outputDir, { recursive: true })
  }
  for (const asset of assets) copyFileSync(asset.source, path.join(outputDir, asset.name))
  writeFileSync(
    path.join(outputDir, 'SHA256SUMS'),
    assets.map(asset => `${asset.sha256}  ${asset.name}\n`).join('')
  )
  writeFileSync(path.join(outputDir, 'release-body.md'), releaseBody(metadata, changelog, commits))
  writeFileSync(
    path.join(outputDir, 'release-metadata.json'),
    `${JSON.stringify(metadata, null, 2)}\n`
  )
  verifyReleaseArtifact(outputDir)
  if (env.GITHUB_OUTPUT) {
    const outputs = {
      artifact_label: metadata.artifactLabel,
      version: metadata.version,
      source_sha: metadata.sourceSha,
      tag:
        metadata.mode === 'candidate'
          ? `v${metadata.version}`
          : metadata.mode === 'beta'
            ? metadata.artifactLabel
            : '',
      build_channel: metadata.buildChannel
    }
    appendFileSync(
      env.GITHUB_OUTPUT,
      Object.entries(outputs)
        .map(([key, value]) => `${key}=${value}\n`)
        .join('')
    )
  }
  return metadata
}

export function verifyReleaseArtifact(directory, expected = {}) {
  if (!lstatSync(directory).isDirectory()) throw new Error('Artifact directory must be a directory')
  const entries = readdirSync(directory)
  for (const name of BASE_FILES) regularFile(path.join(directory, name), name)
  const metadata = validateMetadata(
    JSON.parse(readFileSync(path.join(directory, 'release-metadata.json'), 'utf8'))
  )
  const inventory = [...BASE_FILES, ...metadata.assets.map(asset => asset.name)].sort()
  if (
    entries.length !== inventory.length ||
    entries.sort().some((name, index) => name !== inventory[index])
  ) {
    throw new Error('Artifact directory has missing or unexpected files')
  }
  for (const name of inventory) regularFile(path.join(directory, name), name)
  const body = readFileSync(path.join(directory, 'release-body.md'), 'utf8')
  if (!body.trim()) throw new Error('Release body is empty')
  const checksums = metadata.assets.map(asset => `${asset.sha256}  ${asset.name}\n`).join('')
  if (readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8') !== checksums) {
    throw new Error('SHA256SUMS does not match release metadata')
  }
  for (const asset of metadata.assets) {
    const file = path.join(directory, asset.name)
    const status = regularFile(file, asset.name)
    if (status.size !== asset.size || sha256(file) !== asset.sha256) {
      throw new Error(`${asset.network} ZIP checksum or size mismatch`)
    }
  }
  const expectedKeys = new Set([
    'mode',
    'repository',
    'runId',
    'runAttempt',
    'workflowSha',
    'sourceSha',
    'version'
  ])
  for (const [key, value] of Object.entries(expected)) {
    if (!expectedKeys.has(key)) throw new Error(`Unknown expected field: ${key}`)
    if (metadata[key] !== value)
      throw new Error(`Release artifact ${key} does not match expected value`)
  }
  return metadata
}

export function prereleaseNotes(directory) {
  const metadata = verifyReleaseArtifact(directory)
  if (!['beta', 'candidate'].includes(metadata.mode)) {
    throw new Error('Only Beta and candidate artifacts can be published as prereleases')
  }
  const body = readFileSync(path.join(directory, 'release-body.md'), 'utf8')
  if (metadata.mode === 'beta') return body

  const releaseBase = `https://github.com/${metadata.repository}/releases/download/`
  return [
    body
      .replace(
        `## Noir Wallet v${metadata.version}\n`,
        `## Noir Wallet ${metadata.artifactLabel}\n\nRelease candidate for testing; not the stable release.\n`
      )
      .replaceAll(
        `${releaseBase}v${metadata.version}/`,
        `${releaseBase}${metadata.artifactLabel}/`
      ),
    '### Acceptance build',
    '',
    `[Build and acceptance details](https://github.com/${metadata.repository}/actions/runs/${metadata.runId}/attempts/${metadata.runAttempt})`,
    '',
    `Run ID: \`${metadata.runId}\``,
    `Attempt: \`${metadata.runAttempt}\``,
    `Source SHA: \`${metadata.sourceSha}\``,
    ''
  ].join('\n')
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
    const [, , command, ...args] = process.argv
    if (command === 'package' && (args.length === 2 || args.length === 3)) {
      await packageReleaseArtifact(
        path.resolve(args[0]),
        path.resolve(args[1]),
        process.env,
        args[2] === undefined ? undefined : path.resolve(args[2])
      )
    } else if (command === 'verify' && args.length === 1) {
      const expected = {}
      for (const [name, key] of [
        ['EXPECTED_MODE', 'mode'],
        ['EXPECTED_REPOSITORY', 'repository'],
        ['EXPECTED_RUN_ID', 'runId'],
        ['EXPECTED_RUN_ATTEMPT', 'runAttempt'],
        ['EXPECTED_WORKFLOW_SHA', 'workflowSha'],
        ['EXPECTED_SOURCE_SHA', 'sourceSha'],
        ['EXPECTED_VERSION', 'version']
      ]) {
        if (process.env[name] !== undefined && process.env[name] !== '')
          expected[key] = process.env[name]
      }
      verifyReleaseArtifact(path.resolve(args[0]), expected)
    } else if (command === 'prerelease-notes' && args.length === 1) {
      process.stdout.write(prereleaseNotes(path.resolve(args[0])))
    } else {
      throw new Error(
        'Usage: extension-release.mjs package <sourceDir> <outputDir> [networkBuildDir] | verify <artifactDir> | prerelease-notes <artifactDir>'
      )
    }
  } catch (error) {
    process.stderr.write(
      `Release artifact error: ${error instanceof Error ? error.message : String(error)}\n`
    )
    process.exitCode = 1
  }
}
