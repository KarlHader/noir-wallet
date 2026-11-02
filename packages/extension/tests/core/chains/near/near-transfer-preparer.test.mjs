import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  assertNearTransferSigningMatchesPrepared,
  computeNearTransactionFingerprint,
  parsePreparedNearLendingSupply,
  prepareNearNativeTransfer,
  prepareNearLendingSupply,
  prepareNearTokenTransfer,
  parsePreparedNearTokenTransfer
} from '../../../../src/infrastructure/chains/near/index.ts'
import { createNearLendingSupplyMessage } from '../../../../src/core/services/lending-near-supply.ts'

const signerId = '00'.repeat(32)
const publicKey = `ed25519:${'1'.repeat(32)}`
const receiverId = 'alice.testnet'
const blockHash = '11111111111111111111111111111111'

function account(accountId, amountRaw = '5000000000000000000000000') {
  return {
    accountId,
    amountRaw,
    lockedRaw: '0',
    storageUsage: 100,
    codeHash: blockHash,
    blockHash,
    blockHeight: 10
  }
}

function harness(overrides = {}) {
  const calls = []
  const rpc = {
    assertExpectedChain: async () => calls.push('attest'),
    getAccount: async accountId => {
      calls.push(`account:${accountId}`)
      return account(accountId)
    },
    getAccessKey: async (accountId, publicKey) => {
      calls.push(`key:${accountId}:${publicKey}`)
      return {
        accountId,
        publicKey,
        nonce: '41',
        permission: { kind: 'full-access' },
        blockHash,
        blockHeight: 10
      }
    },
    getGasPrice: async () => (calls.push('gas-price'), '100000000'),
    getNativeTransferCostConfig: async () => {
      calls.push('costs')
      return {
        chainId: 'near:testnet',
        minGasPurchasePriceRaw: '1000000000',
        storageAmountPerByteRaw: '10000000000000000000',
        actionReceiptCreation: {
          executionGas: '108059500000',
          sendNotSirGas: '108059500000',
          sendSirGas: '108059500000'
        },
        transfer: {
          executionGas: '115123062500',
          sendNotSirGas: '115123062500',
          sendSirGas: '115123062500'
        }
      }
    },
    ...overrides
  }
  return { rpc, calls }
}

