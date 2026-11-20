/**
 * noir-multisig-mock: the wallet WASM for the simulated phones, loaded in the multisig tab itself.
 *
 * The extension's own share runs in the Zcash Worker; the phones stand in for other devices, so
 * they get their own instance here rather than borrowing the Worker's. One instance serves every
 * phone on the page (the wasm-bindgen glue is a module-level singleton anyway); each phone keeps
 * its own `Dkg` objects on it. No thread pool: the vault API is single-threaded.
 */
import type { VaultWasm } from '@/core/multisig/dkg-protocol'

// Also the marker the build-surface check looks for, so it stays a literal.
const LOAD_FAILED = 'noir-multisig-mock: the simulated phone could not load the wallet WASM'

let loading: Promise<VaultWasm> | null = null

// Everything WASM-related is imported here, not at module level: the store that owns this loader
// must stay loadable without the package, its manifest or the binary (Node tests inject a stub).
async function load(): Promise<VaultWasm> {
  const [wasm, { default: wasmUrl }, { loadPinnedZcashWasmBinary }] = await Promise.all([
    import('@/lib/wasm-pkg/zcash_wallet_wasm'),
    import('../../../lib/wasm-pkg/zcash_wallet_wasm_bg.wasm?url'),
    import('@/core/zcash/pinned-wasm')
  ])
  const bytes = await loadPinnedZcashWasmBinary(wasmUrl)
  await wasm.default({ module_or_path: bytes })
  return wasm
}

export function loadMockVaultWasm(): Promise<VaultWasm> {
  loading ??= load().catch(() => {
    loading = null
    throw new Error(LOAD_FAILED)
  })
  return loading
}
