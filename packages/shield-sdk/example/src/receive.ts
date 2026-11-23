import { NoirShieldSDK } from '@noir-wallet/shield-sdk'

const sdk = new NoirShieldSDK()

export async function receiveExample() {
  await sdk.connect()
  const receive = await sdk.shield.receive({
    layer: 'near-confidential',
    source: { chainId: 56, assetId: 'eip155:56/slip44:714' },
    amount: '0.10'
  })
  return receive.wait()
}
