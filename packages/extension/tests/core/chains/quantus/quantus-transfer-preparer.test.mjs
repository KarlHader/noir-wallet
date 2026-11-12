import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  prepareQuantusNativeTransfer,
  QuantusTransferError
} from '../../../../src/infrastructure/chains/quantus/quantus-transfer-preparer.ts'
import { parseSigningPreparePayload } from '../../../../src/infrastructure/keyring/multichain/signing-adapter.ts'
import { QUANTUS_NETWORKS } from '../../../../src/config/networks.ts'
import { QuantusTransferOrchestrator } from '../../../../src/infrastructure/chains/quantus/quantus-transfer-orchestrator.ts'
import {
  buildQuantusFeeQueryExtrinsic,
  estimateQuantusFeeLimit
} from '../../../../src/infrastructure/chains/quantus/quantus-fee-estimate.ts'

const ADDRESS = 'qzna4bUiEiZdXQpwvSQDmM2y9rBPyJRS9iNm85jPgicM76kA8'
const RECIPIENT = 'qzjTEdq3Wd1d98kaeE1RTDPBBYBfY6XpfCtaLq97wmfcAD8M2'
const GENESIS = `0x${'11'.repeat(32)}`
const BEST_HEAD = `0x${'44'.repeat(32)}`

function createRpc(overrides = {}) {
  const calls = []
  const rpc = {
    calls,
    assertExpectedChain: async () => {
      calls.push('assertExpectedChain')
    },
    getBestHead: async () => {
      calls.push('getBestHead')
      return BEST_HEAD
    },
    getHeader: async hash => {
      calls.push(`getHeader:${hash}`)
      return { parentHash: `0x${'33'.repeat(32)}`, number: 4_096 }
    },
    getAccountInfo: async address => {
      calls.push(`getAccountInfo:${address}`)
      return { free: 5_000_000_000_000n, reserved: 0n, nonce: 4 }
    },
    getSystemAccountNextIndex: async address => {
      calls.push(`getSystemAccountNextIndex:${address}`)
      return 5
    },
    getRuntimeVersion: async () => {
      calls.push('getRuntimeVersion')
      return { specVersion: 153, transactionVersion: 1 }
    },
    queryFee: async () => {
      calls.push('queryFee')
      return '8000000000'
    },
    ...overrides
  }
  return rpc
}

function intent(overrides = {}) {
  return { toAddress: RECIPIENT, amountRaw: '1000000000000', keepAlive: true, ...overrides }
}

function input(rpc, overrides = {}) {
  return {
    chainId: QUANTUS_NETWORKS.mainnet.chainId,
    scheme: 'ml-dsa-87',
    accountIndex: 0,
    address: ADDRESS,
    intent: intent(),
    rpc,
    ...overrides
  }
}

