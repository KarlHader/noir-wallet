import { test } from 'node:test'
import { expect } from '@playwright/test'

import { BackgroundEvmTransferController } from '../../../../src/background/evm-transfer-controller.ts'

const chainAccount = Object.freeze({
  id: 'chain-account:evm:active',
  scope: {
    keyDomainId: 'key-domain:active',
    accountId: 'account:active',
    chainId: 'eip155:1'
  },
  derivation: { scheme: 'bip44', path: "m/44'/60'/0'/0/0" },
  identity: {
    kind: 'account-identifier',
    value: '0x1111111111111111111111111111111111111111'
  },
  createdAt: 1
})

const activeContext = Object.freeze({
  generationId: 'metadata:generation:active',
  chainAccount,
  keyDomainSource: { kind: 'software', mnemonicWordCount: 24 }
})
const privateExecutionAccount = Object.freeze({
  kind: 'pea',
  address: '0x3333333333333333333333333333333333333333',
  addressIndex: 0
})

const hardwareContext = Object.freeze({
  generationId: 'metadata:generation:hardware',
  chainAccount,
  keyDomainSource: Object.freeze({
    kind: 'hardware',
    vendor: 'keystone',
    firmwareProfile: 'multi-coin',
    capabilities: Object.freeze(['bitcoin', 'evm'])
  })
})

function setup(active = activeContext) {
  const calls = []
  const signing = Object.freeze({
    commandId: 'signing-command:internal',
    chainId: 'eip155:1',
    operation: 'transaction',
    summary: { schema: 'evm.transaction.v1' },
    payloadFingerprint: { algorithm: 'sha256', digestHex: 'a'.repeat(64) },
    execution: { kind: 'internal' },
    expiresAt: 5_000
  })
  const results = {
    prepare: Object.freeze({ graph: { root: { id: 'transaction:prepared' } }, signing }),
    pending: Object.freeze({ graph: { root: { id: 'transaction:pending' } }, signing }),
    approve: Object.freeze({
      status: 'broadcast',
      graph: { root: { id: 'transaction:approved' } }
    }),
    reject: Object.freeze({ root: { id: 'transaction:rejected' } }),
    resume: Object.freeze({
      status: 'signed-pending-broadcast',
      graph: { root: { id: 'transaction:resumed' } }
    })
  }
  const orchestrator = {
    prepare: async input => {
      calls.push(['prepare', input])
      return results.prepare
    },
    approve: async input => {
      calls.push(['approve', input])
      return results.approve
    },
    getPendingApproval: async input => {
      calls.push(['get-pending', input])
      return results.pending
    },
    reject: async input => {
      calls.push(['reject', input])
      return results.reject
    },
    resumeBroadcast: async input => {
      calls.push(['resume', input])
      return results.resume
    }
  }
  return {
    calls,
    results,
    controller: new BackgroundEvmTransferController({
      orchestrator,
      loadActiveContext: async () => active,
      resolveExternalSigner: async () => {
        throw new Error('unexpected hardware signer resolution')
      },
      resolvePrivateExecutionAccount: async context => {
        calls.push(['resolve-private', context])
        return privateExecutionAccount
      },
      readTokenAllowance: async (token, owner, spender) => {
        calls.push(['allowance', token, owner, spender])
        return '2000000'
      }
    })
  }
}

