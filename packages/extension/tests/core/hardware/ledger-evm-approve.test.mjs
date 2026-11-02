import assert from 'node:assert/strict'
import { it } from 'node:test'
import { secp256k1 } from '@noble/curves/secp256k1'
import { encodeFunctionData, keccak256, parseAbi, parseTransaction } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { BackgroundEvmTransferController } from '../../../src/background/evm-transfer-controller.ts'
import {
  createAssetRegistry,
  createEvmBitcoinChainRegistry,
  getBundledEvmAssetDefinitions
} from '../../../src/core/chains/registry/index.ts'
import { createLedgerMultichainHardwareCredential } from '../../../src/core/wallet/ledger-hardware-credential.ts'
import {
  ChromeSessionEvmPendingTransferStore,
  EvmTransferOrchestrator
} from '../../../src/infrastructure/chains/evm/index.ts'
import { parseEvmAccountBinding } from '../../../src/infrastructure/chains/evm/evm-account.ts'
import { loadLedgerSigningView } from '../../../src/popup/services/ledger-signing-view.ts'
import { saveSwapApprovalContinuation } from '../../../src/background/swap-approval-continuation.ts'
import { HardwareEvmSigningContextResolver } from '../../../src/infrastructure/keyring/hardware-evm-signing-context.ts'
import { LedgerHardwareProvisioningCoordinator } from '../../../src/infrastructure/keyring/ledger-hardware-provisioning-coordinator.ts'
import {
  InMemoryCredentialRepository,
  InMemoryTransactionRepository
} from '../../../src/infrastructure/persistence/repositories/index.ts'

const chainId = 'eip155:1'
const path = "m/44'/60'/7'/0/2"
const privateKey = `0x${'03'.repeat(32)}`
const ledgerAccount = privateKeyToAccount(privateKey)
const address = ledgerAccount.address.toLowerCase()
const publicKey = `0x${Buffer.from(secp256k1.getPublicKey(new Uint8Array(32).fill(3), false)).toString('hex')}`
const spender = '0x2222222222222222222222222222222222222222'
const token = '0x3333333333333333333333333333333333333333'
const calldata = encodeFunctionData({
  abi: parseAbi(['function approve(address spender, uint256 amount)']),
  functionName: 'approve',
  args: [spender, 123n]
})

class MemoryStorage {
  pointer = null
  snapshots = new Map()
  async getActivePointer() {
    return this.pointer
  }
  async getSnapshot(id) {
    return this.snapshots.get(id) ?? null
  }
  async stage(snapshot) {
    this.snapshots.set(snapshot.manifest.generationId, snapshot)
  }
  async commit(pointer, expected) {
    if ((this.pointer?.generationId ?? null) !== expected) return 'active-generation-changed'
    this.pointer = pointer
    return 'committed'
  }
  async discardUncommittedGeneration(id) {
    this.snapshots.delete(id)
  }
}

function sessionArea() {
  const values = new Map()
  return {
    async get(key) {
      return values.has(key) ? { [key]: structuredClone(values.get(key)) } : {}
    },
    async set(entries) {
      for (const [key, value] of Object.entries(entries)) values.set(key, structuredClone(value))
    },
    async remove(key) {
      values.delete(key)
    }
  }
}