test.describe('Quantus native transfer preparation', () => {
  test('assembles a signing.prepare request the Worker contract accepts', async () => {
    const rpc = createRpc()
    const prepared = await prepareQuantusNativeTransfer(input(rpc))

    // The chain is attested before any state is read.
    expect(rpc.calls[0]).toBe('assertExpectedChain')

    const parsed = parseSigningPreparePayload(prepared.request)
    expect(parsed).toMatchObject({
      kind: 'quantus-transfer',
      chainId: 'quantus:mainnet',
      accountIndex: 0,
      scheme: 'ml-dsa-87'
    })
    expect(parsed.transfer).toMatchObject({
      chainId: 'quantus:mainnet',
      recipient: RECIPIENT,
      amount: '1000000000000',
      keepAlive: true,
      nonce: 5,
      tip: '0',
      period: 64,
      blockNumber: 4_096,
      genesisHash: QUANTUS_NETWORKS.mainnet.genesisHash,
      blockHash: BEST_HEAD,
      specVersion: 153,
      transactionVersion: 1,
      allowImmortal: false
    })
    expect(prepared.debit).toEqual({
      amountRaw: '1000000000000',
      tipRaw: '0',
      feeLimitRaw: '10000000000',
      freeRaw: '5000000000000'
    })
  })

  test('anchors the signed era to the best head even when finalized lags beyond the era', async () => {
    const rpc = createRpc({
      getFinalizedHead: async () => {
        throw new Error('Finalized head must not anchor a new signature')
      },
      getHeader: async hash => {
        expect(hash).toBe(BEST_HEAD)
        return { parentHash: `0x${'33'.repeat(32)}`, number: 4_196 }
      }
    })
    const prepared = await prepareQuantusNativeTransfer(input(rpc))
    expect(prepared.request).toMatchObject({ blockHash: BEST_HEAD, blockNumber: 4_196 })
  })

  test('quotes the reviewed transfer before reserving its fee ceiling', async () => {
    const rpc = createRpc({ queryFee: async () => '1015602500' })
    const prepared = await prepareQuantusNativeTransfer(input(rpc))
    expect(prepared.request.feeLimitRaw).toBe('1269503125')
    expect(prepared.debit.feeLimitRaw).toBe('1269503125')
    expect(
      estimateQuantusFeeLimit({
        rpc: { queryFee: async () => '0' },
        signer: ADDRESS,
        recipient: RECIPIENT,
        amountRaw: '1000',
        keepAlive: true,
        scheme: 'ml-dsa-87',
        nonce: 5,
        eraPeriod: 64
      })
    ).rejects.toThrow(/fee estimate/)
  })

  test('quotes a size-faithful non-submittable envelope for both ML-DSA schemes', () => {
    const common = {
      signer: ADDRESS,
      recipient: RECIPIENT,
      amountRaw: '1000000000',
      keepAlive: true,
      nonce: 0,
      eraPeriod: 64
    }
    const large = buildQuantusFeeQueryExtrinsic({ ...common, scheme: 'ml-dsa-87' })
    const small = buildQuantusFeeQueryExtrinsic({ ...common, scheme: 'ml-dsa-65' })
    expect((large.length - 2) / 2).toBe(7300)
    expect((small.length - 2) / 2).toBe(5342)
    expect(large).not.toBe(small)
  })

  test('passes the Worker wire format to the signing port after host review', async () => {
    const rpc = createRpc()
    const reachedSigner = new Error('Signing port reached')
    let wirePayload
    const orchestrator = new QuantusTransferOrchestrator({
      repository: {},
      pendingStore: {},
      signedOnlyStore: { list: async () => [] },
      rpc,
      assets: {},
      signer: {
        async prepare(_keyDomainId, payload) {
          wirePayload = payload
          expect(parseSigningPreparePayload(payload).transfer).toMatchObject({
            recipient: RECIPIENT,
            amount: '1000000000000'
          })
          throw reachedSigner
        }
      }
    })
    await expect(
      orchestrator.prepare({
        chainAccount: {
          identity: { kind: 'account-identifier', value: ADDRESS },
          scope: {
            chainId: QUANTUS_NETWORKS.mainnet.chainId,
            keyDomainId: 'wallet:test',
            accountId: 'account:test'
          }
        },
        accountIndex: 0,
        recipient: RECIPIENT,
        amountRaw: '1000000000000',
        keepAlive: true
      })
    ).rejects.toBe(reachedSigner)
    expect(wirePayload).toHaveProperty('toAddress', RECIPIENT)
    expect(wirePayload).not.toHaveProperty('transfer')
  })

  test('keeps the host Planck chain ID and translates it only for the engine', async () => {
    const rpc = createRpc()
    const prepared = await prepareQuantusNativeTransfer(
      input(rpc, { chainId: QUANTUS_NETWORKS.testnet.chainId })
    )
    expect(prepared.request).toMatchObject({ chainId: 'quantus:planck' })
    expect(prepared.request.genesisHash).toBe(QUANTUS_NETWORKS.testnet.genesisHash)
    expect(parseSigningPreparePayload(prepared.request).transfer.chainId).toBe('quantus:dev')
  })

  test('uses the pending-aware account index and rejects a stale one', async () => {
    const pending = await prepareQuantusNativeTransfer(input(createRpc()))
    expect(pending.request.nonce).toBe(5)

    const staleRpc = createRpc({
      getAccountInfo: async () => ({ free: 5_000_000_000_000n, reserved: 0n, nonce: 9 })
    })
    await expect(prepareQuantusNativeTransfer(input(staleRpc))).rejects.toMatchObject({
      name: 'QuantusTransferError',
      code: 'stale-account-index'
    })
  })

  test('rejects an amount the balance cannot cover', async () => {
    const rpc = createRpc({
      getAccountInfo: async () => ({ free: 999_999_999_999n, reserved: 0n, nonce: 4 })
    })
    const promise = prepareQuantusNativeTransfer(input(rpc))
    await expect(promise).rejects.toBeInstanceOf(QuantusTransferError)
    await expect(promise).rejects.toMatchObject({ code: 'insufficient-funds' })
  })

  test('reserves the estimated fee ceiling on both networks', async () => {
    for (const chainId of [QUANTUS_NETWORKS.mainnet.chainId, QUANTUS_NETWORKS.testnet.chainId]) {
      const rpc = createRpc({
        getAccountInfo: async () => ({ free: 1_009_999_999_999n, reserved: 0n, nonce: 4 })
      })
      await expect(
        prepareQuantusNativeTransfer(
          input(rpc, {
            chainId,
            intent: intent({ keepAlive: false })
          })
        )
      ).rejects.toMatchObject({ code: 'insufficient-funds' })
    }
  })

  test('rejects a keep-alive transfer that would drain the account', async () => {
    const rpc = createRpc({
      getAccountInfo: async () => ({ free: 1_010_000_000_000n, reserved: 0n, nonce: 4 })
    })
    await expect(prepareQuantusNativeTransfer(input(rpc))).rejects.toMatchObject({
      code: 'keep-alive-would-drain'
    })

    // The same amount is accepted when the sender allows account death.
    const death = await prepareQuantusNativeTransfer(
      input(rpc, { intent: intent({ keepAlive: false }) })
    )
    expect(death.request.keepAlive).toBe(false)

    const positiveRemainder = createRpc({
      getAccountInfo: async () => ({ free: 1_010_000_000_001n, reserved: 0n, nonce: 4 })
    })
    expect((await prepareQuantusNativeTransfer(input(positiveRemainder))).request.keepAlive).toBe(
      true
    )
  })

  test('validates the era period, scheme, account index, address, and intent shape', async () => {
    const rpc = createRpc()
    await expect(prepareQuantusNativeTransfer(input(rpc, { eraPeriod: 48 }))).rejects.toThrow(
      /power of two/
    )
    const custom = await prepareQuantusNativeTransfer(
      input(rpc, { eraPeriod: 128, scheme: 'ml-dsa-65', accountIndex: 2 })
    )
    expect(custom.request).toMatchObject({ period: 128, scheme: 'ml-dsa-65', accountIndex: 2 })

    await expect(
      prepareQuantusNativeTransfer(input(rpc, { chainId: 'quantus:dev' }))
    ).rejects.toThrow(/Unsupported Quantus chain ID/)
    await expect(prepareQuantusNativeTransfer(input(rpc, { accountIndex: -1 }))).rejects.toThrow()
    await expect(prepareQuantusNativeTransfer(input(rpc, { address: 'qz-bad' }))).rejects.toThrow()
    await expect(
      prepareQuantusNativeTransfer(input(rpc, { intent: intent({ amountRaw: '0' }) }))
    ).rejects.toThrow(/positive/)
    await expect(
      prepareQuantusNativeTransfer(input(rpc, { intent: intent({ amountRaw: '0x10' }) }))
    ).rejects.toThrow(/unsigned decimal/)
    await expect(
      prepareQuantusNativeTransfer(input(rpc, { intent: { ...intent(), addressIndex: 0 } }))
    ).rejects.toThrow(/Invalid Quantus transfer intent/)
    await expect(
      prepareQuantusNativeTransfer(input(rpc, { intent: intent({ toAddress: '0x1234' }) }))
    ).rejects.toThrow()
  })
})
