#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
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

const SOURCE_REPOSITORY = 'https://github.com/NoirWallet/multichain-wallet-wasm.git'
const SOURCE_COMMIT = 'cbd8ffbb192d67a3bd19eb5a4dcc38669f5e4f7a'
const ABI_VERSION = 'wallet-engine-cbd8ffb-v5'
const RUST_TOOLCHAIN = '1.96.1'
const WASM_PACK_VERSION = '0.14.0'
const WASM_BINDGEN_VERSION = '0.2.126'
const LLVM_VERSION = '22.1.4'
const CAPABILITIES = Object.freeze(
  [
    'account.bitcoin.batch-derive',
    'account.bitcoin.derive',
    'account.bitcoin.imported',
    'account.evm.derive',
    'account.evm.imported',
    'account.near.derive',
    'account.near.imported',
    'account.solana.derive',
    'account.solana.imported',
    'bitcoin.bip322.full.sign',
    'bitcoin.bip322.full.verify',
    'bitcoin.bip322.sign',
    'bitcoin.bip322.verify',
    'bitcoin.psbt-v0.sign',
    'credential.create-12',
    'credential.create-24',
    'credential.import-12',
    'credential.import-24',
    'credential.export-private-key',
    'credential.import-private-key-bip122',
    'credential.import-private-key-eip155',
    'credential.import-private-key-near',
    'credential.import-private-key-solana',
    'credential.passphrase-empty-only',
    'evm.eip191.sign',
    'evm.eip712.sign',
    'evm.pea-v1.eip191.sign',
    'evm.pea-v1.eip712.sign',
    'evm.pea-v1.transaction.sign',
    'evm.transaction.sign',
    'near.nep413.sign',
    'near.nep413.verify',
    'near.transaction.sign',
    'solana.message.sign',
    'solana.message.verify',
    'solana.transaction.sign',
    'vault.argon2id-xchacha20poly1305',
    'vault.private-key-v2'
  ].sort()
)

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(scriptDir, '..')
const targetDir = path.join(
  repositoryRoot,
  'packages/extension/src/infrastructure/generated/wasm/multichain'
)

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
  if (relativePath === 'wallet_wasm.js') return 'loader'
  if (relativePath === 'wallet_wasm.d.ts') return 'types'
  if (relativePath === 'wallet_wasm_bg.wasm') return 'binary'
  if (relativePath === 'wallet_wasm_bg.wasm.d.ts') return 'binary-types'
  return 'support'
}

function assertPinnedSource(sourceDir) {
  if (!fs.existsSync(path.join(sourceDir, '.git'))) {
    throw new Error(`Multichain WASM source is not a Git checkout: ${sourceDir}`)
  }
  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: sourceDir }).trim()
  if (commit !== SOURCE_COMMIT) {
    throw new Error(`Multichain WASM source commit ${commit} does not match ${SOURCE_COMMIT}`)
  }
  const dirty = run('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: sourceDir
  }).trim()
  if (dirty.length > 0) {
    throw new Error('Multichain WASM source checkout must be clean before building')
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

function copyGeneratedPackage(buildDir, stageDir) {
  const allowed = [
    'package.json',
    'wallet_wasm.js',
    'wallet_wasm.d.ts',
    'wallet_wasm_bg.wasm',
    'wallet_wasm_bg.wasm.d.ts'
  ]
  for (const filename of allowed) {
    const source = path.join(buildDir, filename)
    if (!fs.existsSync(source)) {
      throw new Error(`Generated WASM package is missing ${filename}`)
    }
    fs.copyFileSync(source, path.join(stageDir, filename))
  }
}

function replaceGeneratedPackage(stageDir) {
  const targetParent = path.dirname(targetDir)
  fs.mkdirSync(targetParent, { recursive: true })
  const transactionDir = fs.mkdtempSync(path.join(targetParent, '.multichain-wasm-sync-'))
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
            `Unable to install or restore the Multichain package; backup retained at ${backupDir}`
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
  const inspection = await inspectWasmBindgenPackage(stageDir, 'wallet_wasm')
  if (
    !inspection.binaryHasWasmMagic ||
    !inspection.loaderReferencesBinary ||
    inspection.missingTypeExports.length > 0 ||
    inspection.missingSupportImports.length > 0
  ) {
    throw new Error('Generated Multichain WASM package is structurally incomplete')
  }
  await verifyWasmPackageIntegrity(stageDir, manifest)
}

export async function syncMultichainWasmPackage({ sourceDir, clangPath }) {
  const resolvedSource = path.resolve(sourceDir)
  const resolvedClang = path.resolve(clangPath)
  assertPinnedSource(resolvedSource)

  assertVersion(
    readVersion('wasm-pack', ['--version'], /^wasm-pack\s+([0-9.]+)$/, 'wasm-pack'),
    WASM_PACK_VERSION,
    'wasm-pack'
  )
  assertVersion(
    readVersion(
      'rustup',
      ['run', RUST_TOOLCHAIN, 'rustc', '--version'],
      /^rustc\s+([0-9.]+)/,
      'Rust'
    ),
    RUST_TOOLCHAIN,
    'Rust'
  )
  assertVersion(
    readVersion(resolvedClang, ['--version'], /clang version\s+([0-9.]+)/, 'LLVM'),
    LLVM_VERSION,
    'LLVM'
  )

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noir-multichain-wasm-'))
  const buildDir = path.join(temporaryRoot, 'pkg')
  const stageDir = path.join(temporaryRoot, 'stage')
  fs.mkdirSync(stageDir)

  try {
    run(
      'wasm-pack',
      [
        'build',
        'crates/wallet-wasm',
        '--target',
        'web',
        '--out-dir',
        buildDir,
        '--release',
        '--',
        '--locked'
      ],
      {
        cwd: resolvedSource,
        env: {
          ...process.env,
          CC_wasm32_unknown_unknown: resolvedClang
        },
        encoding: null,
        stdio: 'inherit'
      }
    )
    copyGeneratedPackage(buildDir, stageDir)
    const packageJson = JSON.parse(fs.readFileSync(path.join(stageDir, 'package.json'), 'utf8'))
    const artifacts = await hashWasmPackage(stageDir, classifyArtifact)
    const manifest = parseWasmIntegrityManifest({
      schemaVersion: 2,
      engine: 'multichain',
      packageVersion: packageJson.version,
      abiVersion: ABI_VERSION,
      sourceRepository: SOURCE_REPOSITORY,
      sourceCommit: SOURCE_COMMIT,
      build: {
        rustToolchain: RUST_TOOLCHAIN,
        wasmPack: WASM_PACK_VERSION,
        wasmBindgen: WASM_BINDGEN_VERSION,
        llvm: LLVM_VERSION,
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
  const source = readArgument('--source')
  const clang = readArgument('--clang') ?? '/opt/homebrew/opt/llvm/bin/clang'
  if (!source) {
    console.error(
      'Usage: node scripts/sync-multichain-wasm-pkg.mjs --source <checkout> [--clang <path>]'
    )
    process.exit(1)
  }
  syncMultichainWasmPackage({ sourceDir: source, clangPath: clang })
    .then(output => console.log(`[sync-multichain-wasm-pkg] Synced to ${output}`))
    .catch(error => {
      console.error(
        `[sync-multichain-wasm-pkg] ${error instanceof Error ? error.message : String(error)}`
      )
      process.exit(1)
    })
}
