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

  test('accepts the canonical transaction echoed by the current engine', async () => {
    const adapted = await adaptPreparedSigning(
      {
        ...rawPrepared(checksumContract),
        transaction: { ...transaction, to: checksumContract }
      },
      payload,
      'signing-command:echo',
      1_800_000_000_000
    )

    expect(adapted.prepared.summary).toMatchObject({
      schema: 'evm.transaction.v1',
      fields: {
        to: lowercaseContract,
        valueWei: '0',
        methodSelector: '0xa9059cbb'
      }
    })
  })

  test('rejects an echoed transaction that diverges from the reviewed input', async () => {
    const mismatches = [
      { value: '1' },
      { nonce: '1' },
      { gasLimit: '21000' },
      { maxFeePerGas: '6000000000' },
      { maxPriorityFeePerGas: '2000000000' },
      { input: `0xa9059cbb${'0'.repeat(64)}${'2'.padStart(64, '0')}` },
      { chainId: '80094' },
      {
        accessList: [
          {
            address: checksumContract,
            storageKeys: [`0x${'11'.repeat(32)}`]
          }
        ]
      }
    ]
    for (const change of mismatches) {
      await expect(
        adaptPreparedSigning(
          {
            ...rawPrepared(),
            transaction: { ...transaction, to: checksumContract, ...change }
          },
          payload,
          'signing-command:echo-mismatch',
          1_800_000_000_000
        )
      ).rejects.toThrow(/does not match its input/)
    }

    await expect(
      adaptPreparedSigning(
        {
          ...rawPrepared(),
          transaction: {
            type: 'eip2930',
            chainId: transaction.chainId,
            nonce: transaction.nonce,
            gasPrice: '5000000000',
            gasLimit: transaction.gasLimit,
            to: checksumContract,
            value: transaction.value,
            input: transaction.input,
            accessList: transaction.accessList
          }
        },
        payload,
        'signing-command:echo-type',
        1_800_000_000_000
      )
    ).rejects.toThrow(/does not match its input/)
  })

  test('rejects an unexpected field beside the optional echoed transaction', async () => {
    await expect(
      adaptPreparedSigning(
        { ...rawPrepared(), unexpected: true },
        payload,
        'signing-command:extra',
        1_800_000_000_000
      )
    ).rejects.toThrow(/unknown field/)
  })
})

test.describe('PEA EVM signing adapter transaction echo', () => {
  const peaAccount = {
    address: '0x27B25a8B03F9b80bB7c8Ea8bBa3F826Da0C0C530',
    publicKey: '0x03b4d06703b1d2eabf4adc7aa44289d6ea55d954c6099a3befbff7b3781b297708',
    curve: 'secp256k1',
    derivationScheme: 'pea_v1',
    parent: { addressIndex: 0 },
    executionChainId: 'eip155:1',
    accountId: 'eip155:1:0x27B25a8B03F9b80bB7c8Ea8bBa3F826Da0C0C530'
  }
  const peaPayload = {
    kind: 'pea-evm-transaction',
    chainId: 'eip155:1',
    addressIndex: 0,
    transaction
  }

  function peaPrepared(echoedTransaction) {
    const prepared = rawPrepared(checksumContract)
    return {
      ...prepared,
      account: peaAccount,
      summary: { ...prepared.summary, from: peaAccount.address },
      ...(echoedTransaction === undefined ? {} : { transaction: echoedTransaction })
    }
  }

  test('accepts a missing or matching echoed PEA EVM transaction', async () => {
    const omitted = await adaptPreparedSigning(
      peaPrepared(),
      peaPayload,
      'signing-command:pea-omit',
      1_800_000_000_000
    )
    const echoed = await adaptPreparedSigning(
      peaPrepared({ ...transaction, to: checksumContract }),
      peaPayload,
      'signing-command:pea-echo',
      1_800_000_000_000
    )

    for (const adapted of [omitted, echoed]) {
      expect(adapted.prepared.summary).toMatchObject({
        schema: 'evm.transaction.v1',
        fields: { from: peaAccount.address, to: lowercaseContract, valueWei: '0' }
      })
    }
  })

  test('rejects an echoed PEA EVM transaction that diverges from the reviewed input', async () => {
    await expect(
      adaptPreparedSigning(
        peaPrepared({
          ...transaction,
          to: checksumContract,
          accessList: [
            {
              address: '0x0000000000000000000000000000000000000001',
              storageKeys: []
            }
          ]
        }),
        peaPayload,
        'signing-command:pea-mismatch',
        1_800_000_000_000
      )
    ).rejects.toThrow(/does not match its input/)
  })
})
