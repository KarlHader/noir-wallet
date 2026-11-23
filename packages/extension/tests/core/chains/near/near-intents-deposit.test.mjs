import { test } from 'node:test'
import { expect } from '@playwright/test'

import { BackgroundNearTransferController } from '../../../../src/background/near-transfer-controller.ts'
import {
  NEAR_CHAIN_FEATURE_FLAG,
  ZCASH_CHAIN_FEATURE_FLAG
} from '../../../../src/config/multichain-feature-flags.ts'
import {
  NEAR_FT_TRANSFER_DEPOSIT_YOCTO,
  NEAR_FT_TRANSFER_GAS,
  NEAR_STORAGE_DEPOSIT_GAS,
  NEAR_STORAGE_DEPOSIT_YOCTO,
  NEAR_WRAP_DEPOSIT_GAS,
  buildNearConfidentialFungibleDepositActions,
  buildNearIntentsDepositActions,
  nearAccountStorageReserveYocto,
  nearIntentsDepositMaximumYocto,
  nearSpendableNativeYocto
} from '../../../../src/core/chains/near/index.ts'
import {
  createAssetRegistry,
  createFeatureGatedChainRegistry,
  createInitialProductChainRegistry,
  filterAssetDefinitionsForChains,
  getBundledInitialProductAssetDefinitions
} from '../../../../src/core/chains/registry/index.ts'
import { formatShieldSymbol, formatSymbol } from '../../../../src/lib/format.ts'
import {
  ChromeSessionNearPendingTransferStore,
  NearTransferOrchestrator,
  computeNearTransactionFingerprint,
  formatNearBalanceShortage,
  parsePreparedNearConfidentialFungibleDeposit,
  parsePreparedNearTransfer,
  prepareNearConfidentialFungibleDeposit,
  prepareNearIntentsDeposit
} from '../../../../src/infrastructure/chains/near/index.ts'
import { InMemoryTransactionRepository } from '../../../../src/infrastructure/persistence/repositories/index.ts'

const signerId = '00'.repeat(32)
const publicKey = `ed25519:${'1'.repeat(32)}`
const depositAddress = 'intents.near'
const blockHash = '11111111111111111111111111111111'
const chainId = 'near:mainnet'
const assetId = `${chainId}/nep141:wrap.near`
const memo = 'intents-deposit-memo'
const oneNear = 10n ** 24n
const gasPrice = 100_000_000n
const minimumGasPrice = 1_000_000_000n
const storagePrice = 10_000_000_000_000_000_000n
const storageUsage = 100n

function decodedArgs(action) {
  return JSON.parse(Buffer.from(action.args, 'base64').toString('utf8'))
}

function plan(overrides = {}) {
  return buildNearIntentsDepositActions({
    signerId,
    depositAddress,
    amountYocto: 3n * oneNear,
    wrappedBalanceYocto: oneNear,
    signerRegistered: true,
    recipientRegistered: true,
    memo,
    ...overrides
  })
}

test('builds one wrap.near transaction and wraps only the shortfall', () => {
  const registered = plan()
  expect(registered.receiverId).toBe('wrap.near')
  expect(registered.wrapAmountYocto).toBe(2n * oneNear)
  expect(registered.storageFeeYocto).toBe(0n)
  expect(registered.actions.map(action => action.methodName)).toEqual([
    'near_deposit',
    'ft_transfer'
  ])
  expect(registered.actions[0]).toMatchObject({
    args: {},
    gas: NEAR_WRAP_DEPOSIT_GAS.toString(),
    depositYocto: (2n * oneNear).toString()
  })
  expect(registered.actions[1]).toMatchObject({
    args: { receiver_id: depositAddress, amount: (3n * oneNear).toString(), memo },
    gas: NEAR_FT_TRANSFER_GAS.toString(),
    depositYocto: NEAR_FT_TRANSFER_DEPOSIT_YOCTO.toString()
  })

  const covered = plan({ amountYocto: oneNear, wrappedBalanceYocto: 5n * oneNear })
  expect(covered.wrapAmountYocto).toBe(0n)
  expect(covered.actions.map(action => action.methodName)).toEqual(['ft_transfer'])

  const unregistered = plan({ signerRegistered: false, recipientRegistered: false })
  expect(unregistered.storageFeeYocto).toBe(2n * NEAR_STORAGE_DEPOSIT_YOCTO)
  expect(unregistered.actions.map(action => [action.methodName, action.args.account_id])).toEqual([
    ['storage_deposit', signerId],
    ['near_deposit', undefined],
    ['storage_deposit', depositAddress],
    ['ft_transfer', undefined]
  ])
  expect(unregistered.actions[0]).toMatchObject({
    gas: NEAR_STORAGE_DEPOSIT_GAS.toString(),
    depositYocto: NEAR_STORAGE_DEPOSIT_YOCTO.toString(),
    args: { account_id: signerId, registration_only: true }
  })

  const sameAccount = plan({
    depositAddress: signerId,
    signerRegistered: false,
    recipientRegistered: false,
    wrappedBalanceYocto: 3n * oneNear
  })
  expect(sameAccount.wrapAmountYocto).toBe(0n)
  expect(sameAccount.storageFeeYocto).toBe(NEAR_STORAGE_DEPOSIT_YOCTO)
  expect(sameAccount.actions.map(action => action.methodName)).toEqual([
    'storage_deposit',
    'ft_transfer'
  ])
  expect(sameAccount.nativeAttachedYocto).toBe(
    NEAR_STORAGE_DEPOSIT_YOCTO + NEAR_FT_TRANSFER_DEPOSIT_YOCTO
  )
})