async function fixture() {
  const storageRepository = new MemoryStorage()
  const credentialRepository = new InMemoryCredentialRepository()
  const credential = createLedgerMultichainHardwareCredential({
    deviceModel: 'nanoX',
    deviceName: 'Ledger Test',
    accounts: [{ family: 'evm', accountIndex: 0, derivationPath: path, publicKey, address }]
  })
  const provisioned = await new LedgerHardwareProvisioningCoordinator({
    credentialRepository,
    storageRepository,
    now: () => 1_700_000_000_000
  }).provision({
    credential,
    displayName: 'Ledger',
    password: 'test-ledger-password',
    network: 'mainnet'
  })
  const snapshot = await storageRepository.getSnapshot(provisioned.generationId)
  const chainAccount = snapshot.chainAccounts.find(item => item.scope.chainId === chainId)
  assert.ok(chainAccount)
  let activeContext = {
    generationId: provisioned.generationId,
    chainAccount,
    keyDomainSource: snapshot.keyDomains[0].source
  }
  const resolver = new HardwareEvmSigningContextResolver({
    storageRepository,
    credentialRepository,
    network: 'mainnet',
    credentials: {
      hasUnlockSession: async () => true,
      getProvisioningPassword: async () => 'test-ledger-password'
    }
  })
  const broadcasts = []
  let transactionIndex = 0
  const rpc = {
    assertExpectedChain: async () => {},
    getNativeBalance: async () => '1000000000000000000',
    getPendingNonce: async () => '7',
    simulateCall: async () => '0x',
    estimateGas: async () => '70000',
    getMaximumPriorityFeePerGas: async () => '1000000000',
    getLatestBlockFee: async () => ({ blockNumber: '100', baseFeePerGas: '2000000000' }),
    broadcastRawTransaction: async raw => {
      broadcasts.push(raw)
      return keccak256(raw)
    },
    hasTransaction: async () => true,
    getTransactionReceipt: async () => null,
    getFinalizedBlockNumber: async () => '100'
  }
  const orchestrator = new EvmTransferOrchestrator({
    repository: new InMemoryTransactionRepository(),
    pendingStore: new ChromeSessionEvmPendingTransferStore(sessionArea()),
    signer: {
      prepare: async () => {
        throw new Error('Internal signer must not run')
      },
      confirm: async () => {
        throw new Error('Internal signer must not run')
      },
      cancel: async () => {}
    },
    rpc,
    assets: createAssetRegistry(
      createEvmBitcoinChainRegistry('mainnet'),
      getBundledEvmAssetDefinitions('mainnet')
    ),
    now: () => 1_000,
    createId: () => `ledger-approve-${++transactionIndex}`,
    createExternalRequestId: () => crypto.randomUUID()
  })
  const controller = new BackgroundEvmTransferController({
    orchestrator,
    loadActiveContext: async () => activeContext,
    resolveExternalSigner: chain => resolver.resolve(chain),
    readTokenAllowance: async () => '0'
  })
  return {
    controller,
    broadcasts,
    chainAccount,
    setActiveContext: value => {
      activeContext = value
    }
  }
}

async function prepareApproval(controller) {
  const review = await controller.prepareContractCall({
    chainId,
    contractAddress: token,
    valueRaw: '0',
    calldata
  })
  assert.equal(review.graph.root.kind, 'approve')
  const transactionId = review.graph.root.id
  const fingerprint = review.review.payloadFingerprint.digestHex
  const approval = await controller.approve(transactionId, fingerprint)
  assert.equal(approval.status, 'external-signature-required')
  const request = await controller.getExternalSigningRequest(transactionId)
  assert.equal(request.vendor, 'ledger')
  assert.equal(request.ledgerRequest.derivationPath, path)
  assert.equal(request.ledgerRequest.expectedAddress, address)
  return { transactionId, fingerprint, request }
}

async function signatureFor(unsignedTransactionHex, signer = ledgerAccount) {
  const signed = await signer.signTransaction(parseTransaction(unsignedTransactionHex))
  const parsed = parseTransaction(signed)
  return `${parsed.r}${parsed.s.slice(2)}${parsed.yParity.toString(16).padStart(2, '0')}`
}

it('loads an approved Ledger EVM review from its external signing request', async t => {
  const { controller } = await fixture()
  const { transactionId, fingerprint, request } = await prepareApproval(controller)
  const originalChrome = globalThis.chrome
  t.mock.method(Date, 'now', () => 1_000)
  const messages = []
  globalThis.chrome = {
    runtime: {
      sendMessage: async message => {
        messages.push(message)
        return { result: request }
      }
    }
  }
  try {
    const view = await loadLedgerSigningView({ family: 'evm', transactionId })
    assert.deepEqual(messages, [{ type: 'GET_KEYSTONE_EVM_SIGNING_REQUEST', transactionId }])
    assert.deepEqual(view.scope, { ...request.scope, chainId })
    assert.deepEqual(view.summary, request.summary)
    assert.equal(view.payloadFingerprint.digestHex, fingerprint)
  } finally {
    globalThis.chrome = originalChrome
  }
})

