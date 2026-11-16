import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const MANIFEST_V1_KEYS = [
  'schemaVersion',
  'engine',
  'packageVersion',
  'abiVersion',
  'sourceCommit',
  'artifacts'
]
const MANIFEST_V2_KEYS = [...MANIFEST_V1_KEYS, 'sourceRepository', 'build', 'capabilities']
const MANIFEST_V3_KEYS = MANIFEST_V2_KEYS
const ARTIFACT_KEYS = ['path', 'role', 'bytes', 'sha256']
const BUILD_V2_KEYS = ['rustToolchain', 'wasmPack', 'wasmBindgen', 'llvm', 'target']
const BUILD_V3_KEYS = [...BUILD_V2_KEYS, 'wasmOpt', 'prettier']
const ENGINES = new Set(['zcash', 'multichain'])
const ROLES = new Set(['metadata', 'loader', 'types', 'binary', 'binary-types', 'support'])
const REQUIRED_ROLES = ['loader', 'types', 'binary']
const BUILD_TARGETS = new Set(['web', 'nodejs'])

function assertRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value
}

function assertExactKeys(record, expected, label) {
  const actual = Object.keys(record).sort()
  const sortedExpected = [...expected].sort()
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`${label} has invalid keys`)
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function parseArtifact(value, index) {
  const artifact = assertRecord(value, `artifacts[${index}]`)
  assertExactKeys(artifact, ARTIFACT_KEYS, `artifacts[${index}]`)
  const artifactPath = assertNonEmptyString(artifact.path, `artifacts[${index}].path`)
  if (
    path.posix.isAbsolute(artifactPath) ||
    artifactPath.includes('\\') ||
    artifactPath.split('/').includes('..')
  ) {
    throw new Error(`artifacts[${index}].path must be package-relative`)
  }
  const role = assertNonEmptyString(artifact.role, `artifacts[${index}].role`)
  if (!ROLES.has(role)) {
    throw new Error(`artifacts[${index}].role is unsupported`)
  }
  if (
    typeof artifact.bytes !== 'number' ||
    !Number.isSafeInteger(artifact.bytes) ||
    artifact.bytes <= 0
  ) {
    throw new Error(`artifacts[${index}].bytes must be a positive integer`)
  }
  if (typeof artifact.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(artifact.sha256)) {
    throw new Error(`artifacts[${index}].sha256 must be lowercase SHA-256`)
  }
  return Object.freeze({
    path: artifactPath,
    role,
    bytes: artifact.bytes,
    sha256: artifact.sha256
  })
}

export function parseWasmIntegrityManifest(value) {
  const manifest = assertRecord(value, 'WASM integrity manifest')
  if (![1, 2, 3].includes(manifest.schemaVersion)) {
    throw new Error('Unsupported WASM integrity manifest version')
  }
  assertExactKeys(
    manifest,
    manifest.schemaVersion === 1
      ? MANIFEST_V1_KEYS
      : manifest.schemaVersion === 2
        ? MANIFEST_V2_KEYS
        : MANIFEST_V3_KEYS,
    'WASM integrity manifest'
  )
  if (!ENGINES.has(manifest.engine)) {
    throw new Error('Unsupported WASM engine')
  }
  const packageVersion = assertNonEmptyString(manifest.packageVersion, 'packageVersion')
  const abiVersion = assertNonEmptyString(manifest.abiVersion, 'abiVersion')
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(abiVersion)) {
    throw new Error('abiVersion has an invalid format')
  }
  const sourceCommit = assertNonEmptyString(manifest.sourceCommit, 'sourceCommit')
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
    throw new Error('sourceCommit must be a full lowercase Git commit')
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new Error('artifacts must be a non-empty array')
  }
  const artifacts = manifest.artifacts.map(parseArtifact)
  const paths = new Set()
  for (const artifact of artifacts) {
    if (paths.has(artifact.path)) {
      throw new Error(`Duplicate WASM artifact path: ${artifact.path}`)
    }
    paths.add(artifact.path)
  }
  for (const role of REQUIRED_ROLES) {
    if (!artifacts.some(artifact => artifact.role === role)) {
      throw new Error(`WASM integrity manifest is missing role: ${role}`)
    }
  }
  const base = {
    schemaVersion: manifest.schemaVersion,
    engine: manifest.engine,
    packageVersion,
    abiVersion,
    sourceCommit,
    artifacts: Object.freeze(artifacts)
  }
  if (manifest.schemaVersion === 1) return Object.freeze(base)

  const sourceRepository = assertNonEmptyString(manifest.sourceRepository, 'sourceRepository')
  if (
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(sourceRepository)
  ) {
    throw new Error('sourceRepository must be a GitHub repository URL')
  }
  const build = assertRecord(manifest.build, 'build')
  assertExactKeys(build, manifest.schemaVersion === 2 ? BUILD_V2_KEYS : BUILD_V3_KEYS, 'build')
  const parsedBuild = {
    rustToolchain: assertNonEmptyString(build.rustToolchain, 'build.rustToolchain'),
    wasmPack: assertNonEmptyString(build.wasmPack, 'build.wasmPack'),
    wasmBindgen: assertNonEmptyString(build.wasmBindgen, 'build.wasmBindgen'),
    llvm: assertNonEmptyString(build.llvm, 'build.llvm'),
    target: assertNonEmptyString(build.target, 'build.target')
  }
  if (manifest.schemaVersion === 3) {
    parsedBuild.wasmOpt = assertNonEmptyString(build.wasmOpt, 'build.wasmOpt')
    parsedBuild.prettier = assertNonEmptyString(build.prettier, 'build.prettier')
  }
  Object.freeze(parsedBuild)
  if (!BUILD_TARGETS.has(parsedBuild.target)) {
    throw new Error('build.target is unsupported')
  }
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
    throw new Error('capabilities must be a non-empty array')
  }
  const capabilities = manifest.capabilities.map((capability, index) =>
    assertNonEmptyString(capability, `capabilities[${index}]`)
  )
  if (
    capabilities.some(capability => !/^[a-z0-9][a-z0-9.-]{0,127}$/.test(capability)) ||
    new Set(capabilities).size !== capabilities.length ||
    capabilities.some((capability, index) => index > 0 && capabilities[index - 1] >= capability)
  ) {
    throw new Error('capabilities must be unique, sorted stable identifiers')
  }
  return Object.freeze({
    ...base,
    sourceRepository,
    build: parsedBuild,
    capabilities: Object.freeze(capabilities)
  })
}