test('wNEAR deposit spends existing wNEAR and refuses a native shortfall', () => {
  const enough = plan({
    amountYocto: oneNear,
    wrappedBalanceYocto: 2n * oneNear,
    wrapShortfall: false,
    signerRegistered: false,
    recipientRegistered: false
  })
  expect(enough.wrapAmountYocto).toBe(0n)
  expect(enough.actions.map(action => action.methodName)).toEqual([
    'storage_deposit',
    'storage_deposit',
    'ft_transfer'
  ])
  expect(enough.actions.some(action => action.methodName === 'near_deposit')).toBe(false)
  expect(enough.nativeAttachedYocto).toBe(
    2n * NEAR_STORAGE_DEPOSIT_YOCTO + NEAR_FT_TRANSFER_DEPOSIT_YOCTO
  )

  expect(() =>
    plan({
      amountYocto: 3n * oneNear,
      wrappedBalanceYocto: oneNear,
      wrapShortfall: false
    })
  ).toThrow('wNEAR balance is insufficient')
})

test('keeps the intents maximum inside spendable native NEAR plus existing wNEAR', () => {
  const reserve = nearAccountStorageReserveYocto(storageUsage, storagePrice)
  expect(reserve).toBe(storageUsage * storagePrice)
  const balance = 10n * oneNear
  const maximumFee = 8n * 10n ** 22n
  const spendable = nearSpendableNativeYocto({
    balanceYocto: balance,
    maximumFeeYocto: maximumFee,
    storageReserveYocto: reserve
  })
  expect(spendable).toBe(balance - maximumFee - reserve)

  const withoutStorage = nearIntentsDepositMaximumYocto({
    spendableNativeYocto: spendable,
    wrappedBalanceYocto: 4n * oneNear,
    storageDepositFeeYocto: 0n
  })
  expect(withoutStorage).toBe(spendable + 4n * oneNear - NEAR_FT_TRANSFER_DEPOSIT_YOCTO)

  const withStorage = nearIntentsDepositMaximumYocto({
    spendableNativeYocto: spendable,
    wrappedBalanceYocto: 4n * oneNear,
    storageDepositFeeYocto: 2n * NEAR_STORAGE_DEPOSIT_YOCTO
  })
  expect(withStorage).toBe(
    spendable + 4n * oneNear - 2n * NEAR_STORAGE_DEPOSIT_YOCTO - NEAR_FT_TRANSFER_DEPOSIT_YOCTO
  )
  expect(
    nearIntentsDepositMaximumYocto({
      spendableNativeYocto: NEAR_STORAGE_DEPOSIT_YOCTO,
      wrappedBalanceYocto: 9n * oneNear,
      storageDepositFeeYocto: NEAR_STORAGE_DEPOSIT_YOCTO + 1n
    })
  ).toBe(0n)
})