test.describe('NEAR native transfer preparation', () => {
  test('binds the final full-access key nonce and protocol-derived fee to the transaction', async () => {
    const state = harness()
    const prepared = await prepareNearNativeTransfer({
      chainId: 'near:testnet',
      accountIndex: 0,
      signerId,
      publicKey,
      receiverId,
      depositYocto: '2000000000000000000000000',
      rpc: state.rpc
    })

    expect(prepared).toEqual({
      chainId: 'near:testnet',
      accountIndex: 0,
      signerId,
      publicKey,
      receiverId,
      depositYocto: '2000000000000000000000000',
      estimatedFeeYocto: '44636512500000000000',
      maximumFeeYocto: '446365125000000000000',
      storageReserveYocto: '1000000000000000000000',
      totalRequiredYocto: '2001446365125000000000000',
      transaction: {
        chainId: 'near:testnet',
        accountIndex: 0,
        signerId,
        receiverId,
        nonce: '42',
        blockHash,
        actions: [{ type: 'transfer', depositYocto: '2000000000000000000000000' }]
      }
    })
    expect(state.calls[0]).toBe('attest')
    expect(state.calls).toContain(`key:${signerId}:${publicKey}`)

    const fingerprint = await computeNearTransactionFingerprint(prepared.transaction)
    const signing = {
      chainId: prepared.chainId,
      operation: 'transaction',
      execution: { kind: 'internal' },
      summary: {
        schema: 'near.transaction.v1',
        review: { level: 'standard', issues: [] },
        fields: {
          signerId,
          publicKey: prepared.publicKey,
          nonce: '42',
          receiverId,
          blockHash,
          actions: [{ kind: 'transfer', depositYocto: prepared.depositYocto }]
        }
      },
      payloadFingerprint: { digestHex: fingerprint }
    }
    await expect(
      assertNearTransferSigningMatchesPrepared(prepared, signing)
    ).resolves.toBeUndefined()
    await expect(
      assertNearTransferSigningMatchesPrepared(prepared, {
        ...signing,
        summary: {
          ...signing.summary,
          fields: { ...signing.summary.fields, receiverId: 'mallory.testnet' }
        }
      })
    ).rejects.toThrow(/does not match/)
  })

  test('fails closed for missing accounts, missing or restricted keys, and reserved balance', async () => {
    const cases = [
      {
        code: 'recipient-not-found',
        overrides: {
          getAccount: async accountId => (accountId === receiverId ? null : account(accountId))
        }
      },
      { code: 'access-key-not-found', overrides: { getAccessKey: async () => null } },
      {
        code: 'access-key-not-full-access',
        overrides: {
          getAccessKey: async (accountId, publicKey) => ({
            accountId,
            publicKey,
            nonce: '1',
            permission: {
              kind: 'function-call',
              allowanceRaw: null,
              receiverId,
              methodNames: []
            },
            blockHash,
            blockHeight: 1
          })
        }
      },
      {
        code: 'insufficient-funds',
        overrides: {
          getAccount: async accountId => account(accountId, '2000000000000000000000000')
        }
      }
    ]
    for (const entry of cases) {
      const state = harness(entry.overrides)
      await expect(
        prepareNearNativeTransfer({
          chainId: 'near:testnet',
          accountIndex: 0,
          signerId,
          publicKey,
          receiverId,
          depositYocto: '2000000000000000000000000',
          rpc: state.rpc
        })
      ).rejects.toMatchObject({ code: entry.code })
    }
  })

  test('supports a verified named signer, rejects an implicit key mismatch and nonce overflow', async () => {
    const state = harness()
    await expect(
      prepareNearNativeTransfer({
        chainId: 'near:testnet',
        accountIndex: 0,
        signerId: 'alice.testnet',
        publicKey,
        receiverId,
        depositYocto: '1',
        rpc: state.rpc
      })
    ).resolves.toMatchObject({ signerId: 'alice.testnet', publicKey })
    await expect(
      prepareNearNativeTransfer({
        chainId: 'near:testnet',
        accountIndex: 0,
        signerId,
        publicKey: 'ed25519:11111111111111111111111111111112',
        receiverId,
        depositYocto: '1',
        rpc: state.rpc
      })
    ).rejects.toThrow(/does not match its public key/)

    const overflow = harness({
      getAccessKey: async (accountId, publicKey) => ({
        accountId,
        publicKey,
        nonce: '18446744073709551615',
        permission: { kind: 'full-access' },
        blockHash,
        blockHeight: 1
      })
    })
    await expect(
      prepareNearNativeTransfer({
        chainId: 'near:testnet',
        accountIndex: 0,
        signerId,
        publicKey,
        receiverId,
        depositYocto: '1',
        rpc: overflow.rpc
      })
    ).rejects.toThrow(/nonce is exhausted/)
  })

  test('prepares an exact NEP-141 ft_transfer only for a registered recipient', async () => {
    const contractId = 'token.testnet'
    const state = harness({
      getFungibleTokenBalance: async (requestedContract, accountId) => ({
        contractId: requestedContract,
        accountId,
        amountRaw: '2500000',
        blockHash,
        blockHeight: 10
      }),
      isFungibleTokenAccountRegistered: async () => true
    })
    const prepared = await prepareNearTokenTransfer({
      chainId: 'near:testnet',
      accountIndex: 0,
      assetId: 'near:testnet/nep141:token.testnet',
      signerId,
      publicKey,
      recipientId: receiverId,
      contractId,
      amountRaw: '1500000',
      rpc: state.rpc
    })

    expect(prepared).toMatchObject({
      kind: 'token',
      contractId,
      recipientId: receiverId,
      amountRaw: '1500000',
      transaction: {
        receiverId: contractId,
        actions: [
          {
            type: 'functionCall',
            methodName: 'ft_transfer',
            gas: '30000000000000',
            depositYocto: '1'
          }
        ]
      }
    })
    expect(parsePreparedNearTokenTransfer(structuredClone(prepared))).toEqual(prepared)

    await expect(
      prepareNearTokenTransfer({
        chainId: 'near:testnet',
        accountIndex: 0,
        assetId: 'near:testnet/nep141:token.testnet',
        signerId,
        publicKey,
        recipientId: receiverId,
        contractId,
        amountRaw: '1',
        rpc: { ...state.rpc, isFungibleTokenAccountRegistered: async () => false }
      })
    ).rejects.toMatchObject({ code: 'recipient-token-account-not-registered' })
  })
})