test.describe('Background EVM transfer controller', () => {
  test('reads allowance only for the selected active execution account', async () => {
    const { calls, controller } = setup()
    const token = '0x2222222222222222222222222222222222222222'
    const spender = '0x4444444444444444444444444444444444444444'

    await expect(
      controller.getTokenAllowance(token, spender, chainAccount.identity.value, 'main')
    ).resolves.toBe('2000000')
    await expect(
      controller.getTokenAllowance(token, spender, privateExecutionAccount.address, 'private')
    ).resolves.toBe('2000000')
    await expect(
      controller.getTokenAllowance(token, spender, chainAccount.identity.value, 'private')
    ).rejects.toThrow(/does not match/)
    expect(calls).toEqual([
      ['allowance', token, chainAccount.identity.value, spender],
      ['resolve-private', activeContext],
      ['allowance', token, privateExecutionAccount.address, spender],
      ['resolve-private', activeContext]
    ])
  })

  test('parses an exact transfer intent and binds it to the active Storage V2 account', async () => {
    const { calls, controller, results } = setup()
    const intent = {
      assetId: 'eip155:1/slip44:60',
      recipient: '0x2222222222222222222222222222222222222222',
      amountRaw: '123'
    }

    const nearIntentsBinding = {
      schemaVersion: 1,
      provider: 'near-intents',
      kind: 'swap',
      depositAddress: intent.recipient,
      refundAddress: chainAccount.identity.value,
      expiresAt: 5_000,
      origin: {
        chainId: 'eip155:1',
        assetId: intent.assetId,
        protocolAssetId: 'nep141:eth.omft.near'
      },
      destination: {
        chainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
        assetId: 'bip122:00040fe8ec8471911baa1db1266ea15d/slip44:133',
        protocolAssetId: 'nep141:zec.omft.near',
        recipient: 'u1destination',
        expectedAmountRaw: '100',
        minimumAmountRaw: '99'
      }
    }

    const review = await controller.prepare(intent, nearIntentsBinding, 'low')
    expect(review).toEqual({
      graph: results.prepare.graph,
      review: {
        chainId: results.prepare.signing.chainId,
        operation: 'transaction',
        summary: results.prepare.signing.summary,
        payloadFingerprint: results.prepare.signing.payloadFingerprint,
        expiresAt: results.prepare.signing.expiresAt
      }
    })
    expect(review.review).not.toHaveProperty('commandId')
    expect(review.review).not.toHaveProperty('execution')
    expect(calls).toEqual([
      [
        'prepare',
        {
          chainAccount,
          intent,
          nearIntentsBinding,
          feeSelection: { kind: 'tier', tier: 'low' },
          signingMode: 'internal'
        }
      ]
    ])
    await expect(controller.prepare({ ...intent, data: '0x' })).rejects.toThrow(/invalid fields/i)
    expect(calls).toHaveLength(1)
  })

  test('derives and binds the selected Private Execution Address inside Background', async () => {
    const { calls, controller } = setup()
    const intent = {
      assetId: 'eip155:1/slip44:60',
      recipient: '0x2222222222222222222222222222222222222222',
      amountRaw: '123'
    }

    await controller.prepare(intent, undefined, 'fast', 'private')

    expect(calls).toEqual([
      ['resolve-private', activeContext],
      [
        'prepare',
        {
          chainAccount,
          intent,
          executionAccount: privateExecutionAccount,
          feeSelection: { kind: 'tier', tier: 'fast' },
          signingMode: 'internal'
        }
      ]
    ])
    await expect(controller.prepare(intent, undefined, undefined, 'forged')).rejects.toThrow(
      /execution mode/i
    )
  })

  test('rejects a cross-network asset before transaction preparation', async () => {
    const { calls, controller } = setup()
    await expect(
      controller.prepare({
        assetId: 'eip155:8453/slip44:60',
        recipient: '0x2222222222222222222222222222222222222222',
        amountRaw: '1'
      })
    ).rejects.toThrow(/active network/i)
    expect(calls).toEqual([])
  })

  test('parses and binds a contract call to the active EVM network', async () => {
    const { calls, controller } = setup()
    const intent = {
      chainId: 'eip155:1',
      contractAddress: '0x2222222222222222222222222222222222222222',
      valueRaw: '0',
      calldata: '0x12345678'
    }

    await expect(controller.prepareContractCall(intent)).resolves.toMatchObject({
      graph: { root: { id: 'transaction:prepared' } },
      review: { chainId: 'eip155:1' }
    })
    expect(calls).toEqual([
      [
        'prepare',
        {
          chainAccount,
          intent,
          feeSelection: { kind: 'tier', tier: 'standard' },
          signingMode: 'internal'
        }
      ]
    ])
    await controller.prepareContractCall(intent, 'fast')
    expect(calls.at(-1)).toEqual([
      'prepare',
      {
        chainAccount,
        intent,
        feeSelection: { kind: 'tier', tier: 'fast' },
        signingMode: 'internal'
      }
    ])
    await controller.prepareContractCall(intent, 'low', undefined, undefined, 'private')
    expect(calls.slice(-2)).toEqual([
      ['resolve-private', activeContext],
      [
        'prepare',
        {
          chainAccount,
          intent,
          feeSelection: { kind: 'tier', tier: 'low' },
          executionAccount: privateExecutionAccount,
          signingMode: 'internal'
        }
      ]
    ])
    await expect(
      controller.prepareContractCall({ ...intent, chainId: 'eip155:8453' })
    ).rejects.toThrow(/active network/i)
    expect(calls).toHaveLength(4)
  })

  test('binds a Keystone transfer to the exact active hardware signing context', async () => {
    const calls = []
    const externalSigner = Object.freeze({
      derivationPath: "m/44'/60'/0'/0/0",
      masterFingerprintHex: 'e9181cf3',
      address: chainAccount.identity.value.toLowerCase()
    })
    const signing = Object.freeze({
      commandId: 'signing-command:keystone',
      chainId: 'eip155:1',
      operation: 'transaction',
      summary: { schema: 'evm.transaction.v1' },
      payloadFingerprint: { algorithm: 'sha256', digestHex: 'a'.repeat(64) },
      execution: { kind: 'external' },
      expiresAt: 5_000
    })
    const controller = new BackgroundEvmTransferController({
      orchestrator: {
        prepare: async input => {
          calls.push(['prepare', input])
          return { graph: { root: { id: 'transaction:prepared' } }, signing }
        }
      },
      loadActiveContext: async () => hardwareContext,
      resolveExternalSigner: async value => {
        calls.push(['resolve', value])
        return externalSigner
      },
      readTokenAllowance: async () => {
        throw new Error('unexpected allowance read')
      }
    })
    const intent = {
      assetId: 'eip155:1/slip44:60',
      recipient: '0x2222222222222222222222222222222222222222',
      amountRaw: '123'
    }

    await expect(controller.prepare(intent)).resolves.toMatchObject({
      review: { chainId: 'eip155:1', payloadFingerprint: signing.payloadFingerprint }
    })
    expect(calls).toEqual([
      ['resolve', chainAccount],
      ['prepare', { chainAccount, intent, signingMode: 'keystone', externalSigner }]
    ])
  })

  test('resolves the active scope for review, approval, rejection, and raw transaction recovery', async () => {
    const { calls, controller, results } = setup()
    const fingerprint = 'a'.repeat(64)

    await expect(controller.getPendingApproval('transaction:evm:0')).resolves.toMatchObject({
      graph: results.pending.graph,
      review: { payloadFingerprint: results.pending.signing.payloadFingerprint }
    })
    await expect(controller.approve('transaction:evm:1', fingerprint)).resolves.toBe(
      results.approve
    )
    const authorizedContexts = []
    await expect(
      controller.approveForDApp('transaction:evm:dapp', fingerprint, async context => {
        authorizedContexts.push(context)
      })
    ).resolves.toBe(results.approve)
    expect(authorizedContexts).toEqual([activeContext])
    await expect(controller.reject('transaction:evm:2')).resolves.toBe(results.reject)
    await expect(
      controller.rejectForScope('transaction:evm:scoped', {
        keyDomainId: chainAccount.scope.keyDomainId,
        accountId: chainAccount.scope.accountId
      })
    ).resolves.toBe(results.reject)
    await expect(controller.resumeBroadcast('transaction:evm:3')).resolves.toBe(results.resume)
    expect(calls).toEqual([
      ['get-pending', { scope: chainAccount.scope, transactionId: 'transaction:evm:0' }],
      [
        'approve',
        {
          scope: chainAccount.scope,
          transactionId: 'transaction:evm:1',
          payloadFingerprint: fingerprint
        }
      ],
      [
        'approve',
        {
          scope: chainAccount.scope,
          transactionId: 'transaction:evm:dapp',
          payloadFingerprint: fingerprint
        }
      ],
      ['reject', { scope: chainAccount.scope, transactionId: 'transaction:evm:2' }],
      [
        'reject',
        {
          scope: {
            keyDomainId: chainAccount.scope.keyDomainId,
            accountId: chainAccount.scope.accountId
          },
          transactionId: 'transaction:evm:scoped'
        }
      ],
      ['resume', { scope: chainAccount.scope, transactionId: 'transaction:evm:3' }]
    ])
  })

  test('fails closed when the active Account has no EVM ChainAccount', async () => {
    const { controller } = setup(null)
    await expect(
      controller.prepare({
        assetId: 'eip155:1/slip44:60',
        recipient: '0x2222222222222222222222222222222222222222',
        amountRaw: '1'
      })
    ).rejects.toThrow(/no EVM ChainAccount/i)
  })
})
