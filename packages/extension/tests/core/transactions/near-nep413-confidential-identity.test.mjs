import { test } from 'node:test'
import { expect } from '@playwright/test'

import { ConfidentialFundingApi } from '../../../src/background/confidential-funding-api.ts'
import { confidentialSigningChainId } from '../../../src/background/confidential-funding-coordinator.ts'
import { ConfidentialFundingSigner } from '../../../src/background/confidential-funding-signer.ts'
import { ChromeConfidentialFundingStore } from '../../../src/background/confidential-funding-store.ts'
import {
  NEAR_MOVE_EVM_PRINCIPAL,
  planNearIncognitoCluster
} from '../../../src/core/chains/near/near-incognito-move.ts'

const NAMED = 'alice.near'
const IMPLICIT = 'ab'.repeat(32)
const PEA = 'cd'.repeat(32)
const EVM = '0x1111111111111111111111111111111111111111'
const MIXED_EVM = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01'

const apiConfig = {
  oneClickApiUrl: 'https://example.test/1click',
  oneClickDirectApiUrl: 'https://direct.example.test/v0',
  rheaSwapApiUrl: 'https://example.test'
}

function nearContext(address, source, accountIndex = 0) {
  return {
    generationId: 'generation',
    chainAccount: {
      identity: { kind: 'account-identifier', value: address },
      scope: {
        keyDomainId: 'wallet:one',
        accountId: 'account:one',
        chainId: 'near:mainnet'
      }
    },
    keyDomainSource: source,
    accountIndex,
    publicKey: 'ed25519:access-key'
  }
}

function authEnvelope(signerId) {
  return JSON.stringify({
    message: JSON.stringify({
      signer_id: signerId,
      deadline: '2030-01-01T00:00:00.000Z',
      intents: []
    }),
    recipient: 'intents.near',
    nonce: Buffer.from(new Uint8Array(32).fill(9)).toString('base64')
  })
}

function createNearSigner({ address, source, accountIndex = 0, pea = PEA, hasKey = false }) {
  const prepares = []
  let views = 0
  let broadcasts = 0
  let derives = 0
  let registered = hasKey
  const signature = Buffer.from(new Uint8Array(64).fill(7)).toString('base64')
  const client = {
    async deriveNearPea() {
      derives += 1
      return { address: pea }
    },
    async prepare(_keyDomainId, payload) {
      prepares.push(payload)
      return {
        operation: payload.kind === 'near-nep413-message' ? 'message' : 'transaction',
        expiresAt: Date.now() + 60_000,
        commandId: `cmd-${prepares.length}`
      }
    },
    async confirm() {
      const payload = prepares.at(-1)
      if (payload.kind === 'near-transaction') {
        return { kind: 'signed-payload', payload: { encoding: 'base64', value: 'c2ln' } }
      }
      return {
        kind: 'signature',
        signature: { encoding: 'base64', value: signature },
        address,
        publicKey: 'ed25519:message-key'
      }
    },
    async cancel() {}
  }
  const rpc = {
    async viewFunction(contract, method) {
      views += 1
      if (contract !== 'intents.near' || method !== 'has_public_key') {
        throw new Error('unexpected NEAR view')
      }
      return registered
    },
    async getAccessKey() {
      return { nonce: '4', blockHash: 'block-hash' }
    },
    async broadcastSignedTransactionAndWait() {
      broadcasts += 1
      registered = true
      return {}
    }
  }
  const signer = new ConfidentialFundingSigner(
    {
      async deriveGlobalPea() {
        throw new Error('EVM derivation should not run')
      }
    },
    async () => null,
    undefined,
    {
      client,
      rpc,
      chainId: 'near:mainnet',
      loadContext: async () => nearContext(address, source, accountIndex)
    }
  )
  return {
    signer,
    prepares,
    counts: () => ({ views, broadcasts, derives })
  }
}

function storageArea() {
  const values = new Map()
  return {
    values,
    get: async key =>
      key === null
        ? Object.fromEntries(values)
        : Array.isArray(key)
          ? Object.fromEntries(
              key
                .filter(item => values.has(item))
                .map(item => [item, structuredClone(values.get(item))])
            )
          : values.has(key)
            ? { [key]: structuredClone(values.get(key)) }
            : {},
    set: async entries => {
      for (const [key, value] of Object.entries(entries)) values.set(key, structuredClone(value))
    },
    remove: async key => {
      for (const item of Array.isArray(key) ? key : [key]) values.delete(item)
    }
  }
}

