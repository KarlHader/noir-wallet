import { test } from 'node:test'
import { expect } from '@playwright/test'

import { adaptPreparedSigning } from '../../../../src/infrastructure/keyring/multichain/signing-adapter.ts'

const account = {
  accountId: 'eip155:1:0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
  address: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
  derivationPath: "m/44'/60'/0'/0/0",
  publicKey: '0x0237b0bb7a8288d38ed49a524b5dc98cff3eb5ca824c9f9dc0dfdb3d9cd600f299',
  curve: 'secp256k1',
  addressScheme: 'evm',
  derivationScheme: 'bip44'
}
const checksumContract = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const lowercaseContract = checksumContract.toLowerCase()
const input = `0xa9059cbb${'0'.repeat(63)}1${'0'.repeat(58)}0f4240`
const transaction = {
  type: 'eip1559',
  chainId: '1',
  nonce: '0',
  maxFeePerGas: '5000000000',
  maxPriorityFeePerGas: '1000000000',
  gasLimit: '65000',
  to: lowercaseContract,
  value: '0',
  input,
  accessList: []
}

function rawPrepared(to = checksumContract) {
  return {
    requestId: 1,
    account,
    signingHash: '0xdcdde2a42022dfd9e650ea05d004c3b0bf8238e19a4b9472643160af7221bdfe',
    summary: {
      transactionType: 'eip1559',
      chainId: 'eip155:1',
      from: account.address,
      to,
      valueWei: '0',
      gasLimit: '65000',
      maximumFeeWei: '325000000000000',
      calldataBytes: 68,
      methodSelector: '0xa9059cbb'
    }
  }
}

const payload = {
  kind: 'evm-transaction',
  chainId: 'eip155:1',
  addressIndex: 0,
  transaction
}

test.describe('EVM signing adapter address binding', () => {
  test('accepts checksum normalization without weakening byte-equivalent address binding', async () => {
    const adapted = await adaptPreparedSigning(
      rawPrepared(),
      payload,
      'signing-command:1',
      1_800_000_000_000
    )

    expect(adapted.prepared.summary).toMatchObject({
      schema: 'evm.transaction.v1',
      review: { level: 'caution', issues: [{ code: 'unrecognized-call' }] },
      fields: {
        to: lowercaseContract,
        methodSelector: '0xa9059cbb',
        maximumFeeWei: '325000000000000'
      }
    })
  })

  test('still rejects a different EVM destination', async () => {
    await expect(
      adaptPreparedSigning(
        rawPrepared('0x0000000000000000000000000000000000000001'),
        payload,
        'signing-command:2',
        1_800_000_000_000
      )
    ).rejects.toThrow(/summary does not match/)
  })

  test('binds an imported private-key signer to index zero without inventing an HD path', async () => {
    const importedAccount = {
      ...account,
      accountId: 'eip155:1:0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
      address: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
      derivationPath: 'm',
      publicKey: '0x0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
      derivationScheme: 'imported'
    }
    const prepared = rawPrepared()
    const adapted = await adaptPreparedSigning(
      {
        ...prepared,
        account: importedAccount,
        summary: { ...prepared.summary, from: importedAccount.address }
      },
      payload,
      'signing-command:imported',
      1_800_000_000_000,
      undefined,
      true
    )

    expect(adapted.account).toMatchObject({ derivationScheme: 'imported', derivationPath: 'm' })
  })
})
