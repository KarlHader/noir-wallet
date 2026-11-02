import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createAssetRegistry,
  createEvmBitcoinChainRegistry,
  getBundledEvmAssetDefinitions,
  parseChainId
} from '../../../../src/core/chains/registry/index.ts'
import {
  parseTransactionId,
  parseTransactionSegmentId
} from '../../../../src/core/transactions/domain/index.ts'
import {
  buildEvmTransfer,
  createEvmTransferGraph,
  EvmTransactionError
} from '../../../../src/infrastructure/chains/evm/index.ts'
import { mapEvmWalletRuntimeError } from '../../../../src/background/evm-wallet-runtime-error.ts'
import { getEvmSendPrepareError } from '../../../../src/popup/pages/transactions/evm-send-validation.ts'
import { EvmWalletClientError } from '../../../../src/popup/services/evm-wallet-client.ts'

const chainId = parseChainId('eip155:1').id
const tokenId = `${chainId}/erc20:0x3333333333333333333333333333333333333333`
const nativeId = `${chainId}/slip44:60`
const sender = '0x1111111111111111111111111111111111111111'
const recipient = '0x2222222222222222222222222222222222222222'
const account = {
  id: 'chain-account:evm:2',
  scope: { keyDomainId: 'key-domain:0', accountId: 'account:2', chainId },
  derivation: { scheme: 'bip44', path: "m/44'/60'/0'/0/2" },
  identity: { kind: 'account-identifier', value: sender },
  createdAt: 1
}
const bundled = getBundledEvmAssetDefinitions('mainnet')
const chains = createEvmBitcoinChainRegistry('mainnet')
const unverified = {
  chainId,
  namespace: 'erc20',
  reference: tokenId.split(':').at(-1),
  kind: 'token',
  metadata: { name: 'Detected Token', symbol: 'USDC', decimals: 6 },
  source: 'discovered',
  verification: 'unverified'
}
const rpc = {
  assertExpectedChain: async () => {},
  getNativeBalance: async () => '1000000000000000000',
  getPendingNonce: async () => '7',
  simulateCall: async () => '0x',
  estimateGas: async () => '70000',
  getMaximumPriorityFeePerGas: async () => '1000000000',
  getLatestBlockFee: async () => ({ blockNumber: '100', baseFeePerGas: '2000000000' })
}

function registry(entry) {
  return createAssetRegistry(chains, [...bundled, ...(entry ? [entry] : [])])
}

test('explicit transfer accepts a registered unverified ERC20 without promoting its metadata', async () => {
  const assets = registry(unverified)
  assert.equal(assets.get(tokenId), undefined)
  assert.equal(assets.inspect(tokenId)?.verification, 'unverified')
  assert.throws(() => assets.resolve(tokenId), /not listed/i)

  const prepared = await buildEvmTransfer({
    chainId,
    chainAccount: account,
    assets,
    intent: { assetId: tokenId, recipient, amountRaw: '500000' },
    rpc,
    now: () => 10
  })
  assert.equal(prepared.kind, 'erc20-transfer')
  assert.equal(prepared.transaction.to, unverified.reference)

  const graph = createEvmTransferGraph({
    prepared,
    scope: account.scope,
    transactionId: parseTransactionId('transaction:evm:detected-token'),
    segmentId: parseTransactionSegmentId('segment:evm:detected-token'),
    chainAccountId: account.id,
    assets
  })
  assert.deepEqual(graph.root.intent?.primaryAmount, {
    assetId: tokenId,
    amountRaw: '500000'
  })
  assert.equal(graph.root.intent?.feeLimit?.assetId, nativeId)
  assert.equal(assets.get(nativeId)?.verification, 'trusted')
})

test('unregistered and blocked tokens remain unavailable for transfer', async () => {
  for (const assets of [registry(), registry({ ...unverified, verification: 'blocked' })]) {
    await assert.rejects(
      buildEvmTransfer({
        chainId,
        chainAccount: account,
        assets,
        intent: { assetId: tokenId, recipient, amountRaw: '1' },
        rpc
      }),
      error => error instanceof EvmTransactionError && error.code === 'invalid-intent'
    )
  }
})

test('unverified ERC20 does not become a contract-call or fee asset', async () => {
  const assets = registry(unverified)
  const prepared = await buildEvmTransfer({
    chainId,
    chainAccount: account,
    assets,
    intent: { assetId: tokenId, recipient, amountRaw: '1' },
    rpc,
    now: () => 10
  })
  assert.throws(
    () =>
      createEvmTransferGraph({
        prepared: { ...prepared, kind: 'contract-call' },
        scope: account.scope,
        transactionId: parseTransactionId('transaction:evm:invalid-call'),
        segmentId: parseTransactionSegmentId('segment:evm:invalid-call'),
        assets
      }),
    /does not match its chain/
  )
})

test('unknown transfer asset reports its cause in Send', () => {
  const runtimeError = mapEvmWalletRuntimeError(
    new EvmTransactionError('invalid-intent', 'EVM transfer asset is not listed')
  )
  assert.equal(runtimeError.code, 'asset-unavailable')
  assert.equal(
    getEvmSendPrepareError(
      new EvmWalletClientError(runtimeError.code, runtimeError.message),
      'main'
    ),
    'This asset is unavailable for sending.'
  )
})
