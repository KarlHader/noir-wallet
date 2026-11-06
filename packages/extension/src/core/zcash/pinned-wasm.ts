import manifest from '../../lib/wasm-pkg/wasm-integrity.json'

export const PINNED_ZCASH_ABI_VERSION = 'zcash-wallet-cb8da9d-v1'
export const PINNED_ZCASH_SOURCE_COMMIT = 'cb8da9dc60d51dbf3958657be35427210d544541'
export const PINNED_ZCASH_CAPABILITIES = Object.freeze(
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

function parseStaticManifest() {
  if (
    manifest.schemaVersion !== 3 ||
    manifest.engine !== 'zcash' ||
    manifest.packageVersion !== '0.1.0' ||
    manifest.abiVersion !== PINNED_ZCASH_ABI_VERSION ||
    manifest.sourceCommit !== PINNED_ZCASH_SOURCE_COMMIT ||
    manifest.build.rustToolchain !== 'nightly-2026-10-20' ||
    manifest.build.wasmPack !== '0.14.0' ||
    manifest.build.wasmBindgen !== '0.2.122' ||
    manifest.build.llvm !== '22.1.4' ||
    manifest.build.wasmOpt !== '117' ||
    manifest.build.prettier !== '3.8.0' ||
    manifest.build.target !== 'web' ||
    manifest.capabilities.length !== PINNED_ZCASH_CAPABILITIES.length ||
    manifest.capabilities.some(
      (capability, index) => capability !== PINNED_ZCASH_CAPABILITIES[index]
    )
  ) {
    throw new Error('Zcash WASM manifest is incompatible')
  }
  const binary = manifest.artifacts.find(artifact => artifact.path === 'zcash_wallet_wasm_bg.wasm')
  if (!binary || binary.role !== 'binary') {
    throw new Error('Zcash WASM binary is missing from the manifest')
  }
  return binary
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function loadPinnedZcashWasmBinary(wasmUrl: string): Promise<ArrayBuffer> {
  const binary = parseStaticManifest()
  const response = await fetch(wasmUrl)
  if (!response.ok) throw new Error('Unable to load the Zcash WASM binary')
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength !== binary.bytes || (await sha256(bytes)) !== binary.sha256) {
    throw new Error('Zcash WASM binary integrity check failed')
  }
  return bytes
}