test('shows wNEAR on chain rows and NEAR for Shield balances', () => {
  expect(formatSymbol('wNEAR')).toBe('wNEAR')
  expect(formatSymbol('NEAR')).toBe('NEAR')
  expect(formatSymbol('USDC')).toBe('USDC')
  expect(formatSymbol('wNEAR (deprecated)')).toBe('wNEAR')
  expect(formatSymbol('ZEC (deprecated)')).toBe('ZEC')
  expect(formatShieldSymbol('wNEAR')).toBe('NEAR')
  expect(formatShieldSymbol('wNEAR (deprecated)')).toBe('NEAR')
  expect(formatShieldSymbol('USDC')).toBe('USDC')
  expect(formatShieldSymbol('ZEC (deprecated)')).toBe('ZEC')
})

test('keeps bundled wNEAR behind the NEAR chain flag and off testnet', () => {
  const mainnet = createInitialProductChainRegistry('mainnet')
  const hidden = createFeatureGatedChainRegistry(mainnet, [ZCASH_CHAIN_FEATURE_FLAG])
  const hiddenAssets = createAssetRegistry(
    hidden,
    filterAssetDefinitionsForChains(getBundledInitialProductAssetDefinitions('mainnet'), hidden)
  )
  expect(hiddenAssets.list().some(entry => entry.asset.chainId.startsWith('near:'))).toBe(false)

  const visible = createFeatureGatedChainRegistry(mainnet, [
    ZCASH_CHAIN_FEATURE_FLAG,
    NEAR_CHAIN_FEATURE_FLAG
  ])
  const visibleAssets = createAssetRegistry(
    visible,
    filterAssetDefinitionsForChains(getBundledInitialProductAssetDefinitions('mainnet'), visible)
  )
  expect(visibleAssets.resolve(`${chainId}/slip44:397`).metadata.symbol).toBe('NEAR')
  expect(visibleAssets.resolve(assetId)).toMatchObject({
    metadata: { name: 'Wrapped NEAR', symbol: 'wNEAR', decimals: 24 },
    source: 'bundled'
  })

  const testnet = createInitialProductChainRegistry('testnet')
  const testnetAssets = createAssetRegistry(
    testnet,
    getBundledInitialProductAssetDefinitions('testnet')
  )
  expect(testnetAssets.list().some(entry => entry.asset.reference === 'wrap.near')).toBe(false)
  expect(testnetAssets.resolve('near:testnet/slip44:397').metadata.symbol).toBe('NEAR')
})

