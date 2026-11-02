import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { validatePublishedProvenance, validateSdkArtifact } from './sdk-release.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = path.resolve(process.env.SDK_SOURCE_ROOT ?? root)
const sdk = path.join(sourceRoot, 'packages/sdk')
const fixtures = path.join(root, 'packages/sdk/tests/fixtures')
const registry = 'https://registry.npmjs.org/'

function run(command, args, cwd, env, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: 180_000,
    ...options
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status}):\n${result.stderr || result.stdout}`
    )
  }
  return result.stdout
}

function cleanEnvironment(temp) {
  // Child npm and consumer processes must not inherit CI credentials or user npm config.
  return {
    PATH: process.env.PATH ?? '',
    HOME: temp,
    TMPDIR: temp,
    npm_config_cache: path.join(temp, 'npm-cache'),
    npm_config_userconfig: path.join(temp, 'user.npmrc'),
    npm_config_globalconfig: path.join(temp, 'global.npmrc'),
    npm_config_registry: registry,
    npm_config_update_notifier: 'false',
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {})
  }
}

function readManifest(tarball, env) {
  const raw = run('tar', ['-xOf', tarball, 'package/package.json'], root, env)
  const manifest = JSON.parse(raw)
  if (
    manifest.name !== '@noir-wallet/sdk' ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)
  ) {
    throw new Error('Tarball must contain a valid @noir-wallet/sdk package manifest')
  }
  return manifest
}

function makeConsumer(temp, name) {
  const directory = path.join(temp, name)
  mkdirSync(directory)
  writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ name, private: true }) + '\n'
  )
  for (const file of ['consumer.mjs', 'consumer.cjs', 'consumer.mts', 'consumer.cts']) {
    copyFileSync(path.join(fixtures, file), path.join(directory, file))
  }
  return directory
}

function checkConsumer(directory, packageSpec, version, env) {
  run(
    'npm',
    [
      'install',
      packageSpec,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      `--registry=${registry}`
    ],
    directory,
    env
  )

  const installed = JSON.parse(
    readFileSync(path.join(directory, 'node_modules/@noir-wallet/sdk/package.json'), 'utf8')
  )
  if (installed.name !== '@noir-wallet/sdk' || installed.version !== version) {
    throw new Error(`Installed unexpected SDK package: ${installed.name}@${installed.version}`)
  }

  run(process.execPath, ['consumer.mjs'], directory, env)
  run(process.execPath, ['consumer.cjs'], directory, env)
  run(
    process.execPath,
    [
      path.join(sdk, 'node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      'consumer.mts',
      'consumer.cts'
    ],
    directory,
    env
  )
  console.log(`Checked ${installed.name}@${version} in ${path.basename(directory)}`)
}

export async function validateVerifiedPublishedProvenance(
  audit,
  metadata,
  verifyBundle,
  tufCachePath
) {
  const matches =
    audit?.verified?.filter(
      item =>
        item.name === '@noir-wallet/sdk' &&
        item.version === metadata.version &&
        item.registry === registry &&
        item.attestations
    ) ?? []
  if (matches.length !== 1 || !Array.isArray(matches[0].attestationBundles)) {
    throw new Error(
      `Expected one npm-verified SDK provenance for @noir-wallet/sdk@${metadata.version}`
    )
  }
  const proofs = matches[0].attestationBundles.filter(
    proof => proof.predicateType === 'https://slsa.dev/provenance/v1'
  )
  if (proofs.length !== 1 || typeof verifyBundle !== 'function') {
    throw new Error('Expected one npm-verified SLSA bundle and a Sigstore verifier')
  }
  await verifyBundle(proofs[0].bundle, {
    certificateIdentityURI:
      'https://github.com/NoirWallet/noir-wallet/.github/workflows/publish-sdk.yml@refs/heads/main',
    certificateIssuer: 'https://token.actions.githubusercontent.com',
    tufCachePath
  })
  validatePublishedProvenance({ attestations: matches[0].attestationBundles }, metadata)
}

async function checkPublishedSignatures(directory, metadata, env) {
  const output = run(
    'npm',
    ['audit', 'signatures', '--json', '--include-attestations', `--registry=${registry}`],
    directory,
    env
  )
  const audit = JSON.parse(output)
  const npmRoot = run('npm', ['root', '--global'], directory, env).trim()
  const requireNpm = createRequire(path.join(npmRoot, 'npm/package.json'))
  const { verify } = requireNpm('sigstore')
  await validateVerifiedPublishedProvenance(
    audit,
    metadata,
    verify,
    path.join(env.HOME, 'sigstore-tuf')
  )
  console.log(`Verified registry signature and provenance for @noir-wallet/sdk@${metadata.version}`)
}

async function main() {
  const args = process.argv.slice(2)
  const published = args.includes('--published')
  const paths = args.filter(arg => arg !== '--published')
  if (
    paths.length > 1 ||
    paths.some(arg => arg.startsWith('--')) ||
    (published && paths.length !== 1)
  ) {
    throw new Error('Usage: node scripts/sdk-package-check.mjs [tarball-path] [--published]')
  }

  const temp = mkdtempSync(path.join(os.tmpdir(), 'sdk-package-check-'))
  try {
    const env = cleanEnvironment(temp)
    let tarball = paths.length ? path.resolve(paths[0]) : null
    if (!tarball) {
      const packed = JSON.parse(
        run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], sdk, env)
      )
      if (packed.length !== 1 || path.basename(packed[0].filename) !== packed[0].filename) {
        throw new Error('npm pack did not produce one SDK tarball')
      }
      tarball = path.join(temp, packed[0].filename)
    }

    const { version } = readManifest(tarball, env)
    const metadata = published ? validateSdkArtifact(path.dirname(tarball), { version }) : null
    if (metadata && path.join(path.dirname(tarball), metadata.tarball) !== tarball) {
      throw new Error('Published check requires the tarball named by its adjacent SDK metadata')
    }
    checkConsumer(makeConsumer(temp, 'tarball-consumer'), tarball, version, env)
    if (published) {
      const directory = makeConsumer(temp, 'registry-consumer')
      checkConsumer(directory, `@noir-wallet/sdk@${version}`, version, env)
      await checkPublishedSignatures(directory, metadata, env)
    }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
