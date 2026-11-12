import type { Caip25CreateSessionRequest, NoirWalletProvider } from '@noir-wallet/sdk'

export function buildExampleMultichainSessionRequest(
  wallet: NoirWalletProvider,
  networkMode: 'mainnet' | 'testnet',
  evmChainIdHex: string
): Caip25CreateSessionRequest {
  const zcashChainId =
    networkMode === 'mainnet'
      ? 'bip122:00040fe8ec8471911baa1db1266ea15d'
      : 'bip122:05a60a92d99d85997cce3b87616c089f'
  const bitcoinChainId =
    networkMode === 'mainnet'
      ? 'bip122:000000000019d6689c085ae165831e93'
      : 'bip122:000000000933ea01ad0ee984209779ba'
  const dashChainId =
    networkMode === 'mainnet'
      ? 'bip122:00000ffd590b1485b3caadc19b22e637'
      : 'bip122:00000bafbc94add76cb75e2ec9289483'
  const solanaChainId =
    networkMode === 'mainnet'
      ? 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
      : 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
  const nearChainId = networkMode === 'mainnet' ? 'near:mainnet' : 'near:testnet'
  const starknetChainId = networkMode === 'mainnet' ? 'starknet:SN_MAIN' : 'starknet:SN_SEPOLIA'
  const evmChainId = `eip155:${Number.parseInt(evmChainIdHex, 16)}`

  return {
    scopes: {
      [zcashChainId]: {
        methods: [
          'zcash_getAccounts',
          'zcash_getBalance',
          'zcash_sendTransaction',
          'zcash_signMessage'
        ],
        notifications: ['wallet_sessionChanged', 'accountsChanged']
      },
      ...(wallet.ethereum
        ? {
            [evmChainId]: {
              methods: [
                'eth_accounts',
                'eth_sendTransaction',
                'personal_sign',
                'eth_signTypedData_v4'
              ],
              notifications: ['wallet_sessionChanged', 'accountsChanged', 'chainChanged']
            }
          }
        : {}),
      ...(wallet.bitcoin
        ? {
            [bitcoinChainId]: {
              methods: ['getAccounts', 'getBalance', 'sendBitcoin', 'signMessage', 'signPsbt'],
              notifications: ['wallet_sessionChanged', 'accountsChanged', 'networkChanged']
            }
          }
        : {}),
      ...(wallet.dash
        ? {
            [dashChainId]: {
              methods: [
                'getAccounts',
                'getNetwork',
                'getChain',
                'getPublicKey',
                'getBalance',
                'sendDash',
                'signMessage',
                'signPsbt',
                'pushPsbt'
              ],
              notifications: ['wallet_sessionChanged', 'accountsChanged', 'networkChanged']
            }
          }
        : {}),
      ...(wallet.solana
        ? {
            [solanaChainId]: {
              methods: [
                'getAccounts',
                'signTransaction',
                'signAllTransactions',
                'signAndSendTransaction',
                'signMessage'
              ],
              notifications: ['wallet_sessionChanged', 'accountsChanged']
            }
          }
        : {}),
      ...(wallet.near
        ? {
            [nearChainId]: {
              methods: ['getAccounts', 'signTransaction', 'requestSignTransactions', 'signMessage'],
              notifications: ['wallet_sessionChanged', 'accountsChanged']
            }
          }
        : {}),
      ...(wallet.starknet
        ? {
            [starknetChainId]: {
              methods: [
                'wallet_requestAccounts',
                'wallet_getPermissions',
                'wallet_requestChainId',
                'wallet_deploymentData',
                'wallet_addInvokeTransaction',
                'wallet_signTypedData',
                'wallet_switchStarknetChain',
                'wallet_watchAsset',
                'wallet_disconnect'
              ],
              notifications: ['wallet_sessionChanged', 'accountsChanged', 'networkChanged']
            }
          }
        : {})
    },
    properties: { application: 'Noir Wallet SDK Example V2' }
  }
}