function costs() {
  return {
    chainId,
    minGasPurchasePriceRaw: minimumGasPrice.toString(),
    storageAmountPerByteRaw: storagePrice.toString(),
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
}

function account(accountId, amountRaw = (20n * oneNear).toString()) {
  return {
    accountId,
    amountRaw,
    lockedRaw: '0',
    storageUsage: Number(storageUsage),
    codeHash: blockHash,
    blockHash,
    blockHeight: 10
  }
}

function rpc(state) {
  return {
    assertExpectedChain: async () => state.calls.push('attest'),
    getAccount: async accountId => (
      state.calls.push(`account:${accountId}`),
      account(accountId, state.balance)
    ),
    getAccessKey: async (accountId, requestedPublicKey) => {
      state.calls.push(`key:${accountId}:${requestedPublicKey}`)
      return {
        accountId,
        publicKey: requestedPublicKey,
        nonce: '41',
        permission: { kind: 'full-access' },
        blockHash,
        blockHeight: 10
      }
    },
    getGasPrice: async () => (state.calls.push('gas-price'), gasPrice.toString()),
    getNativeTransferCostConfig: async () => (state.calls.push('costs'), costs()),
    getFungibleTokenBalance: async (contractId, accountId) => {
      state.calls.push(`balance:${contractId}:${accountId}`)
      return {
        contractId,
        accountId,
        amountRaw: state.wrapped,
        blockHash,
        blockHeight: 10
      }
    },
    isFungibleTokenAccountRegistered: async (contractId, accountId) => {
      state.calls.push(`registered:${contractId}:${accountId}`)
      return state.registered.get(accountId) === true
    }
  }
}

test('prepares an exact-max intents deposit from wNEAR and native shortfall', async () => {
  const reserve = nearAccountStorageReserveYocto(storageUsage, storagePrice)
  const gasUnits = NEAR_WRAP_DEPOSIT_GAS + NEAR_FT_TRANSFER_GAS
  const maximumFee = gasUnits * minimumGasPrice
  const estimatedFee = gasUnits * gasPrice
  const balance = 10n * oneNear
  const wrapped = 2n * oneNear
  const spendable = nearSpendableNativeYocto({
    balanceYocto: balance,
    maximumFeeYocto: maximumFee,
    storageReserveYocto: reserve
  })
  const amount = nearIntentsDepositMaximumYocto({
    spendableNativeYocto: spendable,
    wrappedBalanceYocto: wrapped,
    storageDepositFeeYocto: 0n
  })
  const state = {
    calls: [],
    balance: balance.toString(),
    wrapped: wrapped.toString(),
    registered: new Map([
      [signerId, true],
      [depositAddress, true]
    ])
  }
  const prepared = await prepareNearIntentsDeposit({
    chainId,
    accountIndex: 4,
    signerId,
    publicKey,
    depositAddress,
    amountRaw: amount.toString(),
    memo,
    rpc: rpc(state)
  })

  expect(prepared.kind).toBe('intents-deposit')
  expect(prepared.assetId).toBe(assetId)
  expect(prepared.recipientId).toBe(depositAddress)
  expect(prepared.transaction).toMatchObject({
    receiverId: 'wrap.near',
    nonce: '42',
    blockHash
  })
  expect(prepared.wrapAmountYocto).toBe((amount - wrapped).toString())
  expect(prepared.storageFeeYocto).toBe('0')
  expect(prepared.estimatedFeeYocto).toBe(estimatedFee.toString())
  expect(prepared.maximumFeeYocto).toBe(maximumFee.toString())
  expect(prepared.storageReserveYocto).toBe(reserve.toString())
  expect(prepared.totalRequiredYocto).toBe(
    (maximumFee + reserve + (amount - wrapped) + NEAR_FT_TRANSFER_DEPOSIT_YOCTO).toString()
  )
  expect(prepared.transaction.actions.map(action => action.methodName)).toEqual([
    'near_deposit',
    'ft_transfer'
  ])
  expect(decodedArgs(prepared.transaction.actions[1])).toEqual({
    receiver_id: depositAddress,
    amount: amount.toString(),
    memo
  })
  expect(state.calls).toEqual([
    'attest',
    `account:${signerId}`,
    `key:${signerId}:${publicKey}`,
    'gas-price',
    'costs',
    `balance:wrap.near:${signerId}`,
    `registered:wrap.near:${signerId}`,
    `registered:wrap.near:${depositAddress}`
  ])
  expect(parsePreparedNearTransfer(prepared)).toEqual(prepared)
  const overAmount = amount + 1n
  const overRequired = maximumFee + reserve + (overAmount - wrapped) + NEAR_FT_TRANSFER_DEPOSIT_YOCTO
  await expect(
    prepareNearIntentsDeposit({
      chainId,
      accountIndex: 4,
      signerId,
      publicKey,
      depositAddress,
      amountRaw: overAmount.toString(),
      memo,
      rpc: rpc({ ...state, calls: [] })
    })
  ).rejects.toMatchObject({
    code: 'insufficient-funds',
    message: formatNearBalanceShortage(balance.toString(), overRequired.toString())
  })
})

test('registers both parties before wrapping the shortfall', async () => {
  const state = {
    calls: [],
    balance: (20n * oneNear).toString(),
    wrapped: oneNear.toString(),
    registered: new Map()
  }
  const prepared = await prepareNearIntentsDeposit({
    chainId,
    accountIndex: 0,
    signerId,
    publicKey,
    depositAddress,
    amountRaw: (3n * oneNear).toString(),
    memo,
    rpc: rpc(state)
  })
  expect(prepared.wrapAmountYocto).toBe((2n * oneNear).toString())
  expect(prepared.storageFeeYocto).toBe((2n * NEAR_STORAGE_DEPOSIT_YOCTO).toString())
  expect(prepared.transaction.actions.map(action => action.methodName)).toEqual([
    'storage_deposit',
    'near_deposit',
    'storage_deposit',
    'ft_transfer'
  ])
  expect(decodedArgs(prepared.transaction.actions[0]).account_id).toBe(signerId)
  expect(decodedArgs(prepared.transaction.actions[2]).account_id).toBe(depositAddress)
  expect(prepared.transaction.actions[1].depositYocto).toBe((2n * oneNear).toString())

  const covered = {
    calls: [],
    balance: (20n * oneNear).toString(),
    wrapped: (5n * oneNear).toString(),
    registered: new Map([
      [signerId, true],
      [depositAddress, true]
    ])
  }
  const wnear = await prepareNearIntentsDeposit({
    chainId,
    accountIndex: 0,
    signerId,
    publicKey,
    depositAddress,
    amountRaw: (3n * oneNear).toString(),
    wrapShortfall: false,
    rpc: rpc(covered)
  })
  expect(wnear.wrapAmountYocto).toBe('0')
  expect(wnear.transaction.actions.map(action => action.methodName)).toEqual(['ft_transfer'])
  expect(wnear.transaction.actions.some(action => action.methodName === 'near_deposit')).toBe(false)
  await expect(
    prepareNearIntentsDeposit({
      chainId,
      accountIndex: 0,
      signerId,
      publicKey,
      depositAddress,
      amountRaw: (6n * oneNear).toString(),
      wrapShortfall: false,
      rpc: rpc({ ...covered, calls: [] })
    })
  ).rejects.toThrow('wNEAR balance is insufficient')

  await expect(
    prepareNearIntentsDeposit({
      chainId: 'near:testnet',
      accountIndex: 0,
      signerId,
      publicKey,
      depositAddress,
      amountRaw: '1',
      memo,
      rpc: rpc(state)
    })
  ).rejects.toThrow(/mainnet/)
})

test('forwards an intents deposit without loosening a native transfer intent', async () => {
  const calls = []
  const controller = new BackgroundNearTransferController({
    loadActiveContext: async () => ({
      chainAccount: {
        id: 'chain-account:near:active',
        scope: {
          keyDomainId: 'key-domain:active',
          accountId: 'account:active',
          chainId
        },
        derivation: { scheme: 'slip10', path: "m/44'/397'/0'" },
        identity: { kind: 'account-identifier', value: signerId },
        createdAt: 1
      },
      accountIndex: 2,
      publicKey,
      keyDomainSource: { kind: 'software', mnemonicWordCount: 24 }
    }),
    orchestrator: {
      prepare: async input => {
        calls.push(input)
        return {
          graph: { root: { id: 'transaction:near:prepared' } },
          signing: {
            commandId: 'signing-command:near:review',
            chainId,
            operation: 'transaction',
            summary: { schema: 'near.transaction.v1' },
            payloadFingerprint: { algorithm: 'sha256', digestHex: 'a'.repeat(64) },
            execution: { kind: 'internal' },
            expiresAt: 5_000
          },
          debit: {
            maximumFeeRaw: '10',
            storageReserveRaw: '20',
            wrapAmountRaw: '30',
            storageFeeRaw: '40'
          }
        }
      }
    }
  })
  await expect(
    controller.prepare({
      kind: 'intents-deposit',
      assetId,
      recipient: depositAddress,
      amountRaw: (3n * oneNear).toString(),
      memo
    })
  ).resolves.toMatchObject({
    debit: { wrapAmountRaw: '30', storageFeeRaw: '40' }
  })
  expect(calls[0]).toMatchObject({
    kind: 'intents-deposit',
    receiverId: depositAddress,
    amountRaw: (3n * oneNear).toString(),
    memo,
    accountIndex: 2
  })
  expect(calls[0].depositYocto).toBeUndefined()
  await expect(
    controller.prepare({
      assetId: `${chainId}/slip44:397`,
      recipient: depositAddress,
      amountRaw: '1',
      memo
    })
  ).rejects.toThrow(/invalid/i)
})

test('exposes wrap and storage separately through an orchestrator review', async () => {
  const calls = []
  const values = {}
  const storage = {
    get: async key =>
      key === null
        ? structuredClone(values)
        : Object.prototype.hasOwnProperty.call(values, key)
          ? { [key]: structuredClone(values[key]) }
          : {},
    set: async entries => Object.assign(values, structuredClone(entries)),
    remove: async keys => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]
    }
  }
  const chains = createInitialProductChainRegistry('mainnet')
  const assets = createAssetRegistry(chains, getBundledInitialProductAssetDefinitions('mainnet'))
  const scope = { keyDomainId: 'key-domain:near', accountId: 'account:near:0' }
  const state = {
    calls: [],
    balance: (20n * oneNear).toString(),
    wrapped: '0',
    registered: new Map([[signerId, true]])
  }
  const orchestrator = new NearTransferOrchestrator({
    repository: new InMemoryTransactionRepository(),
    pendingStore: new ChromeSessionNearPendingTransferStore(storage),
    signer: {
      prepare: async (_keyDomainId, payload) => {
        calls.push(payload.transaction.receiverId)
        const actions = []
        for (const action of payload.transaction.actions) {
          const bytes = Buffer.from(action.args, 'base64')
          const digest = await crypto.subtle.digest('SHA-256', bytes)
          actions.push({
            kind: 'function-call',
            methodName: action.methodName,
            args: {
              encoding: 'base64',
              value: action.args,
              byteLength: bytes.byteLength,
              sha256: [...new Uint8Array(digest)]
                .map(byte => byte.toString(16).padStart(2, '0'))
                .join('')
            },
            gas: action.gas,
            depositYocto: action.depositYocto
          })
        }
        return {
          commandId: 'signing-command:near:intents',
          chainId,
          operation: 'transaction',
          summary: {
            schema: 'near.transaction.v1',
            chainId,
            operation: 'transaction',
            review: { level: 'standard', issues: [] },
            fields: {
              signerId,
              publicKey,
              nonce: payload.transaction.nonce,
              receiverId: payload.transaction.receiverId,
              blockHash: payload.transaction.blockHash,
              actions
            }
          },
          payloadFingerprint: {
            algorithm: 'sha256',
            digestHex: await computeNearTransactionFingerprint(payload.transaction)
          },
          execution: { kind: 'internal' },
          expiresAt: 5_000
        }
      },
      confirm: async () => {
        throw new Error('unused')
      },
      cancel: async () => {}
    },
    rpc: rpc(state),
    assets,
    now: () => 1_000,
    createId: () => 'intents-1'
  })
  const approval = await orchestrator.prepare({
    chainAccount: {
      id: 'chain-account:near:0',
      scope: { ...scope, chainId },
      derivation: { scheme: 'slip10', path: "m/44'/397'/0'" },
      identity: { kind: 'account-identifier', value: signerId },
      createdAt: 1
    },
    accountIndex: 0,
    publicKey,
    receiverId: depositAddress,
    kind: 'intents-deposit',
    amountRaw: oneNear.toString(),
    memo
  })
  expect(calls).toEqual(['wrap.near'])
  expect(approval.graph.root.intent.primaryAmount).toEqual({
    assetId,
    amountRaw: oneNear.toString()
  })
  expect(approval.graph.root.intent.recipient.address).toBe(depositAddress)
  expect(approval.graph.root.intent.feeLimit.amountRaw).toBe(approval.debit.maximumFeeRaw)
  expect(approval.debit.wrapAmountRaw).toBe(oneNear.toString())
  expect(approval.debit.storageFeeRaw).toBe(NEAR_STORAGE_DEPOSIT_YOCTO.toString())
  expect(approval.debit.wrapAmountRaw).not.toBe(approval.debit.storageFeeRaw)
  const pending = await orchestrator.getPendingApproval({
    scope,
    transactionId: approval.graph.root.id
  })
  expect(pending?.debit).toEqual(approval.debit)
})

