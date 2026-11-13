import assert from 'node:assert/strict'
import { it } from 'node:test'

import {
  StarknetUndeployedAccountError,
  quoteStarknetDAppInvoke
} from '../../../../src/infrastructure/chains/starknet/starknet-transfer-preparer.ts'
import {
  STARKNET_ARGENT_V04_CLASS_HASH,
  STARKNET_ARGENT_V05_CLASS_HASH
} from '../../../../src/infrastructure/chains/starknet/starknet-primitives.ts'
import { normalizeStarknetFelt } from '../../../../src/core/chains/starknet/identifiers.ts'

const FEE_ESTIMATE = Object.freeze({
  l1GasConsumed: 1n,
  l1GasPrice: 1n,
  l2GasConsumed: 1n,
  l2GasPrice: 1n,
  l1DataGasConsumed: 1n,
  l1DataGasPrice: 1n,
  overallFee: 1n
})

function account(classHash, chainId = 'starknet:SN_SEPOLIA') {
  return {
    chainId,
    address: '0x58ac366fa8dc98e25a85c7343bcca64324c2e7e65c017785c363d1066ce072a',
    publicKey: '0x7f0ecd1ec6159e6a7c70084aaa7d693d9113149b80ab72618602a185e2c1f2b',
    classHash
  }
}

const CALL = Object.freeze({
  to: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
  selector: '0x83afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e',
  calldata: Object.freeze([
    '0x58ac366fa8dc98e25a85c7343bcca64324c2e7e65c017785c363d1066ce072a',
    '0x1',
    '0x0'
  ])
})

function preparation(payload, signingHash, kind) {
  const summary =
    kind === 'deploy'
      ? {
          contractAddress: payload.accountAddress,
          classHash: payload.classHash,
          salt: payload.publicKey,
          constructorCalldata:
            payload.implementation === 'argent_v04'
              ? ['0x0', payload.publicKey, '0x1']
              : [payload.publicKey],
          nonce: payload.nonce,
          tip: '0',
          resourceBounds: payload.resourceBounds,
          nonceDataAvailabilityMode: 'l1',
          feeDataAvailabilityMode: 'l1'
        }
      : {
          senderAddress: payload.accountAddress,
          nonce: payload.nonce,
          tip: '0',
          resourceBounds: payload.resourceBounds,
          calls: payload.calls.map(call => ({
            to: call.to,
            selector: call.selector,
            entrypoint: null,
            calldata: [...call.calldata]
          })),
          nonceDataAvailabilityMode: 'l1',
          feeDataAvailabilityMode: 'l1'
        }
  return {
    account: { address: payload.accountAddress, implementation: payload.implementation },
    signingHash,
    summary
  }
}

function builder() {
  let sequence = 0
  return {
    async prepareInvoke(payload) {
      sequence += 1
      return preparation(payload, `0x${sequence.toString(16)}`, 'invoke')
    },
    async prepareDeploy(payload) {
      sequence += 1
      return preparation(payload, `0x${sequence.toString(16)}`, 'deploy')
    }
  }
}

function rpc(deployment) {
  return {
    async getClassHashAt() {
      return deployment.classHash
    },
    async getNonce() {
      return deployment.nonce
    },
    async estimateFees(transactions) {
      return transactions.map(() => FEE_ESTIMATE)
    }
  }
}

it('quotes a deploy plus invoke for an undeployed Argent v0.4 dApp account', async () => {
  const quoted = await quoteStarknetDAppInvoke({
    rpc: rpc({ classHash: null, nonce: 0n }),
    builder: builder(),
    account: account(STARKNET_ARGENT_V04_CLASS_HASH),
    calls: [CALL]
  })
  assert.ok(quoted.deploy)
  assert.equal(quoted.deploy.nonce, '0x0')
  assert.equal(quoted.invoke.nonce, '0x1')
  assert.equal(quoted.deploy.unsigned.query, false)
  assert.equal(quoted.invoke.unsigned.query, false)
})

it('rejects an undeployed Argent v0.5 dApp account before approval', async () => {
  await assert.rejects(
    quoteStarknetDAppInvoke({
      rpc: rpc({ classHash: null, nonce: 0n }),
      builder: builder(),
      account: account(STARKNET_ARGENT_V05_CLASS_HASH),
      calls: [CALL]
    }),
    StarknetUndeployedAccountError
  )
})

it('quotes a single invoke for a deployed dApp account', async () => {
  const quoted = await quoteStarknetDAppInvoke({
    rpc: rpc({ classHash: normalizeStarknetFelt(STARKNET_ARGENT_V04_CLASS_HASH), nonce: 5n }),
    builder: builder(),
    account: account(STARKNET_ARGENT_V04_CLASS_HASH),
    calls: [CALL]
  })
  assert.equal(quoted.deploy, null)
  assert.equal(quoted.invoke.nonce, '0x5')
})
