import { test } from 'node:test'
import { expect } from '@playwright/test'
import { secp256k1 } from '@noble/curves/secp256k1'
import { keccak256, parseTransaction, serializeTransaction } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import {
  assertSignedEvmTransactionMatchesPrepared,
  createKeystoneSignedEvmTransaction,
  serializePreparedEvmUnsignedTransaction
} from '../../../../src/infrastructure/chains/evm/index.ts'

const rawTransaction =
  '0x02f86b0107843b9aca0085012a05f2008252089422222222222222222222222222222222222222227b80c080a0b3864790b628687b4183843c86fe33325a02749ef708c28741fda66071423046a05d8f511cd36527e24f1f5e2ebfd42cfed9b0d3c4fdfd772e3bac5d9b40bf441b'
const transactionHash = '0xaab6356f54167f2353969e09cccd67316f939a3a118923245b6a015c8b9a701e'
const pinnedWasmSepoliaRawTransaction =
  '0x02f87483aa36a780843b9aca0084b2d05e0082520894111111111111111111111111111111111111111187038d7ea4c6800080c080a0d73b7d734fd8cd95582e580a9e417249fb38b40da89a51ee4db69eef0d912e2ca02374d3c8731434686aa7729b799bb55f27bb0690fcefb548d18f1b651c7d4c0f'
const pinnedWasmSepoliaTransactionHash =
  '0xffa4955c0ebfc05dbf601618fcc91039e3b34e62a20d18c15a166572e389b3e4'
const prepared = {
  kind: 'native-transfer',
  chainId: 'eip155:1',
  addressIndex: 0,
  from: '0x1a642f0e3c3af545e7acbd38b07251b3990914f1',
  assetId: 'eip155:1/slip44:60',
  recipient: '0x2222222222222222222222222222222222222222',
  amountRaw: '123',
  observedBlockNumber: '100',
  transaction: {
    type: 'eip1559',
    chainId: '1',
    nonce: '7',
    maxFeePerGas: '5000000000',
    maxPriorityFeePerGas: '1000000000',
    gasLimit: '21000',
    to: '0x2222222222222222222222222222222222222222',
    value: '123',
    input: '0x',
    accessList: []
  },
  createdAt: 1_000
}

function verify(value = prepared, hash = transactionHash, raw = rawTransaction) {
  return assertSignedEvmTransactionMatchesPrepared(value, {
    rawTransaction: raw,
    transactionHash: hash
  })
}