const usdtContractId = 'usdt.tether-token.near'
const usdtAssetId = `${chainId}/nep141:${usdtContractId}`

test('builds a USDT deposit as ft_transfer without wrapping NEAR', () => {
  const unregistered = buildNearConfidentialFungibleDepositActions({
    contractId: usdtContractId,
    depositAddress,
    amountRaw: 100_000n,
    recipientRegistered: false
  })
  expect(unregistered.receiverId).toBe(usdtContractId)
  expect(unregistered.amountRaw).toBe(100_000n)
  expect(unregistered.storageFeeYocto).toBe(NEAR_STORAGE_DEPOSIT_YOCTO)
  expect(unregistered.actions.map(action => action.methodName)).toEqual([
    'storage_deposit',
    'ft_transfer'
  ])
  expect(unregistered.actions.some(action => action.methodName === 'near_deposit')).toBe(false)
  expect(unregistered.actions[0]).toMatchObject({
    args: { account_id: depositAddress, registration_only: true },
    gas: NEAR_STORAGE_DEPOSIT_GAS.toString(),
    depositYocto: NEAR_STORAGE_DEPOSIT_YOCTO.toString()
  })
  expect(unregistered.actions[1]).toMatchObject({
    args: { receiver_id: depositAddress, amount: '100000' },
    gas: NEAR_FT_TRANSFER_GAS.toString(),
    depositYocto: NEAR_FT_TRANSFER_DEPOSIT_YOCTO.toString()
  })
  expect(Object.hasOwn(unregistered.actions[1].args, 'memo')).toBe(false)

  const registered = buildNearConfidentialFungibleDepositActions({
    contractId: usdtContractId,
    depositAddress,
    amountRaw: 100_000n,
    recipientRegistered: true
  })
  expect(registered.storageFeeYocto).toBe(0n)
  expect(registered.actions.map(action => action.methodName)).toEqual(['ft_transfer'])
  expect(() =>
    buildNearConfidentialFungibleDepositActions({
      contractId: 'wrap.near',
      depositAddress,
      amountRaw: 100_000n,
      recipientRegistered: true
    })
  ).toThrow(/fungible token/)
})

