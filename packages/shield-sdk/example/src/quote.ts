import { NoirShieldSDK } from '@noir-wallet/shield-sdk'

const sdk = new NoirShieldSDK()

export async function quoteExample() {
  await sdk.connect()
  return sdk.getQuote({
    layer: 'near-confidential',
    action: 'receive',
    source: { chainId: 56, assetId: 'eip155:56/slip44:714' },
    amount: '0.10'
  })
}