async function listFiles(directory, prefix = '') {
  const entries = await readdir(path.join(directory, prefix), {
    withFileTypes: true
  })
  const files = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const relativePath = prefix ? path.posix.join(prefix, entry.name) : entry.name
    if (entry.isDirectory()) {
      files.push(...(await listFiles(directory, relativePath)))
    } else if (entry.isFile() && entry.name !== 'wasm-integrity.json') {
      files.push(relativePath)
    } else if (!entry.isFile()) {
      throw new Error(`Unsupported WASM package entry: ${relativePath}`)
    }
  }
  return files.sort()
}

async function hashFile(filePath) {
  const hash = createHash('sha256')
  let bytes = 0
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', chunk => {
      bytes += chunk.length
      hash.update(chunk)
    })
    stream.on('end', resolve)
    stream.on('error', reject)
  })
  return { bytes, sha256: hash.digest('hex') }
}

export async function hashWasmPackage(directory, classifyRole) {
  const files = await listFiles(directory)
  const artifacts = []
  for (const relativePath of files) {
    const digest = await hashFile(path.join(directory, relativePath))
    artifacts.push(
      Object.freeze({
        path: relativePath,
        role: classifyRole(relativePath),
        ...digest
      })
    )
  }
  return Object.freeze(artifacts)
}

export async function verifyWasmPackageIntegrity(directory, inputManifest) {
  const manifest = parseWasmIntegrityManifest(inputManifest)
  const actualFiles = await listFiles(directory)
  const expectedFiles = manifest.artifacts.map(artifact => artifact.path).sort()
  if (
    actualFiles.length !== expectedFiles.length ||
    actualFiles.some((file, index) => file !== expectedFiles[index])
  ) {
    throw new Error('WASM package files do not match the integrity manifest')
  }
  for (const artifact of manifest.artifacts) {
    const actual = await hashFile(path.join(directory, artifact.path))
    if (actual.bytes !== artifact.bytes || actual.sha256 !== artifact.sha256) {
      throw new Error(`WASM artifact integrity mismatch: ${artifact.path}`)
    }
  }
  return manifest
}

function extractExports(source) {
  return new Set(
    [...source.matchAll(/export\s+(?:class|function)\s+([A-Za-z0-9_$]+)/g)].map(match => match[1])
  )
}

export async function inspectWasmBindgenPackage(directory, moduleName) {
  const loaderPath = path.join(directory, `${moduleName}.js`)
  const typesPath = path.join(directory, `${moduleName}.d.ts`)
  const binaryName = `${moduleName}_bg.wasm`
  const binaryPath = path.join(directory, binaryName)
  const binaryFile = await open(binaryPath, 'r')
  const binaryHeader = Buffer.alloc(4)
  try {
    await binaryFile.read(binaryHeader, 0, binaryHeader.length, 0)
  } finally {
    await binaryFile.close()
  }
  const [packageSource, loaderSource, typesSource] = await Promise.all([
    readFile(path.join(directory, 'package.json'), 'utf8'),
    readFile(loaderPath, 'utf8'),
    readFile(typesPath, 'utf8')
  ])
  const packageJson = JSON.parse(packageSource)
  const loaderExports = extractExports(loaderSource)
  const typeExports = extractExports(typesSource)
  const missingTypeExports = [...loaderExports].filter(name => !typeExports.has(name))
  const supportImports = [...loaderSource.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)].map(
    match => match[1]
  )
  const missingSupportImports = []
  for (const relativeImport of supportImports) {
    try {
      await readFile(path.resolve(directory, relativeImport))
    } catch {
      missingSupportImports.push(relativeImport)
    }
  }

  return Object.freeze({
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    packageFiles: Object.freeze([...(packageJson.files ?? [])]),
    binaryHasWasmMagic:
      binaryHeader[0] === 0x00 &&
      binaryHeader[1] === 0x61 &&
      binaryHeader[2] === 0x73 &&
      binaryHeader[3] === 0x6d,
    loaderReferencesBinary: loaderSource.includes(binaryName),
    missingTypeExports: Object.freeze(missingTypeExports),
    missingSupportImports: Object.freeze(missingSupportImports),
    hasAbiVersionApi:
      /\b(?:getVersion|get_version|abiVersion|abi_version)\b/.test(loaderSource) &&
      /\b(?:getVersion|get_version|abiVersion|abi_version)\b/.test(typesSource),
    hasCapabilitiesApi:
      /\b(?:getCapabilities|get_capabilities)\b/.test(loaderSource) &&
      /\b(?:getCapabilities|get_capabilities)\b/.test(typesSource)
  })
}
