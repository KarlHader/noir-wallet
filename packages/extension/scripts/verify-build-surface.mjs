import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { collectLedgerDependencyNotices } from './lib/ledger-dependency-notices.mjs'

import {
  inspectWasmBindgenPackage,
  verifyWasmPackageIntegrity
} from '../../../scripts/lib/wasm-package-integrity.mjs'

const isPlaywrightBuild = process.env.PLAYWRIGHT_E2E === '1'
const isTestnetBuild = process.env.NETWORK_MODE === 'testnet'
const isProductionChannel = process.env.BUILD_CHANNEL === 'production'
const networkMode = isTestnetBuild ? 'testnet' : 'mainnet'
const e2eBuildProfile = process.env.E2E_BUILD_PROFILE ?? `${networkMode}-default`
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(e2eBuildProfile)) {
  throw new Error(`Invalid E2E_BUILD_PROFILE: ${e2eBuildProfile}`)
}
if (isPlaywrightBuild && !e2eBuildProfile.startsWith(`${networkMode}-`)) {
  throw new Error(`E2E_BUILD_PROFILE ${e2eBuildProfile} does not match NETWORK_MODE ${networkMode}`)
}
const expectedOutputDirectoryName = isPlaywrightBuild
  ? path.posix.join('e2e-dist', e2eBuildProfile)
  : isTestnetBuild
    ? path.posix.join('e2e-dist', 'testnet-build-check')
    : 'dist'
const outputDirectoryName = process.argv[2] ?? expectedOutputDirectoryName
if (outputDirectoryName !== expectedOutputDirectoryName) {
  throw new Error(`Invalid build-surface output directory: ${outputDirectoryName}`)
}
const outputDirectory = path.resolve(outputDirectoryName)
const textExtensions = new Set(['.html', '.js', '.json'])
const conformanceMarker = '.conformance-'
const testHarnessFiles = [
  'tests/extension/credential-repository-integration.html',
  'tests/extension/transaction-repository-integration.html',
  'tests/extension/bitcoin-discovery-repository-integration.html'
]
const extensionDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function verifyBundledLedgerLicenses() {
  for (const notice of collectLedgerDependencyNotices(extensionDirectory)) {
    const bundled = await readFile(path.join(outputDirectory, notice.fileName))
    if (!bundled.equals(notice.source)) {
      throw new Error(
        `Bundled dependency notice differs from the installed package: ${notice.fileName}`
      )
    }
  }
}

async function verifyPackagedWasm({ directory, moduleName, engine, schemaVersion, sourceCommit }) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'wasm-integrity.json'), 'utf8'))
  const [verifiedManifest, inspection] = await Promise.all([
    verifyWasmPackageIntegrity(directory, manifest),
    inspectWasmBindgenPackage(directory, moduleName)
  ])
  if (
    verifiedManifest.engine !== engine ||
    verifiedManifest.schemaVersion !== schemaVersion ||
    verifiedManifest.sourceCommit !== sourceCommit ||
    verifiedManifest.packageVersion !== inspection.packageVersion ||
    !inspection.binaryHasWasmMagic ||
    !inspection.loaderReferencesBinary ||
    inspection.missingTypeExports.length > 0 ||
    inspection.missingSupportImports.length > 0
  ) {
    throw new Error(`${engine} WASM package failed structural or provenance verification`)
  }
}

await Promise.all([
  verifyBundledLedgerLicenses(),
  verifyPackagedWasm({
    directory: path.join(extensionDirectory, 'src/lib/wasm-pkg'),
    moduleName: 'zcash_wallet_wasm',
    engine: 'zcash',
    schemaVersion: 3,
    sourceCommit: '7d6921d51b9fe4f4a13b8886481a9a098d6f1e7f'
  }),
  verifyPackagedWasm({
    directory: path.join(extensionDirectory, 'src/infrastructure/generated/wasm/multichain'),
    moduleName: 'wallet_wasm',
    engine: 'multichain',
    schemaVersion: 2,
    sourceCommit: 'cbd8ffbb192d67a3bd19eb5a4dcc38669f5e4f7a'
  })
])

async function collectFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const relativePath = path.posix.join(prefix, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path.join(directory, entry.name), relativePath)))
    } else {
      files.push(relativePath)
    }
  }
  return files
}

const files = await collectFiles(outputDirectory)
const fileSet = new Set(files)
let containsConformanceRoute = false
const productionDiagnosticFiles = []
function containsExecutableDiagnostic(source, fileName) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  let found = false
  function isConsoleExpression(node) {
    if (ts.isIdentifier(node)) return node.text === 'console'
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'console' &&
      ts.isIdentifier(node.expression)
    ) {
      return ['globalThis', 'window', 'self'].includes(node.expression.text)
    }
    return false
  }
  function visit(node) {
    if (found) return
    if (ts.isDebuggerStatement(node)) {
      found = true
      return
    }
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      isConsoleExpression(node.expression)
    ) {
      found = true
      return
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return found
}

for (const relativePath of files) {
  if (!textExtensions.has(path.extname(relativePath))) continue
  const content = await readFile(path.join(outputDirectory, relativePath), 'utf8')
  if (content.includes(conformanceMarker)) containsConformanceRoute = true
  if (
    isProductionChannel &&
    path.extname(relativePath) === '.js' &&
    containsExecutableDiagnostic(content, relativePath)
  ) {
    productionDiagnosticFiles.push(relativePath)
  }
}

if (isPlaywrightBuild) {
  if (
    !containsConformanceRoute ||
    !fileSet.has('e2e-build-profile.json') ||
    testHarnessFiles.some(file => !fileSet.has(file))
  ) {
    throw new Error('E2E build is missing its Multichain conformance surface')
  }
} else if (
  containsConformanceRoute ||
  fileSet.has('e2e-build-profile.json') ||
  testHarnessFiles.some(file => fileSet.has(file))
) {
  throw new Error('Production build contains an E2E-only surface')
}
if (productionDiagnosticFiles.length > 0) {
  throw new Error(
    `Production build contains diagnostic code: ${productionDiagnosticFiles.join(', ')}`
  )
}

console.log(
  [
    isPlaywrightBuild
      ? 'Verified E2E-only Multichain conformance surface'
      : 'Verified production build excludes E2E-only surfaces',
    'Verified packaged Zcash and Multichain WASM integrity',
    ...(isProductionChannel ? ['Verified production build excludes diagnostic code'] : [])
  ].join('\n')
)
