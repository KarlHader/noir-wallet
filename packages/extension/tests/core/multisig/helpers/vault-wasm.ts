/**
 * Brings up the extension's real wallet WASM package inside Node, so the multisig tests exercise
 * the vault API rather than a stand-in. Loaded once per process.
 */
import { readFile } from 'node:fs/promises'
import type { DkgPort } from '../../../../src/core/multisig/dkg-port'
import type { VaultWasm } from '../../../../src/core/multisig/dkg-protocol'
import type {
  VaultDkgMethod,
  VaultDkgRpcHandler,
  VaultDkgSchema
} from '../../../../src/core/multisig/dkg-rpc'
import type { SealedVaultRecord } from '../../../../src/core/multisig/vault-record'
import { multisigGroupScopeKey } from '../../../../src/lib/multisig-group-storage'

export type WalletWasmModule = typeof import('../../../../src/lib/wasm-pkg/zcash_wallet_wasm')

const packageDir = new URL('../../../../src/lib/wasm-pkg/', import.meta.url)

/** The wallet mnemonic every in-process handler seals under; the Worker resolves it per wallet. */
export const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

let loading: Promise<WalletWasmModule> | null = null

export function loadVaultWasm(): Promise<VaultWasm> {
  return loadWalletWasm()
}

/** The whole package, for tests that compare the extension's own encoders with the wasm ones. */
export function loadWalletWasm(): Promise<WalletWasmModule> {
  loading ??= (async () => {
    // The package's thread helper touches these Worker globals while it is being imported.
    const host = globalThis as Record<string, unknown>
    host.self ??= globalThis
    host.addEventListener ??= () => {}
    host.removeEventListener ??= () => {}
    const wasm: WalletWasmModule = await import(new URL('zcash_wallet_wasm.js', packageDir).href)
    const binary = await readFile(new URL('zcash_wallet_wasm_bg.wasm', packageDir))
    // No thread pool: the vault API is single-threaded and the tests have no cross-origin isolation.
    wasm.initSync({ module: binary })
    return wasm
  })()
  return loading
}

/**
 * A DkgPort that calls a Worker handler in this process. Every request and response is JSON
 * round-tripped, as it would be across chrome.runtime messaging. `open` does what Background does
 * with the page's request: it names the scope's wallet and forwards the rest to the Worker.
 * `save` stands in for Background's sealed-record storage: it keeps each record in `saved`,
 * under the account's scope key.
 */
export function createInProcessDkgPort(
  handler: VaultDkgRpcHandler,
  saved = new Map<string, SealedVaultRecord>()
): DkgPort {
  const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
  async function call<M extends VaultDkgMethod>(
    method: M,
    request: VaultDkgSchema[M]['request']
  ): Promise<VaultDkgSchema[M]['response']> {
    return roundTrip(await handler.handle(method, roundTrip(request)))
  }
  return {
    open: request =>
      call('vault.dkg.open', {
        participants: request.participants,
        threshold: request.threshold,
        mainnet: request.mainnet,
        ownerWalletId: request.scope.walletId,
        groupId: request.groupId,
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId })
      }),
    acceptRound1: request => call('vault.dkg.acceptRound1', request),
    acceptRound2: request => call('vault.dkg.acceptRound2', request),
    confirmRound1: async request => {
      await call('vault.dkg.confirmRound1', request)
    },
    close: async request => {
      await call('vault.dkg.close', request)
    },
    save: async request => {
      saved.set(multisigGroupScopeKey(request.scope), roundTrip(request.record))
    }
  }
}
