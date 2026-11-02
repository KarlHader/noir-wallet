import assert from 'node:assert/strict'
import { it } from 'node:test'
import {
  createAssetRegistry,
  createEvmBitcoinChainRegistry,
  getBundledEvmAssetDefinitions
} from '../../../../src/core/chains/registry/index.ts'
import {
  buildEvmContractCall,
  buildEvmTransfer,
  createEvmSigningPreparePayload,
  createEvmSigningSummary
} from '../../../../src/infrastructure/chains/evm/evm-transaction-builder.ts'

const chainId = 'eip155:1'
const address = '0x1111111111111111111111111111111111111111'
const recipient = '0x2222222222222222222222222222222222222222'
const gateway = '0xd01607c3c5ecaba394d8be377a08590149325722'
const pool = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2'
const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const assets = createAssetRegistry(
  createEvmBitcoinChainRegistry('mainnet'),
  getBundledEvmAssetDefinitions('mainnet')
)
const chainAccount = {
  id: 'chain-account:gas-limit',
  scope: { keyDomainId: 'key-domain:gas-limit', accountId: 'account:gas-limit', chainId },
  derivation: { scheme: 'bip44', path: "m/44'/60'/0'/0/0" },
  identity: { kind: 'account-identifier', value: address },
  createdAt: 1
}

function rpc(overrides = {}) {
  return {
    assertExpectedChain: async () => {},
    getNativeBalance: async () => '1000000000000000000',
    getPendingNonce: async () => '7',
    simulateCall: async () => '0x',
    estimateGas: async () => '223082',
    getMaximumPriorityFeePerGas: async () => '1000000000',
    getLatestBlockFee: async () => ({ blockNumber: '100', baseFeePerGas: '2000000000' }),
    ...overrides
  }
}

const aaveWithdrawal = {
  chainId,
  contractAddress: gateway,
  valueRaw: '0',
  calldata: `0x80500d20${pool.slice(2).padStart(64, '0')}${'f'.repeat(64)}${address.slice(2).padStart(64, '0')}`
}

it('budgets enough gas for the observed Aave withdrawETH execution and binds its review', async () => {
  const prepared = await buildEvmContractCall({
    chainId,
    chainAccount,
    assets,
    intent: aaveWithdrawal,
    rpc: rpc()
  })
  assert.equal(prepared.transaction.gasLimit, '267699')
  assert.ok(BigInt(prepared.transaction.gasLimit) > 230811n)
  assert.equal(createEvmSigningPreparePayload(prepared, 'private').transaction.gasLimit, '267699')
  const summary = await createEvmSigningSummary(prepared)
  assert.equal(summary.fields.gasLimit, '267699')
  assert.equal(summary.fields.maximumFeeWei, '1338495000000000')
})

it('keeps a simple native transfer at 21000 and pads dynamic native and ERC-20 execution', async () => {
  const nativeInput = {
    chainId,
    chainAccount,
    assets,
    intent: { assetId: 'eip155:1/slip44:60', recipient, amountRaw: '1' }
  }
  const simple = await buildEvmTransfer({
    ...nativeInput,
    rpc: rpc({ estimateGas: async () => '21000' })
  })
  assert.equal(simple.transaction.gasLimit, '21000')

  const dynamic = await buildEvmTransfer({
    ...nativeInput,
    rpc: rpc({ estimateGas: async () => '21001' })
  })
  assert.equal(dynamic.transaction.gasLimit, '25202')

  const token = await buildEvmTransfer({
    chainId,
    chainAccount,
    assets,
    intent: { assetId: `${chainId}/erc20:${usdc}`, recipient, amountRaw: '1' },
    rpc: rpc({ estimateGas: async () => '65000' })
  })
  assert.equal(token.transaction.gasLimit, '78000')
})

it('checks funds against the padded maximum and rejects gas limits beyond the signer range', async () => {
  const available = 223082n * 5000000000n
  await assert.rejects(
    buildEvmContractCall({
      chainId,
      chainAccount,
      assets,
      intent: aaveWithdrawal,
      rpc: rpc({ getNativeBalance: async () => available.toString() })
    }),
    error => {
      assert.equal(error.code, 'insufficient-funds')
      assert.deepEqual(error.insufficientFunds, {
        requiredNativeBalanceRaw: '1338495000000000',
        availableNativeBalanceRaw: available.toString(),
        shortfallRaw: (267699n * 5000000000n - available).toString(),
        maximumGasCostRaw: '1338495000000000',
        transactionValueRaw: '0'
      })
      return true
    }
  )

  await assert.rejects(
    buildEvmContractCall({
      chainId,
      chainAccount,
      assets,
      intent: aaveWithdrawal,
      rpc: rpc({ estimateGas: async () => ((1n << 64n) - 1n).toString() })
    }),
    error => error.code === 'fee-overflow'
  )
})
