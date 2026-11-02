import { test } from 'node:test'
import { expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  hashWasmPackage,
  inspectWasmBindgenPackage,
  parseWasmIntegrityManifest,
  verifyWasmPackageIntegrity
} from '../../../../../scripts/lib/wasm-package-integrity.mjs'

const extensionDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const zcashPackageDir = path.join(extensionDir, 'src/lib/wasm-pkg')
const integrityPath = path.join(zcashPackageDir, 'wasm-integrity.json')
const multichainPackageDir = path.join(extensionDir, 'src/infrastructure/generated/wasm/multichain')
const multichainSyncScript = path.resolve(
  extensionDir,
  '../../scripts/sync-multichain-wasm-pkg.mjs'
)
const zcashSyncScript = path.resolve(extensionDir, '../../scripts/sync-wasm-pkg.js')
const buildSurfaceScript = path.join(extensionDir, 'scripts/verify-build-surface.mjs')
const pinnedZcashRuntime = path.join(extensionDir, 'src/core/zcash/pinned-wasm.ts')
const zcashWorker = path.join(extensionDir, 'src/core/worker/zcash.worker.ts')
const compatibilityWorker = path.join(
  extensionDir,
  'src/infrastructure/keyring/migration/compatibility.worker.ts'
)
const pinnedMultichainRuntime = path.join(
  extensionDir,
  'src/infrastructure/keyring/multichain/pinned-wasm-engine.ts'
)
const prettierIgnore = path.resolve(extensionDir, '../../.prettierignore')

function classifyArtifact(relativePath) {
  if (relativePath === 'package.json') return 'metadata'
  if (relativePath === 'zcash_wallet_wasm.js') return 'loader'
  if (relativePath === 'zcash_wallet_wasm.d.ts') return 'types'
  if (relativePath === 'zcash_wallet_wasm_bg.wasm') return 'binary'
  if (relativePath === 'zcash_wallet_wasm_bg.wasm.d.ts') {
    return 'binary-types'
  }
  return 'support'
}