it('binds a Swap continuation to the approved Ledger calldata and active account', async () => {
  const { controller, chainAccount } = await fixture()
  const { transactionId, request } = await prepareApproval(controller)
  const originalChrome = globalThis.chrome
  const values = new Map()
  globalThis.chrome = {
    storage: {
      local: {
        get: async key => (key === null ? Object.fromEntries(values) : { [key]: values.get(key) }),
        set: async entries => {
          for (const [key, value] of Object.entries(entries)) values.set(key, value)
        },
        remove: async key => {
          values.delete(key)
        }
      }
    }
  }
  const active = {
    network: 'mainnet',
    walletId: chainAccount.scope.keyDomainId,
    accountId: chainAccount.scope.accountId
  }
  const input = {
    transactionId,
    ...active,
    chainId,
    token,
    spender,
    owner: address,
    amountRaw: '123',
    sourceAssetId: 'eip155:1/erc20:source',
    destinationAssetId: 'eip155:1/native:destination',
    amountIn: '1.25',
    recipientAddress: address,
    sourceMode: 'main',
    destinationMode: 'main',
    customRecipient: false
  }
  const router = { getExternalSigningRequest: async () => request }
  try {
    await assert.rejects(
      saveSwapApprovalContinuation({ ...input, spender: address }, router, async () => active),
      /does not match/
    )
    await assert.rejects(
      saveSwapApprovalContinuation({ ...input, amountRaw: '124' }, router, async () => active),
      /does not match/
    )
    assert.equal(values.size, 0)
    let reads = 0
    await assert.rejects(
      saveSwapApprovalContinuation(input, router, async () =>
        ++reads === 1 ? active : { ...active, accountId: 'account:changed' }
      ),
      /Active account changed/
    )
    assert.equal(values.size, 0)
    const saved = await saveSwapApprovalContinuation(input, router, async () => active)
    assert.equal(saved.transactionId, transactionId)
    assert.equal(values.size, 1)
  } finally {
    globalThis.chrome = originalChrome
  }
})

it('accepts only canonical bounded EVM BIP-44 hardware paths', () => {
  const chainAccount = {
    scope: { chainId },
    derivation: { scheme: 'bip44', path },
    identity: { kind: 'account-identifier', value: address }
  }
  assert.deepEqual(parseEvmAccountBinding(chainAccount, chainId), { address, addressIndex: 2 })
  for (const malformed of [
    "m/44'/60'/07'/0/2",
    "m/44'/60'/7'/0/02",
    "m/43'/60'/7'/0/2",
    "m/44'/61'/7'/0/2",
    "m/44'/60'/7'/1/2",
    "m/44'/60'/2147483648'/0/2",
    "m/44'/60'/7'/0/2147483648"
  ]) {
    assert.throws(
      () =>
        parseEvmAccountBinding(
          {
            ...chainAccount,
            derivation: { scheme: 'bip44', path: malformed }
          },
          chainId
        ),
      /Invalid EVM ChainAccount/
    )
  }
})

it('uses the registered Ledger EVM path for ERC-20 approval and broadcasts only a bound signature', async () => {
  const { controller, broadcasts, chainAccount, setActiveContext } = await fixture()
  const invalid = await prepareApproval(controller)
  const originalSignature = await signatureFor(invalid.request.ledgerRequest.unsignedTransactionHex)
  const invalidSignature = `${originalSignature.slice(0, -2)}${originalSignature.endsWith('00') ? '01' : '00'}`
  await assert.rejects(
    () =>
      controller.submitExternalSignature(
        invalid.transactionId,
        invalid.fingerprint,
        invalidSignature
      ),
    /signature|sender|address|signed/i
  )
  assert.equal(broadcasts.length, 0)

  const valid = await prepareApproval(controller)
  const validSignature = await signatureFor(valid.request.ledgerRequest.unsignedTransactionHex)
  setActiveContext({
    generationId: 'storage-v2:changed',
    chainAccount: {
      ...chainAccount,
      scope: { ...chainAccount.scope, accountId: 'account:changed' }
    },
    keyDomainSource: {
      kind: 'hardware',
      vendor: 'ledger',
      firmwareProfile: 'multi-app',
      capabilities: ['evm']
    }
  })
  await assert.rejects(
    () =>
      controller.submitExternalSignature(valid.transactionId, valid.fingerprint, validSignature),
    /not found|account|scope/i
  )
  assert.equal(broadcasts.length, 0)
  setActiveContext({
    generationId: 'storage-v2:original',
    chainAccount,
    keyDomainSource: {
      kind: 'hardware',
      vendor: 'ledger',
      firmwareProfile: 'multi-app',
      capabilities: ['evm']
    }
  })
  const result = await controller.submitExternalSignature(
    valid.transactionId,
    valid.fingerprint,
    validSignature
  )
  assert.equal(result.status, 'broadcast')
  assert.equal(broadcasts.length, 1)
  const signed = parseTransaction(broadcasts[0])
  assert.equal(signed.to.toLowerCase(), token)
  assert.equal(signed.data, calldata)
})