test.describe('NEAR Lending Supply preparation', () => {
  test('prepares a registered NEP-141 transfer call with the canonical Lending message', async () => {
    const contractId = 'token.testnet'
    const recipientId = 'rhea00000x.multica.testnet'
    const state = harness({
      getFungibleTokenBalance: async (requestedContract, accountId) => ({
        contractId: requestedContract,
        accountId,
        amountRaw: '2500000',
        blockHash,
        blockHeight: 10
      }),
      isFungibleTokenAccountRegistered: async () => true
    })
    const customRecipientMsg = createNearLendingSupplyMessage({
      accountId: signerId,
      reason: 'BurrowCollateral',
      createsMca: false
    })
    const prepared = await prepareNearLendingSupply({
      chainId: 'near:testnet',
      accountIndex: 0,
      assetId: 'near:testnet/nep141:token.testnet',
      signerId,
      publicKey,
      recipientId,
      tokenContractId: contractId,
      amountRaw: '1500000',
      customRecipientMsg,
      rpc: state.rpc
    })

    expect(prepared).toMatchObject({
      kind: 'lending-supply',
      sourceKind: 'token',
      recipientId,
      tokenContractId: contractId,
      amountRaw: '1500000',
      protocolDepositYocto: '1',
      transaction: {
        receiverId: contractId,
        actions: [
          {
            type: 'functionCall',
            methodName: 'ft_transfer_call',
            gas: '250000000000000',
            depositYocto: '1'
          }
        ]
      }
    })
    expect(parsePreparedNearLendingSupply(structuredClone(prepared))).toEqual(prepared)
  })

  test('wraps native NEAR and registers both token accounts before supplying a new MCA', async () => {
    const contractId = 'wrap.testnet'
    const recipientId = 'multica.testnet'
    const state = harness({
      getFungibleTokenBalance: async () => {
        throw new Error('native source must not read an existing token balance')
      },
      isFungibleTokenAccountRegistered: async () => false
    })
    const prepared = await prepareNearLendingSupply({
      chainId: 'near:testnet',
      accountIndex: 0,
      assetId: 'near:testnet/slip44:397',
      signerId,
      publicKey,
      recipientId,
      tokenContractId: contractId,
      amountRaw: '1000000000000000000000000',
      customRecipientMsg: createNearLendingSupplyMessage({
        accountId: signerId,
        reason: 'BurrowRegisterAndCollateral',
        createsMca: true
      }),
      rpc: state.rpc
    })

    expect(prepared.transaction.actions.map(action => action.methodName)).toEqual([
      'storage_deposit',
      'near_deposit',
      'storage_deposit',
      'ft_transfer_call'
    ])
    expect(prepared.protocolDepositYocto).toBe('1002500000000000000000001')
    expect(parsePreparedNearLendingSupply(structuredClone(prepared))).toEqual(prepared)
    expect(() =>
      parsePreparedNearLendingSupply({
        ...structuredClone(prepared),
        chainId: 'eip155:1',
        transaction: { ...structuredClone(prepared.transaction), chainId: 'eip155:1' }
      })
    ).toThrow(/requires a NEAR chain/)
    expect(() =>
      parsePreparedNearLendingSupply({
        ...structuredClone(prepared),
        transaction: { ...structuredClone(prepared.transaction), nonce: '0' }
      })
    ).toThrow(/nonce must be greater than zero/)
  })
})
