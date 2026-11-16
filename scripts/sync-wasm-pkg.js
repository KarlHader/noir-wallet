#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  hashWasmPackage,
  inspectWasmBindgenPackage,
  parseWasmIntegrityManifest,
  verifyWasmPackageIntegrity
} from './lib/wasm-package-integrity.mjs'

const SOURCE_REPOSITORY = 'https://github.com/NoirWallet/zcash-wallet-wasm.git'
const SOURCE_COMMIT = 'cb8da9dc60d51dbf3958657be35427210d544541'
const ABI_VERSION = 'zcash-wallet-cb8da9d-v1'
const RUST_TOOLCHAIN = 'nightly-2026-10-20'
const RUST_VERSION = '1.101.0-nightly'
const WASM_PACK_VERSION = '0.14.0'
const WASM_BINDGEN_VERSION = '0.2.122'
const LLVM_VERSION = '22.1.4'
const WASM_OPT_VERSION = '117'
const PRETTIER_VERSION = '3.8.0'
const CAPABILITIES = Object.freeze(
  [
    'account.zcash.derive',
    'credential.create-24',
    'credential.passphrase-empty-only',
    'credential.validate-12',
    'credential.validate-24',
    'zcash.block-source.compact-cdn',
    'zcash.address.transparent',
    'zcash.address.unified',
    'zcash.message.transparent.sign',
    'zcash.pczt',
    'zcash.sync',
    'zcash.transaction.orchard-zero-indexer-broadcast',
    'zcash.transaction.sign',
    'zcash.voting.shielded'
  ].sort()
)

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(scriptDir, '..')
const targetDir = path.join(repositoryRoot, 'packages/extension/src/lib/wasm-pkg')
const prettierConfig = path.join(repositoryRoot, '.prettierrc')
const formattedArtifacts = [
  'package.json',
  'zcash_wallet_wasm.js',
  'zcash_wallet_wasm.d.ts',
  'zcash_wallet_wasm_bg.wasm.d.ts'
]

function readArgument(name) {
  const index = process.argv.indexOf(name)
  if (index === -1 || index === process.argv.length - 1) return undefined
  return process.argv[index + 1]
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: options.encoding ?? 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe']
  })
}

function readVersion(command, args, pattern, label) {
  const output = run(command, args).trim()
  const match = output.match(pattern)
  if (!match || match[1] === undefined) {
    throw new Error(`Unable to parse ${label} version`)
  }
  return match[1]
}

