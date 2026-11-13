import init, { WalletEngine } from '../../generated/wasm/multichain/wallet_wasm.js'
import manifest from '../../generated/wasm/multichain/wasm-integrity.json'

export const PINNED_MULTICHAIN_ABI_VERSION = 'wallet-engine-fc72763-v10'
export const PINNED_MULTICHAIN_SOURCE_COMMIT = 'fc727637f4df9d3bf9bc2d0cd946e0df2e16dc05'
export const PINNED_MULTICHAIN_CAPABILITIES = Object.freeze(
  [
    'account.bitcoin.batch-derive',
    'account.bitcoin.derive',
    'account.bitcoin.imported',
    'account.dash.batch-derive',
    'account.dash.derive',
    'account.dash.imported',
    'account.evm.derive',
    'account.evm.imported',
    'account.near.derive',
    'account.near.imported',
    'account.pea-v1.derive',
    'account.quantus.batch-derive',
    'account.quantus.derive',
    'account.pearl.batch-derive',
    'account.pearl.derive',
    'account.pearl.imported',
    'account.solana.derive',
    'account.solana.imported',
    'account.starknet.derive',
    'bitcoin.bip322.full.sign',
    'bitcoin.bip322.full.verify',
    'bitcoin.bip322.sign',
    'bitcoin.bip322.verify',
    'bitcoin.psbt-v0.sign',
    'credential.create-12',
    'credential.create-24',
    'credential.export-private-key',
    'credential.import-12',
    'credential.import-24',
    'credential.import-private-key-bip122',
    'credential.import-private-key-dash',
    'credential.import-private-key-eip155',
    'credential.import-private-key-near',
    'credential.import-private-key-pearl',
    'credential.import-private-key-solana',
    'credential.passphrase-empty-only',
    'dash.message.sign',
    'dash.message.verify',
    'dash.psbt-v0.sign',
    'evm.eip191.sign',
    'evm.eip712.sign',
    'evm.pea-v1.eip191.sign',
    'evm.pea-v1.eip712.sign',
    'evm.pea-v1.transaction.sign',
    'evm.transaction.sign',
    'near.nep413.sign',
    'near.nep413.verify',
    'near.transaction.sign',
    'pearl.bip322.sign',
    'pearl.bip322.verify',
    'pearl.psbt-v0.sign',
    'quantus.extrinsic.sign',
    'solana.message.sign',
    'solana.message.verify',
    'solana.transaction.sign',
    'starknet.deploy-account.sign',
    'starknet.invoke.sign',
    'starknet.typed-data.sign',
    'vault.argon2id-xchacha20poly1305',
    'vault.private-key-v2'
  ].sort()
)

function parseStaticManifest() {
  if (
    manifest.schemaVersion !== 2 ||
    manifest.engine !== 'multichain' ||
    manifest.abiVersion !== PINNED_MULTICHAIN_ABI_VERSION ||
    manifest.sourceCommit !== PINNED_MULTICHAIN_SOURCE_COMMIT ||
    manifest.build.target !== 'web' ||
    manifest.capabilities.length !== PINNED_MULTICHAIN_CAPABILITIES.length ||
    manifest.capabilities.some(
      (capability, index) => capability !== PINNED_MULTICHAIN_CAPABILITIES[index]
    )
  ) {
    throw new Error('Multichain WASM manifest is incompatible')
  }
  const binary = manifest.artifacts.find(artifact => artifact.path === 'wallet_wasm_bg.wasm')
  if (!binary || binary.role !== 'binary') {
    throw new Error('Multichain WASM binary is missing from the manifest')
  }
  return binary
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function createPinnedMultichainEngine(): Promise<WalletEngine> {
  const binary = parseStaticManifest()
  const wasmUrl = new URL('../../generated/wasm/multichain/wallet_wasm_bg.wasm', import.meta.url)
  const response = await fetch(wasmUrl)
  if (!response.ok) throw new Error('Unable to load the Multichain WASM binary')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength !== binary.bytes || (await sha256(bytes)) !== binary.sha256) {
    throw new Error('Multichain WASM binary integrity check failed')
  }
  await init({ module_or_path: new Uint8Array(bytes).buffer })
  return new WalletEngine()
}