test('prepares a USDT confidential deposit from the token balance', async () => {
  const state = {
    calls: [],
    balance: (20n * oneNear).toString(),
    wrapped: '100000',
    registered: new Map()
  }
  const prepared = await prepareNearConfidentialFungibleDeposit({
    chainId,
    accountIndex: 4,
    assetId: usdtAssetId,
    signerId,
    publicKey,
    depositAddress,
    amountRaw: '100000',
    rpc: rpc(state)
  })
  const gasUnits = NEAR_STORAGE_DEPOSIT_GAS + NEAR_FT_TRANSFER_GAS
  const reserve = nearAccountStorageReserveYocto(storageUsage, storagePrice)
  expect(prepared.kind).toBe('confidential-ft-deposit')
  expect(prepared.assetId).toBe(usdtAssetId)
  expect(prepared.tokenContractId).toBe(usdtContractId)
  expect(prepared.amountRaw).toBe('100000')
  expect(prepared.recipientId).toBe(depositAddress)
  expect(prepared.storageFeeYocto).toBe(NEAR_STORAGE_DEPOSIT_YOCTO.toString())
  expect(prepared.transaction.receiverId).toBe(usdtContractId)
  expect(prepared.transaction.actions.map(action => action.methodName)).toEqual([
    'storage_deposit',
    'ft_transfer'
  ])
  expect(decodedArgs(prepared.transaction.actions[1])).toEqual({
    receiver_id: depositAddress,
    amount: '100000'
  })
  expect(prepared.estimatedFeeYocto).toBe((gasUnits * gasPrice).toString())
  expect(prepared.maximumFeeYocto).toBe((gasUnits * minimumGasPrice).toString())
  expect(prepared.totalRequiredYocto).toBe(
    (
      gasUnits * minimumGasPrice +
      reserve +
      NEAR_STORAGE_DEPOSIT_YOCTO +
      NEAR_FT_TRANSFER_DEPOSIT_YOCTO
    ).toString()
  )
  expect(state.calls).toEqual([
    'attest',
    `account:${signerId}`,
    `key:${signerId}:${publicKey}`,
    'gas-price',
    'costs',
    `balance:${usdtContractId}:${signerId}`,
    `registered:${usdtContractId}:${depositAddress}`
  ])
  expect(parsePreparedNearConfidentialFungibleDeposit(prepared)).toEqual(prepared)
  const tampered = structuredClone(prepared)
  tampered.transaction.actions[0].methodName = 'near_deposit'
  expect(() => parsePreparedNearConfidentialFungibleDeposit(tampered)).toThrow(/action/)

  const registered = await prepareNearConfidentialFungibleDeposit({
    chainId,
    accountIndex: 4,
    assetId: usdtAssetId,
    signerId,
    publicKey,
    depositAddress,
    amountRaw: '100000',
    rpc: rpc({
      ...state,
      calls: [],
      registered: new Map([[depositAddress, true]])
    })
  })
  expect(registered.storageFeeYocto).toBe('0')
  expect(registered.transaction.actions.map(action => action.methodName)).toEqual(['ft_transfer'])
  expect(registered.transaction.receiverId).toBe(usdtContractId)

  await expect(
    prepareNearConfidentialFungibleDeposit({
      chainId,
      accountIndex: 4,
      assetId: `${chainId}/nep141:wrap.near`,
      signerId,
      publicKey,
      depositAddress,
      amountRaw: '100000',
      rpc: rpc({ ...state, calls: [] })
    })
  ).rejects.toThrow(/fungible token/)
  await expect(
    prepareNearConfidentialFungibleDeposit({
      chainId,
      accountIndex: 4,
      assetId: usdtAssetId,
      signerId,
      publicKey,
      depositAddress,
      amountRaw: '100001',
      rpc: rpc({ ...state, calls: [] })
    })
  ).rejects.toMatchObject({ code: 'insufficient-funds' })
})