function assertVersion(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} ${actual} does not match pinned version ${expected}`)
  }
}

function classifyArtifact(relativePath) {
  if (relativePath === 'package.json') return 'metadata'
  if (relativePath === 'zcash_wallet_wasm.js') return 'loader'
  if (relativePath === 'zcash_wallet_wasm.d.ts') return 'types'
  if (relativePath === 'zcash_wallet_wasm_bg.wasm') return 'binary'
  if (relativePath === 'zcash_wallet_wasm_bg.wasm.d.ts') return 'binary-types'
  return 'support'
}

function listFiles(directory, prefix = '') {
  const files = []
  for (const entry of fs.readdirSync(path.join(directory, prefix), { withFileTypes: true })) {
    const relativePath = prefix ? path.posix.join(prefix, entry.name) : entry.name
    if (entry.isDirectory()) {
      files.push(...listFiles(directory, relativePath))
    } else if (entry.isFile()) {
      files.push(relativePath)
    } else {
      throw new Error(`Unsupported generated package entry: ${relativePath}`)
    }
  }
  return files.sort()
}

function assertPinnedSource(sourceDir) {
  if (!fs.existsSync(path.join(sourceDir, '.git'))) {
    throw new Error(`Zcash WASM source is not a Git checkout: ${sourceDir}`)
  }
  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: sourceDir }).trim()
  if (commit !== SOURCE_COMMIT) {
    throw new Error(`Zcash WASM source commit ${commit} does not match ${SOURCE_COMMIT}`)
  }
  const origin = run('git', ['remote', 'get-url', 'origin'], { cwd: sourceDir }).trim()
  if (origin !== SOURCE_REPOSITORY) {
    throw new Error(`Zcash WASM source origin ${origin} does not match ${SOURCE_REPOSITORY}`)
  }
  const dirty = run('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: sourceDir
  }).trim()
  if (dirty.length > 0) {
    throw new Error('Zcash WASM source checkout must be clean before building')
  }

  const toolchain = fs.readFileSync(path.join(sourceDir, 'rust-toolchain.toml'), 'utf8')
  const toolchainMatch = toolchain.match(/^channel\s*=\s*"([^"]+)"$/m)
  if (!toolchainMatch || toolchainMatch[1] !== RUST_TOOLCHAIN) {
    throw new Error(`Pinned source must declare Rust ${RUST_TOOLCHAIN}`)
  }

  const cargoLock = fs.readFileSync(path.join(sourceDir, 'Cargo.lock'), 'utf8')
  const wasmBindgenVersions = cargoLock
    .split(/^\[\[package\]\]$/m)
    .filter(block => /^name\s*=\s*"wasm-bindgen"$/m.test(block))
    .map(block => block.match(/^version\s*=\s*"([^"]+)"$/m)?.[1])
  if (wasmBindgenVersions.length !== 1 || wasmBindgenVersions[0] !== WASM_BINDGEN_VERSION) {
    throw new Error(`Pinned Cargo.lock must contain wasm-bindgen ${WASM_BINDGEN_VERSION}`)
  }
}

function assertBuildTools(clangPath) {
  assertVersion(
    readVersion('wasm-pack', ['--version'], /^wasm-pack\s+([0-9.]+)$/, 'wasm-pack'),
    WASM_PACK_VERSION,
    'wasm-pack'
  )
  assertVersion(
    readVersion(
      'rustup',
      ['run', RUST_TOOLCHAIN, 'rustc', '--version'],
      /^rustc\s+([^\s]+)/,
      'Rust'
    ),
    RUST_VERSION,
    'Rust'
  )
  assertVersion(
    readVersion(clangPath, ['--version'], /clang version\s+([0-9.]+)/, 'LLVM'),
    LLVM_VERSION,
    'LLVM'
  )
  assertVersion(
    readVersion('pnpm', ['exec', 'prettier', '--version'], /^([0-9.]+)$/, 'Prettier'),
    PRETTIER_VERSION,
    'Prettier'
  )
}

function findPinnedWasmOpt(explicitPath) {
  if (explicitPath) return path.resolve(explicitPath)
  const cacheRoots = [
    process.env.XDG_CACHE_HOME && path.join(process.env.XDG_CACHE_HOME, '.wasm-pack'),
    path.join(os.homedir(), 'Library/Caches/.wasm-pack'),
    path.join(os.homedir(), '.cache/.wasm-pack')
  ].filter(Boolean)
  for (const cacheRoot of cacheRoots) {
    if (!fs.existsSync(cacheRoot)) continue
    for (const entry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('wasm-opt-')) continue
      const candidate = path.join(cacheRoot, entry.name, 'bin/wasm-opt')
      if (!fs.existsSync(candidate)) continue
      const version = readVersion(
        candidate,
        ['--version'],
        /^wasm-opt version\s+([0-9]+)/,
        'wasm-opt'
      )
      if (version === WASM_OPT_VERSION) return candidate
    }
  }
  throw new Error(`Unable to find pinned wasm-opt ${WASM_OPT_VERSION} in the wasm-pack cache`)
}

function assertFreshBuildMatchesPinnedSource(buildDir) {
  const generatedFiles = listFiles(buildDir).filter(relativePath => relativePath !== '.gitignore')
  const sourceLock = JSON.parse(
    fs.readFileSync(path.join(scriptDir, 'zcash-wasm-source.lock.json'), 'utf8')
  )
  if (sourceLock.sourceCommit !== SOURCE_COMMIT) {
    throw new Error('Zcash WASM source lock does not match pinned source commit')
  }
  if (
    generatedFiles.length !== Object.keys(sourceLock.generatedArtifacts).length ||
    generatedFiles.some(relativePath => !sourceLock.generatedArtifacts[relativePath])
  ) {
    throw new Error('Fresh Zcash build does not match the pinned artifact list')
  }
  for (const relativePath of generatedFiles) {
    const generated = fs.readFileSync(path.join(buildDir, relativePath))
    const expected = sourceLock.generatedArtifacts[relativePath]
    const hash = createHash('sha256').update(generated).digest('hex')
    // Rust embeds checkout paths in the binary, so independently pin the
    // generated ABI files while the V2 manifest records each built binary.
    if (relativePath === 'zcash_wallet_wasm_bg.wasm') continue
    if (generated.length !== expected.bytes || hash !== expected.sha256) {
      throw new Error(
        `Fresh Zcash build does not match the pinned source artifact: ${relativePath}`
      )
    }
  }
}

function formatGeneratedPackage(stageDir) {
  run(
    'pnpm',
    [
      'exec',
      'prettier',
      '--config',
      prettierConfig,
      '--ignore-path',
      '/dev/null',
      '--write',
      ...formattedArtifacts.map(filename => path.join(stageDir, filename))
    ],
    { cwd: repositoryRoot, stdio: 'inherit', encoding: null }
  )
}

function replaceGeneratedPackage(stageDir) {
  const targetParent = path.dirname(targetDir)
  fs.mkdirSync(targetParent, { recursive: true })
  const transactionDir = fs.mkdtempSync(path.join(targetParent, '.zcash-wasm-sync-'))
  const replacementDir = path.join(transactionDir, 'replacement')
  const backupDir = path.join(transactionDir, 'backup')
  let previousPackageMoved = false
  let preserveTransaction = false

  try {
    fs.cpSync(stageDir, replacementDir, { recursive: true, errorOnExist: true, force: false })
    if (fs.existsSync(targetDir)) {
      fs.renameSync(targetDir, backupDir)
      previousPackageMoved = true
    }
    try {
      fs.renameSync(replacementDir, targetDir)
    } catch (error) {
      if (previousPackageMoved) {
        try {
          fs.renameSync(backupDir, targetDir)
        } catch (rollbackError) {
          preserveTransaction = true
          throw new AggregateError(
            [error, rollbackError],
            `Unable to install or restore the Zcash package; backup retained at ${backupDir}`
          )
        }
      }
      throw error
    }
    if (previousPackageMoved) fs.rmSync(backupDir, { recursive: true })
  } finally {
    if (!preserveTransaction) fs.rmSync(transactionDir, { recursive: true, force: true })
  }
}

async function verifyGeneratedPackage(stageDir, manifest) {
  const inspection = await inspectWasmBindgenPackage(stageDir, 'zcash_wallet_wasm')
  if (
    inspection.packageName !== 'zcash-wallet-wasm' ||
    inspection.packageVersion !== manifest.packageVersion ||
    !inspection.binaryHasWasmMagic ||
    !inspection.loaderReferencesBinary ||
    inspection.missingTypeExports.length > 0 ||
    inspection.missingSupportImports.length > 0
  ) {
    throw new Error('Generated Zcash WASM package is structurally incomplete')
  }
  await verifyWasmPackageIntegrity(stageDir, manifest)
}

export async function syncWasmPkg({ sourceDir, clangPath, wasmOptPath, cargoTargetDir }) {
  const resolvedSource = path.resolve(sourceDir)
  const resolvedClang = path.resolve(clangPath)
  assertPinnedSource(resolvedSource)
  assertBuildTools(resolvedClang)

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noir-zcash-wasm-'))
  const buildDir = path.join(temporaryRoot, 'pkg')
  const stageDir = path.join(temporaryRoot, 'stage')
  const resolvedCargoTarget = cargoTargetDir
    ? path.resolve(cargoTargetDir)
    : path.join(temporaryRoot, 'target')
  fs.mkdirSync(stageDir)

  try {
    run(
      'wasm-pack',
      [
        'build',
        '--mode',
        'no-install',
        '--target',
        'web',
        '--release',
        '--out-dir',
        buildDir,
        '--features',
        'voting,wasm-parallel',
        '-Z',
        'build-std=panic_abort,std',
        '--locked'
      ],
      {
        cwd: resolvedSource,
        env: {
          ...process.env,
          CARGO_TARGET_DIR: resolvedCargoTarget,
          CC_wasm32_unknown_unknown: resolvedClang
        },
        encoding: null,
        stdio: 'inherit'
      }
    )
    const resolvedWasmOpt = findPinnedWasmOpt(wasmOptPath)
    assertVersion(
      readVersion(resolvedWasmOpt, ['--version'], /^wasm-opt version\s+([0-9]+)/, 'wasm-opt'),
      WASM_OPT_VERSION,
      'wasm-opt'
    )
    assertFreshBuildMatchesPinnedSource(buildDir)

    fs.cpSync(buildDir, stageDir, { recursive: true })
    fs.rmSync(path.join(stageDir, '.gitignore'), { force: true })
    formatGeneratedPackage(stageDir)

    const packageJson = JSON.parse(fs.readFileSync(path.join(stageDir, 'package.json'), 'utf8'))
    const artifacts = await hashWasmPackage(stageDir, classifyArtifact)
    const manifest = parseWasmIntegrityManifest({
      schemaVersion: 3,
      engine: 'zcash',
      packageVersion: packageJson.version,
      abiVersion: ABI_VERSION,
      sourceRepository: SOURCE_REPOSITORY,
      sourceCommit: SOURCE_COMMIT,
      build: {
        rustToolchain: RUST_TOOLCHAIN,
        wasmPack: WASM_PACK_VERSION,
        wasmBindgen: WASM_BINDGEN_VERSION,
        llvm: LLVM_VERSION,
        wasmOpt: WASM_OPT_VERSION,
        prettier: PRETTIER_VERSION,
        target: 'web'
      },
      capabilities: CAPABILITIES,
      artifacts
    })
    fs.writeFileSync(
      path.join(stageDir, 'wasm-integrity.json'),
      `${JSON.stringify(manifest, null, 2)}\n`
    )

    await verifyGeneratedPackage(stageDir, manifest)
    replaceGeneratedPackage(stageDir)
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }

  return targetDir
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = readArgument('--source') ?? path.join(repositoryRoot, 'packages/zcash-wallet-wasm')
  const clang = readArgument('--clang') ?? '/opt/homebrew/opt/llvm/bin/clang'
  const wasmOpt = readArgument('--wasm-opt')
  const cargoTarget = readArgument('--cargo-target-dir')
  if (!fs.existsSync(source)) {
    console.error(
      'Usage: node scripts/sync-wasm-pkg.js --source <checkout> [--clang <path>] [--wasm-opt <path>] [--cargo-target-dir <path>]'
    )
    process.exit(1)
  }
  syncWasmPkg({
    sourceDir: source,
    clangPath: clang,
    wasmOptPath: wasmOpt,
    cargoTargetDir: cargoTarget
  })
    .then(output => console.log(`[sync-wasm-pkg] Synced to ${output}`))
    .catch(error => {
      console.error(`[sync-wasm-pkg] ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    })
}