function installWebLocksStub() {
  const previousLocks = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks')
  let lockTail = Promise.resolve()
  Object.defineProperty(globalThis.navigator, 'locks', {
    configurable: true,
    value: {
      request: async (_name, operation) => {
        const previous = lockTail
        let release
        lockTail = new Promise(resolve => {
          release = resolve
        })
        await previous
        try {
          return await operation()
        } finally {
          release()
        }
      }
    }
  })
  return () => {
    if (previousLocks === undefined) delete globalThis.navigator.locks
    else Object.defineProperty(globalThis.navigator, 'locks', previousLocks)
  }
}

test('selects a NEAR signing chain only after both sides miss eip155', () => {
  expect(confidentialSigningChainId('near:mainnet', 'near:mainnet', 'mainnet')).toBe('near:mainnet')
  expect(confidentialSigningChainId('near:testnet', 'near:testnet', 'mainnet')).toBe('near:testnet')
  expect(confidentialSigningChainId('near:mainnet', 'eip155:8453', 'mainnet')).toBe('eip155:8453')
  expect(confidentialSigningChainId('eip155:1', 'near:mainnet', 'mainnet')).toBe('eip155:1')
  expect(confidentialSigningChainId('eip155:1', 'eip155:8453', 'mainnet')).toBe('eip155:8453')
  expect(confidentialSigningChainId('solana:mainnet', 'solana:mainnet', 'mainnet')).toBe('eip155:1')
})