test.describe('signed EVM transaction host verification', () => {
  test('serializes the Keystone signing payload and rebuilds the pinned signed transaction', async () => {
    const decoded = parseTransaction(rawTransaction)
    if (decoded.r === undefined || decoded.s === undefined || decoded.yParity === undefined) {
      throw new Error('The fixed signed transaction is missing signature fields')
    }
    expect(serializePreparedEvmUnsignedTransaction(prepared)).toBe(
      '0x02e80107843b9aca0085012a05f2008252089422222222222222222222222222222222222222227b80c0'
    )
    await expect(
      createKeystoneSignedEvmTransaction(
        prepared,
        `${decoded.r}${decoded.s.slice(2)}${decoded.yParity.toString(16).padStart(2, '0')}`
      )
    ).resolves.toEqual({ rawTransaction, transactionHash })
  })

  test('rejects a Keystone signature with a different recovery ID or malformed envelope', async () => {
    const decoded = parseTransaction(rawTransaction)
    if (decoded.r === undefined || decoded.s === undefined || decoded.yParity === undefined) {
      throw new Error('The fixed signed transaction is missing signature fields')
    }
    const signature = `${decoded.r}${decoded.s.slice(2)}`
    await expect(
      createKeystoneSignedEvmTransaction(
        prepared,
        `${signature}${decoded.yParity === 0 ? '01' : '00'}`
      )
    ).rejects.toThrow(/integrity validation/)
    await expect(createKeystoneSignedEvmTransaction(prepared, '0x1234')).rejects.toThrow(
      /integrity validation/
    )
  })

  test('independently binds the canonical raw transaction, hash, signer, and reviewed fields', async () => {
    await expect(verify()).resolves.toBeUndefined()
  })

  test('accepts the pinned WASM Sepolia signer vector used by the real MV3 flow', async () => {
    await expect(
      verify(
        {
          ...prepared,
          chainId: 'eip155:11155111',
          from: '0xf278cf59f82edcf871d630f28ecc8056f25c1cdb',
          assetId: 'eip155:11155111/slip44:60',
          recipient: '0x1111111111111111111111111111111111111111',
          amountRaw: '1000000000000000',
          transaction: {
            ...prepared.transaction,
            chainId: '11155111',
            nonce: '0',
            maxFeePerGas: '3000000000',
            gasLimit: '21000',
            to: '0x1111111111111111111111111111111111111111',
            value: '1000000000000000'
          }
        },
        pinnedWasmSepoliaTransactionHash,
        pinnedWasmSepoliaRawTransaction
      )
    ).resolves.toBeUndefined()
  })

  test('normalizes the omitted decoded zero value used by ERC-20 transactions', async () => {
    const account = privateKeyToAccount(`0x${'01'.repeat(32)}`)
    const input = `0xa9059cbb${prepared.recipient.slice(2).padStart(64, '0')}${'1'.padStart(64, '0')}`
    const tokenPrepared = {
      ...prepared,
      kind: 'erc20-transfer',
      from: account.address,
      assetId: 'eip155:1/erc20:0x3333333333333333333333333333333333333333',
      amountRaw: '1',
      transaction: {
        ...prepared.transaction,
        nonce: '0',
        gasLimit: '70000',
        to: '0x3333333333333333333333333333333333333333',
        value: '0',
        input
      }
    }
    const raw = await account.signTransaction({
      type: 'eip1559',
      chainId: 1,
      nonce: 0,
      maxFeePerGas: 5_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      gas: 70_000n,
      to: tokenPrepared.transaction.to,
      value: 0n,
      data: input
    })

    expect(parseTransaction(raw).value).toBeUndefined()
    await expect(
      assertSignedEvmTransactionMatchesPrepared(tokenPrepared, {
        rawTransaction: raw,
        transactionHash: keccak256(raw)
      })
    ).resolves.toBeUndefined()
  })

  test('rejects a WASM-provided hash that is not the hash of the signed raw transaction', async () => {
    await expect(verify(prepared, `0x${'b'.repeat(64)}`)).rejects.toThrow(/integrity validation/)
  })

  test('rejects a valid signature from a different reviewed account', async () => {
    await expect(
      verify({
        ...prepared,
        from: '0x3333333333333333333333333333333333333333'
      })
    ).rejects.toThrow(/integrity validation/)
  })

  test('rejects a high-S transaction even when it recovers the reviewed signer', async () => {
    const decoded = parseTransaction(rawTransaction)
    if (decoded.s === undefined || decoded.yParity === undefined) {
      throw new Error('The fixed signed transaction is missing signature fields')
    }
    const highS = `0x${(secp256k1.CURVE.n - BigInt(decoded.s)).toString(16).padStart(64, '0')}`
    const highSRawTransaction = serializeTransaction({
      ...decoded,
      s: highS,
      yParity: decoded.yParity === 0 ? 1 : 0,
      v: decoded.yParity === 0 ? 28n : 27n
    })
    await expect(
      verify(prepared, keccak256(highSRawTransaction), highSRawTransaction)
    ).rejects.toThrow(/integrity validation/)
  })

  test('rejects any change to the reviewed EIP-1559 payload', async () => {
    for (const transaction of [
      { ...prepared.transaction, chainId: '11155111' },
      { ...prepared.transaction, nonce: '8' },
      { ...prepared.transaction, maxFeePerGas: '5000000001' },
      { ...prepared.transaction, maxPriorityFeePerGas: '1000000001' },
      { ...prepared.transaction, gasLimit: '21001' },
      { ...prepared.transaction, to: '0x3333333333333333333333333333333333333333' },
      { ...prepared.transaction, value: '124' },
      { ...prepared.transaction, input: '0x00' }
    ]) {
      await expect(verify({ ...prepared, transaction })).rejects.toThrow(/integrity validation/)
    }
  })

  test('rejects malformed, non-canonical, and oversized raw transactions', async () => {
    await expect(verify(prepared, transactionHash, '0x1234')).rejects.toThrow(
      /integrity validation/
    )
    await expect(verify(prepared, transactionHash, rawTransaction.toUpperCase())).rejects.toThrow(
      /integrity validation/
    )
    await expect(
      verify(prepared, transactionHash, `0x02${'00'.repeat(128 * 1024 + 1)}`)
    ).rejects.toThrow(/integrity validation/)
  })
})