test.describe('WASM package integrity', () => {
  test('keeps the current Zcash wasm-bindgen loader, types and binary structurally aligned', async () => {
    const inspection = await inspectWasmBindgenPackage(zcashPackageDir, 'zcash_wallet_wasm')

    expect(inspection).toMatchObject({
      packageName: 'zcash-wallet-wasm',
      binaryHasWasmMagic: true,
      loaderReferencesBinary: true,
      missingTypeExports: [],
      missingSupportImports: []
    })
    expect(inspection.packageFiles).toEqual(
      expect.arrayContaining([
        'zcash_wallet_wasm.js',
        'zcash_wallet_wasm.d.ts',
        'zcash_wallet_wasm_bg.wasm'
      ])
    )
  })

  test('verifies exact files, byte lengths and hashes against a strict manifest', async () => {
    const artifacts = await hashWasmPackage(zcashPackageDir, classifyArtifact)
    const manifest = {
      schemaVersion: 1,
      engine: 'zcash',
      packageVersion: '0.1.0',
      abiVersion: 'test-only-v1',
      sourceCommit: 'a'.repeat(40),
      artifacts
    }

    await expect(verifyWasmPackageIntegrity(zcashPackageDir, manifest)).resolves.toMatchObject({
      engine: 'zcash',
      artifacts
    })
    const tampered = {
      ...manifest,
      artifacts: manifest.artifacts.map((artifact, index) =>
        index === 0 ? { ...artifact, sha256: '0'.repeat(64) } : artifact
      )
    }
    await expect(verifyWasmPackageIntegrity(zcashPackageDir, tampered)).rejects.toThrow(
      /integrity mismatch/
    )
  })

  test('rejects incomplete, open-ended and untraceable manifests', () => {
    const base = {
      schemaVersion: 1,
      engine: 'multichain',
      packageVersion: '1.0.0',
      abiVersion: 'v1',
      sourceCommit: 'b'.repeat(40),
      artifacts: [
        {
          path: 'wallet.js',
          role: 'loader',
          bytes: 1,
          sha256: '1'.repeat(64)
        },
        {
          path: 'wallet.d.ts',
          role: 'types',
          bytes: 1,
          sha256: '2'.repeat(64)
        },
        {
          path: 'wallet.wasm',
          role: 'binary',
          bytes: 1,
          sha256: '3'.repeat(64)
        }
      ]
    }

    expect(parseWasmIntegrityManifest(base).engine).toBe('multichain')
    expect(() => parseWasmIntegrityManifest({ ...base, sourceCommit: 'short' })).toThrow(
      /full lowercase Git commit/
    )
    expect(() => parseWasmIntegrityManifest({ ...base, unexpected: true })).toThrow(/invalid keys/)
    expect(() =>
      parseWasmIntegrityManifest({
        ...base,
        artifacts: base.artifacts.filter(artifact => artifact.role !== 'binary')
      })
    ).toThrow(/missing role: binary/)
  })

  test('parses a pinned build and sorted product capability manifest', () => {
    const manifest = parseWasmIntegrityManifest({
      schemaVersion: 2,
      engine: 'multichain',
      packageVersion: '0.1.0',
      abiVersion: 'wallet-engine-eb6c106-v2',
      sourceRepository: 'https://github.com/NoirWallet/multichain-wallet-wasm.git',
      sourceCommit: 'c'.repeat(40),
      build: {
        rustToolchain: '1.96.1',
        wasmPack: '0.14.0',
        wasmBindgen: '0.2.126',
        llvm: '22.1.4',
        target: 'web'
      },
      capabilities: ['account.bitcoin.derive', 'account.evm.derive'],
      artifacts: [
        { path: 'wallet.js', role: 'loader', bytes: 1, sha256: '1'.repeat(64) },
        { path: 'wallet.d.ts', role: 'types', bytes: 1, sha256: '2'.repeat(64) },
        { path: 'wallet.wasm', role: 'binary', bytes: 1, sha256: '3'.repeat(64) }
      ]
    })

    expect(manifest.capabilities).toEqual(['account.bitcoin.derive', 'account.evm.derive'])
    expect(() =>
      parseWasmIntegrityManifest({
        ...manifest,
        capabilities: ['account.evm.derive', 'account.bitcoin.derive']
      })
    ).toThrow(/sorted stable identifiers/)

    const zcashManifest = parseWasmIntegrityManifest({
      ...manifest,
      schemaVersion: 3,
      engine: 'zcash',
      abiVersion: 'zcash-wallet-5d45306-v1',
      sourceRepository: 'https://github.com/NoirWallet/zcash-wallet-wasm.git',
      build: {
        ...manifest.build,
        rustToolchain: 'nightly-2025-07-15',
        wasmBindgen: '0.2.122',
        wasmOpt: '117',
        prettier: '3.8.0'
      },
      capabilities: ['account.zcash.derive', 'zcash.transaction.sign']
    })
    expect(zcashManifest).toMatchObject({
      schemaVersion: 3,
      engine: 'zcash',
      build: { wasmOpt: '117', prettier: '3.8.0' }
    })
    expect(() =>
      parseWasmIntegrityManifest({
        ...zcashManifest,
        build: { ...zcashManifest.build, prettier: undefined }
      })
    ).toThrow(/prettier must be a non-empty string/)
  })

  test('verifies the pinned Zcash and Multichain packages', async () => {
    const inspection = await inspectWasmBindgenPackage(zcashPackageDir, 'zcash_wallet_wasm')
    const multichainInspection = await inspectWasmBindgenPackage(
      multichainPackageDir,
      'wallet_wasm'
    )
    const zcashManifest = JSON.parse(await readFile(integrityPath, 'utf8'))
    const multichainManifest = JSON.parse(
      await readFile(path.join(multichainPackageDir, 'wasm-integrity.json'), 'utf8')
    )

    expect(inspection.hasAbiVersionApi).toBe(false)
    expect(inspection.hasCapabilitiesApi).toBe(false)
    expect(multichainInspection).toMatchObject({
      packageName: 'wallet-wasm',
      binaryHasWasmMagic: true,
      loaderReferencesBinary: true,
      missingTypeExports: [],
      missingSupportImports: []
    })
    await expect(verifyWasmPackageIntegrity(zcashPackageDir, zcashManifest)).resolves.toMatchObject(
      {
        schemaVersion: 3,
        engine: 'zcash',
        abiVersion: 'zcash-wallet-7d6921d-v1',
        sourceCommit: '7d6921d51b9fe4f4a13b8886481a9a098d6f1e7f',
        build: { wasmOpt: '117', prettier: '3.8.0' }
      }
    )
    expect(zcashManifest.capabilities).toContain('credential.validate-12')
    expect(zcashManifest.capabilities).not.toContain('credential.create-12')
    await expect(
      verifyWasmPackageIntegrity(multichainPackageDir, multichainManifest)
    ).resolves.toMatchObject({
      schemaVersion: 2,
      engine: 'multichain',
      abiVersion: 'wallet-engine-cbd8ffb-v5',
      sourceCommit: 'cbd8ffbb192d67a3bd19eb5a4dcc38669f5e4f7a'
    })
  })

  test('keeps the runtime capability gate identical to the pinned Multichain manifest', async () => {
    const source = await readFile(pinnedMultichainRuntime, 'utf8')
    const manifest = JSON.parse(
      await readFile(path.join(multichainPackageDir, 'wasm-integrity.json'), 'utf8')
    )
    const declaration = source.match(
      /PINNED_MULTICHAIN_CAPABILITIES = Object\.freeze\(\s*\[([\s\S]*?)\]\.sort\(\)\s*\)/
    )
    expect(declaration).not.toBeNull()
    const capabilities = [...declaration[1].matchAll(/'([^']+)'/g)].map(match => match[1])

    expect(capabilities.sort()).toEqual(manifest.capabilities)
  })

  test('rebuilds and replaces the Zcash package through pinned rollback-capable gates', async () => {
    const source = await readFile(zcashSyncScript, 'utf8')
    const ignoredPaths = await readFile(prettierIgnore, 'utf8')

    expect(source).toContain("const SOURCE_COMMIT = '7d6921d51b9fe4f4a13b8886481a9a098d6f1e7f'")
    expect(source).toContain("const RUST_TOOLCHAIN = 'nightly-2025-11-15'")
    expect(source).toContain("const WASM_OPT_VERSION = '117'")
    expect(source).toContain('assertFreshBuildMatchesPinnedSource(buildDir)')
    expect(source).toContain('await verifyGeneratedPackage(stageDir, manifest)')
    expect(source).toContain('fs.renameSync(targetDir, backupDir)')
    expect(source).toContain('fs.renameSync(replacementDir, targetDir)')
    expect(source).toContain('fs.renameSync(backupDir, targetDir)')
    expect(source).toContain('preserveTransaction = true')
    expect(source).not.toContain('fs.rmSync(targetDir')
    expect(ignoredPaths).toContain('packages/extension/src/lib/wasm-pkg/')
  })

  test('checks the pinned Zcash binary at runtime and both packages in release builds', async () => {
    const [runtime, worker, migrationWorker, buildGate] = await Promise.all([
      readFile(pinnedZcashRuntime, 'utf8'),
      readFile(zcashWorker, 'utf8'),
      readFile(compatibilityWorker, 'utf8'),
      readFile(buildSurfaceScript, 'utf8')
    ])

    expect(runtime).toContain('manifest.schemaVersion !== 3')
    expect(runtime).toContain('manifest.abiVersion !== PINNED_ZCASH_ABI_VERSION')
    expect(runtime).toContain("crypto.subtle.digest('SHA-256', bytes)")
    expect(runtime).toContain("throw new Error('Zcash WASM binary integrity check failed')")
    expect(worker).toContain('await loadPinnedZcashWasmBinary(wasmUrl)')
    expect(worker).toContain('await init({ module_or_path: wasmBytes })')
    expect(migrationWorker).toContain('await loadPinnedZcashWasmBinary(zcashWasmUrl)')
    expect(migrationWorker).toContain('await initZcash({ module_or_path: zcashWasmBytes })')
    expect(buildGate).toContain("engine: 'zcash'")
    expect(buildGate).toContain("engine: 'multichain'")
    expect(buildGate).toContain("sourceCommit: 'cbd8ffbb192d67a3bd19eb5a4dcc38669f5e4f7a'")
    expect(buildGate).toContain('verifyWasmPackageIntegrity(directory, manifest)')
  })

  test('replaces the generated Multichain package through a rollback-capable transaction', async () => {
    const source = await readFile(multichainSyncScript, 'utf8')
    const ignoredPaths = await readFile(prettierIgnore, 'utf8')

    expect(source).toContain('fs.cpSync(stageDir, replacementDir')
    expect(source).toContain('fs.renameSync(targetDir, backupDir)')
    expect(source).toContain('fs.renameSync(replacementDir, targetDir)')
    expect(source).toContain('fs.renameSync(backupDir, targetDir)')
    expect(source).toContain('preserveTransaction = true')
    expect(source).toContain('await verifyGeneratedPackage(stageDir, manifest)')
    expect(source).not.toContain('fs.rmSync(targetDir')
    expect(ignoredPaths).toContain('packages/extension/src/infrastructure/generated/wasm/')
  })
})