test('creates a nep413 auth payload whose signer_id is the NEAR account', async () => {
  const originalFetch = globalThis.fetch
  const salt = [...JSON.stringify('aabbccdd')].map(character => character.charCodeAt(0))
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ jsonrpc: '2.0', result: { result: salt } }), { status: 200 })
  try {
    const api = new ConfidentialFundingApi(apiConfig, 'https://near.example.test', 'swap-jwt')
    const near = await api.createAuthPayload(NAMED, 'near')
    expect(near.standard).toBe('nep413')
    const envelope = JSON.parse(near.payload)
    expect(envelope.recipient).toBe('intents.near')
    expect(envelope.verifying_contract).toBeUndefined()
    expect(JSON.parse(envelope.message)).toMatchObject({
      signer_id: NAMED,
      intents: []
    })
    const implicit = await api.createAuthPayload(IMPLICIT, 'near')
    expect(JSON.parse(JSON.parse(implicit.payload).message).signer_id).toBe(IMPLICIT)

    const evm = await api.createAuthPayload(EVM)
    expect(evm.standard).toBe('erc191')
    expect(JSON.parse(evm.payload)).toMatchObject({
      signer_id: EVM,
      verifying_contract: 'intents.near',
      intents: []
    })

    const request = {
      from_amount: '10',
      from_chain: 'near',
      from_token: 'nep141:wrap.near',
      mode: 'TRANSFER',
      signer_id: NAMED,
      withdraws: [
        {
          amount: '10',
          deposit_address: PEA,
          destination_address: PEA,
          destination_chain: 'near',
          execution_type: 'CONFIDENTIAL_1CLICK',
          sequence: 0,
          signed_payload: { standard: 'erc191', payload: '{}', signature: 'secp256k1:signature' },
          token: 'nep141:wrap.near'
        }
      ]
    }
    const bodies = []
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(init.body))
      return new Response(JSON.stringify({ code: 0, data: { order_id: 'order-1' } }), {
        status: 200
      })
    }
    await api.submitWithdraws(request, 'near')
    await api.submitWithdraws(request)
    expect(bodies.map(body => body.signer_chain_family)).toEqual(['near', 'evm'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('implicit NEAR accounts skip add_public_key and named accounts register a missing key', async () => {
  const implicit = createNearSigner({
    address: IMPLICIT,
    source: { kind: 'software' }
  })
  const implicitIdentity = await implicit.signer.resolveIdentity('near:mainnet')
  expect(implicitIdentity.kind).toBe('near')
  expect(implicitIdentity.address).toBe(IMPLICIT)
  expect(implicitIdentity.peaAddress).toBe(PEA)
  expect(implicitIdentity.peaAddress).not.toBe(implicitIdentity.address)
  const implicitSigned = await implicit.signer.signMessage({
    identity: implicitIdentity,
    chainId: 'near:mainnet',
    payload: authEnvelope(IMPLICIT)
  })
  expect(implicitSigned.standard).toBe('nep413')
  expect(implicitSigned.public_key).toBe('ed25519:message-key')
  expect(implicitSigned.signature.startsWith('ed25519:')).toBe(true)
  expect(implicitSigned.payload).toMatchObject({
    recipient: 'intents.near',
    message: JSON.parse(authEnvelope(IMPLICIT)).message
  })
  expect(implicit.prepares.map(payload => payload.kind)).toEqual(['near-nep413-message'])
  expect(implicit.prepares[0].request.accountId).toBe(IMPLICIT)
  expect(implicit.counts()).toMatchObject({ views: 0, broadcasts: 0, derives: 2 })

  const named = createNearSigner({
    address: NAMED,
    source: { kind: 'software' }
  })
  const namedIdentity = await named.signer.resolveIdentity('near:mainnet')
  expect(namedIdentity.address).toBe(NAMED)
  await named.signer.signMessage({
    identity: namedIdentity,
    chainId: 'near:mainnet',
    payload: authEnvelope(NAMED)
  })
  const registration = named.prepares.find(payload => payload.kind === 'near-transaction')
  expect(registration.transaction.signerId).toBe(NAMED)
  expect(registration.transaction.receiverId).toBe('intents.near')
  expect(registration.transaction.actions).toEqual([
    expect.objectContaining({
      type: 'functionCall',
      methodName: 'add_public_key',
      gas: '30000000000000',
      depositYocto: '1'
    })
  ])
  expect(JSON.parse(Buffer.from(registration.transaction.actions[0].args, 'base64').toString())).toEqual(
    { public_key: 'ed25519:message-key' }
  )
  expect(named.counts()).toMatchObject({ views: 2, broadcasts: 1 })
  await named.signer.signMessage({
    identity: namedIdentity,
    chainId: 'near:mainnet',
    payload: authEnvelope(NAMED)
  })
  expect(named.counts()).toMatchObject({ views: 3, broadcasts: 1 })
  expect(named.prepares.filter(payload => payload.kind === 'near-transaction')).toHaveLength(1)
})

test('rejects hardware and non-zero imported NEAR keys before deriving a confidential identity', async () => {
  const hardware = createNearSigner({
    address: NAMED,
    source: { kind: 'hardware' }
  })
  await expect(hardware.signer.resolveIdentity('near:mainnet')).rejects.toThrow(
    'NEAR private execution is unavailable'
  )
  expect(hardware.counts().derives).toBe(0)

  const imported = createNearSigner({
    address: NAMED,
    source: { kind: 'private-key', chainFamily: 'near' },
    accountIndex: 1
  })
  await expect(imported.signer.resolveIdentity('near:mainnet')).rejects.toThrow(
    'NEAR private execution is unavailable'
  )
  expect(imported.counts().derives).toBe(0)

  const importedRoot = createNearSigner({
    address: NAMED,
    source: { kind: 'private-key', chainFamily: 'near' },
    accountIndex: 0
  })
  await expect(importedRoot.signer.resolveIdentity('near:mainnet')).resolves.toMatchObject({
    kind: 'near',
    address: NAMED,
    addressIndex: 0,
    peaAddress: PEA
  })
  expect(importedRoot.counts().derives).toBe(1)

  const sameAccount = createNearSigner({
    address: NAMED,
    source: { kind: 'software' },
    pea: NAMED
  })
  await expect(sameAccount.signer.resolveIdentity('near:mainnet')).rejects.toThrow(
    'Confidential address must differ from the NEAR account'
  )
})

test('stores a NEAR session and balance without replacing the EVM cache', async () => {
  const local = storageArea()
  const session = storageArea()
  const previousChrome = globalThis.chrome
  globalThis.chrome = { storage: { local, session } }
  const restoreLocks = installWebLocksStub()
  const now = 10_000
  try {
    const store = new ChromeConfidentialFundingStore(() => now)
    const evmSession = {
      accessToken: 'evm-access',
      refreshToken: 'evm-refresh',
      expiresAt: now + 60_000,
      refreshExpiresAt: now + 120_000
    }
    const nearSession = {
      accessToken: 'near-access',
      refreshToken: 'near-refresh',
      expiresAt: now + 60_000,
      refreshExpiresAt: now + 120_000,
      signerId: NAMED
    }
    await store.putSession('mainnet', 'wallet:one', 'account:one', evmSession)
    const evmKey = [...session.values.keys()][0]
    await store.putSession('mainnet', 'wallet:one', 'account:one', nearSession)
    expect(session.values.get(evmKey)).toEqual(evmSession)
    expect([...session.values.keys()].some(key => key.endsWith(encodeURIComponent(NAMED)))).toBe(
      true
    )
    await expect(store.getSession('mainnet', 'wallet:one', 'account:one')).resolves.toEqual(
      evmSession
    )
    await expect(
      store.getSession('mainnet', 'wallet:one', 'account:one', MIXED_EVM)
    ).resolves.toEqual(evmSession)
    await expect(store.getSession('mainnet', 'wallet:one', 'account:one', NAMED)).resolves.toEqual(
      nearSession
    )

    const evmBalances = [{ tokenId: 'nep141:eth.omft.near', available: '5', source: 'intents' }]
    const nearBalances = [{ tokenId: 'nep141:wrap.near', available: '9', source: 'intents' }]
    await store.putBalances('mainnet', 'wallet:one', 'account:one', evmBalances, now)
    await store.putBalances('mainnet', 'wallet:one', 'account:one', nearBalances, now, NAMED)
    await store.putBalances(
      'mainnet',
      'wallet:one',
      'account:one',
      [{ tokenId: 'nep141:eth.omft.near', available: '1', source: 'intents' }],
      now - 1,
      EVM
    )
    await expect(store.getBalances('mainnet', 'wallet:one', 'account:one')).resolves.toEqual(
      evmBalances
    )
    await expect(store.getBalances('mainnet', 'wallet:one', 'account:one', EVM)).resolves.toEqual(
      evmBalances
    )
    await expect(store.getBalances('mainnet', 'wallet:one', 'account:one', NAMED)).resolves.toEqual(
      nearBalances
    )
  } finally {
    globalThis.chrome = previousChrome
    restoreLocks()
  }
})

function clusterQuote(overrides) {
  return {
    network: 'mainnet',
    enabledFlags: ['chain.near'],
    from: 'public',
    to: 'private',
    mainAccountId: NAMED,
    peaAccountId: PEA,
    accountIndex: 0,
    walletSource: { kind: 'software' },
    originAsset: 'nep141:wrap.near',
    destinationAsset: 'nep141:wrap.near',
    amountRaw: '1000',
    slippageBps: 50,
    implicitAccountOnChain: false,
    ...overrides
  }
}

test('uses the EVM confidential principal for an EVM-capable NEAR cluster', () => {
  const named = planNearIncognitoCluster(
    clusterQuote({ confidentialPrincipal: MIXED_EVM })
  )
  expect(named.ok).toBe(true)
  if (!named.ok) return
  const evm = MIXED_EVM.toLowerCase()
  expect(named.signerChainFamily).toBe('evm')
  expect(named.intentStandard).toBe('erc191')
  expect(named.signerId).toBe(evm)
  expect(named.deposit.signerId).toBe(evm)
  expect(named.deposit.recipient).toBe(evm)
  expect(named.deposit.recipientType).toBe('CONFIDENTIAL_INTENTS')
  expect(named.deposit.refundTo).toBe(NAMED)
  expect(named.deposit.refundType).toBe('ORIGIN_CHAIN')
  expect(named.withdraw.signerId).toBe(evm)
  expect(named.withdraw.recipient).toBe(PEA)
  expect(named.withdraw.recipientType).toBe('DESTINATION_CHAIN')
  expect(named.sourceAddress).toBe(NAMED)
  expect(named.destinationAddress).toBe(PEA)
  expect(named.fundingTransfers).toEqual([])
  expect(JSON.stringify(named)).not.toMatch(/receiverId|storage_deposit|signer_chain_family/)

  const fromPrivate = planNearIncognitoCluster(
    clusterQuote({
      from: 'private',
      to: 'public',
      mainAccountId: IMPLICIT,
      confidentialPrincipal: EVM
    })
  )
  expect(fromPrivate.ok).toBe(true)
  if (!fromPrivate.ok) return
  expect(fromPrivate.signerChainFamily).toBe('evm')
  expect(fromPrivate.intentStandard).toBe('erc191')
  expect(fromPrivate.signerId).toBe(EVM)
  expect(fromPrivate.deposit.recipient).toBe(EVM)
  expect(fromPrivate.deposit.refundTo).toBe(PEA)
  expect(fromPrivate.withdraw.recipient).toBe(IMPLICIT)
  expect(fromPrivate.destinationAddress).toBe(IMPLICIT)
  expect(fromPrivate.sourceAddress).toBe(PEA)

  const importedEvm = planNearIncognitoCluster(
    clusterQuote({
      mainAccountId: IMPLICIT,
      walletSource: { kind: 'private-key', chainFamily: 'eip155', accountIndex: 0 },
      confidentialPrincipal: EVM
    })
  )
  expect(importedEvm.ok).toBe(true)
  if (!importedEvm.ok) return
  expect(importedEvm.intentStandard).toBe('erc191')
  expect(importedEvm.signerId).toBe(EVM)
  expect(importedEvm.deposit.recipient).toBe(EVM)
  expect(importedEvm.deposit.refundTo).toBe(IMPLICIT)
  expect(importedEvm.withdraw.recipient).toBe(PEA)

  const missing = planNearIncognitoCluster(clusterQuote())
  expect(missing.ok).toBe(false)
  if (missing.ok) return
  expect(missing.error).toBe(NEAR_MOVE_EVM_PRINCIPAL)
  expect(
    planNearIncognitoCluster(clusterQuote({ confidentialPrincipal: `0x${'0'.repeat(40)}` })).ok
  ).toBe(false)
})

test('keeps the NEAR account for an imported NEAR-only cluster signer', () => {
  const imported = planNearIncognitoCluster(
    clusterQuote({
      walletSource: { kind: 'private-key', chainFamily: 'near', accountIndex: 0 },
      confidentialPrincipal: EVM
    })
  )
  expect(imported.ok).toBe(true)
  if (!imported.ok) return
  expect(imported.signerChainFamily).toBe('near')
  expect(imported.intentStandard).toBe('nep413')
  expect(imported.signerId).toBe(NAMED)
  expect(imported.deposit.signerId).toBe(NAMED)
  expect(imported.deposit.recipient).toBe(NAMED)
  expect(imported.deposit.refundTo).toBe(NAMED)
  expect(imported.withdraw.signerId).toBe(NAMED)
  expect(imported.withdraw.recipient).toBe(PEA)
  expect(imported.destinationAddress).toBe(PEA)

  const fromPrivate = planNearIncognitoCluster(
    clusterQuote({
      from: 'private',
      to: 'public',
      walletSource: { kind: 'private-key', chainFamily: 'near', accountIndex: 0 }
    })
  )
  expect(fromPrivate.ok).toBe(true)
  if (!fromPrivate.ok) return
  expect(fromPrivate.intentStandard).toBe('nep413')
  expect(fromPrivate.signerId).toBe(NAMED)
  expect(fromPrivate.deposit.refundTo).toBe(PEA)
  expect(fromPrivate.withdraw.recipient).toBe(NAMED)

  const hardware = planNearIncognitoCluster(
    clusterQuote({
      walletSource: { kind: 'hardware' },
      confidentialPrincipal: EVM
    })
  )
  expect(hardware.ok).toBe(true)
  if (!hardware.ok) return
  expect(hardware.intentStandard).toBe('nep413')
  expect(hardware.signerChainFamily).toBe('near')
  expect(hardware.signerId).toBe(NAMED)
  expect(hardware.deposit.refundTo).toBe(NAMED)
  expect(hardware.withdraw.recipient).toBe(PEA)
})
