import { NoirShieldSDK } from '@noir-wallet/shield-sdk'

const sdk = new NoirShieldSDK()

export async function restoreExample(operationId: string) {
  await sdk.connect()
  return sdk.getTransactionStatus({
    layer: 'near-confidential',
    operationId
  })
}
