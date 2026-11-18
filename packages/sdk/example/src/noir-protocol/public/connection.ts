import type { Caip25CreateSessionRequest, Caip25Session } from '@noir-wallet/sdk'
import { PUBLIC_SESSION_METHODS } from '@noir-wallet/sdk'
import { EVM_NETWORK_EXAMPLES, getEvmNetworkExampleMode } from '../../evm-network-catalog'

export type PublicChain = 'auto' | 'evm' | 'zcash'
export type PublicAccountChain = Exclude<PublicChain, 'auto'>
export type ZcashNetwork = 'mainnet' | 'testnet'

const ZCASH_SCOPES: Readonly<Record<ZcashNetwork, string>> = {
  mainnet: 'bip122:00040fe8ec8471911baa1db1266ea15d',
  testnet: 'bip122:05a60a92d99d85997cce3b87616c089f'
}
const EVM_SESSION_METHODS = [...PUBLIC_SESSION_METHODS, 'eth_chainId']

export interface PublicConnection {
  readonly chain: PublicAccountChain
  readonly scope: string
  readonly accounts: readonly string[]
}

export function zcashPublicScope(network: ZcashNetwork): string {
  return ZCASH_SCOPES[network]
}

export function evmPublicScope(chainId: unknown): string {
  if (typeof chainId !== 'string' || !/^0x[0-9a-f]+$/i.test(chainId)) {
    throw new Error('Invalid EVM chain ID')
  }
  const id = BigInt(chainId)
  if (id === 0n) throw new Error('Invalid EVM chain ID')
  return `eip155:${id}`
}

export function publicChainForScope(scope: string): PublicAccountChain | null {
  if (/^eip155:[1-9][0-9]*$/.test(scope)) return 'evm'
  return Object.values(ZCASH_SCOPES).includes(scope) ? 'zcash' : null
}

export function zcashNetworkForScope(scope: string): ZcashNetwork | null {
  if (scope === ZCASH_SCOPES.mainnet) return 'mainnet'
  if (scope === ZCASH_SCOPES.testnet) return 'testnet'
  return null
}

export function assertPublicMainnet(currentEvmChainId: string | null): void {
  if (!currentEvmChainId) return
  const currentScope = evmPublicScope(currentEvmChainId)
  const canonicalChainId = `0x${BigInt(currentScope.slice(7)).toString(16)}`
  if (getEvmNetworkExampleMode(canonicalChainId) === 'testnet') {
    throw new Error('Public is unavailable on Testnet.')
  }
}

export function autoPublicScopes(currentEvmChainId: string | null): readonly string[] {
  assertPublicMainnet(currentEvmChainId)
  if (!currentEvmChainId) return [zcashPublicScope('mainnet')]
  const currentScope = evmPublicScope(currentEvmChainId)
  const canonicalChainId = `0x${BigInt(currentScope.slice(7)).toString(16)}`
  const mode = getEvmNetworkExampleMode(canonicalChainId)
  const evmScopes = mode
    ? EVM_NETWORK_EXAMPLES.filter(network => network.mode === 'mainnet').map(network =>
        evmPublicScope(network.request.chainId)
      )
    : []
  return [...new Set([currentScope, ...evmScopes]), zcashPublicScope('mainnet')]
}

export function buildPublicSessionRequest(scopes: readonly string[]): Caip25CreateSessionRequest {
  const unique = [...new Set(scopes)]
  if (
    unique.length === 0 ||
    unique.length > 16 ||
    unique.some(scope => !publicChainForScope(scope))
  ) {
    throw new Error('Invalid Public chain selection')
  }
  return {
    scopes: Object.fromEntries(
      unique.map(scope => [
        scope,
        {
          methods:
            publicChainForScope(scope) === 'evm' ? EVM_SESSION_METHODS : PUBLIC_SESSION_METHODS,
          notifications:
            publicChainForScope(scope) === 'evm'
              ? ['wallet_sessionChanged', 'accountsChanged', 'chainChanged']
              : ['wallet_sessionChanged', 'accountsChanged']
        }
      ])
    )
  }
}

export function publicSessionConnections(session: Caip25Session | null): PublicConnection[] {
  return Object.keys(session?.scopes ?? {}).flatMap(scope => {
    const connection = readPublicConnection(session, scope)
    return connection ? [connection] : []
  })
}

export function readPublicConnection(
  session: Caip25Session | null,
  scope: string
): PublicConnection | null {
  const chain = publicChainForScope(scope)
  const granted = session?.scopes[scope]
  const requiredMethods = chain === 'evm' ? EVM_SESSION_METHODS : PUBLIC_SESSION_METHODS
  if (!granted || !requiredMethods.every(method => granted.methods.includes(method))) return null
  const accounts = granted.accounts.filter(
    account => account.startsWith(`${scope}:`) && account.length > scope.length + 1
  )
  return chain && accounts?.length ? { chain, scope, accounts } : null
}
