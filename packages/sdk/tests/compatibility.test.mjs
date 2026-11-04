import assert from 'node:assert/strict'
import test from 'node:test'
import { validateVerifiedPublishedProvenance } from '../../../scripts/sdk-package-check.mjs'
import {
  ZcashAPI,
  detectProvider,
  getNoirWallet,
  getZcashProvider,
  isNoirWalletInstalled
} from '../dist/index.mjs'

test('provider discovery handles server and uninstalled environments', async () => {
  const previousWindow = globalThis.window
  try {
    delete globalThis.window
    assert.equal(getNoirWallet(), null)
    assert.equal(getZcashProvider(), null)
    assert.equal(isNoirWalletInstalled(), false)
    await assert.rejects(detectProvider(), /window is undefined/)

    globalThis.window = { addEventListener() {} }
    assert.equal(getNoirWallet(), null)
    assert.equal(getZcashProvider(), null)
    await assert.rejects(detectProvider(0), /Noir Wallet is not installed/)
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('V1 single-account responses retain the multi-account SDK contract', async () => {
  const legacyAddress = { transparent: 't-legacy', shielded: 'zs-legacy' }
  const legacyBalance = { transparent: '1.0', shielded: '2.0', total: '3.0' }
  const requested = []
  const provider = {
    async request(args) {
      requested.push(args)
      if (args.method === 'zcash_requestAccounts') return legacyAddress
      if (args.method === 'zcash_getBalance') return legacyBalance
      throw new Error(`Unexpected method: ${args.method}`)
    },
    on() {},
    async disconnect() {}
  }
  const api = new ZcashAPI(provider)

  assert.deepEqual(await api.connect(), {
    ...legacyAddress,
    accounts: [
      {
        id: 'current',
        label: 'Current Account',
        walletId: '',
        accountId: '',
        addresses: legacyAddress
      }
    ]
  })
  assert.deepEqual(await api.getBalance(), {
    ...legacyBalance,
    accounts: [
      {
        id: 'current',
        walletId: '',
        accountId: '',
        balance: legacyBalance,
        synced: true
      }
    ]
  })
  assert.deepEqual(requested, [
    { method: 'zcash_requestAccounts' },
    { method: 'zcash_getBalance', params: [] }
  ])
})

test('disconnection and request rejection reach callers unchanged', async () => {
  const rejected = new Error('User rejected the request')
  const api = new ZcashAPI({
    async request({ method }) {
      if (method === 'zcash_getAccounts') return null
      throw rejected
    },
    on() {},
    async disconnect() {}
  })

  assert.equal(await api.getAccounts(), null)
  await assert.rejects(api.connect(), error => error === rejected)
  await assert.rejects(api.getBalance(), error => error === rejected)
})

test('Public Zcash methods preserve request IDs and positional wire parameters', async () => {
  const requests = []
  const account = {
    chain: 'zcash-l2',
    network: 'testnet',
    publicKey: 'public-key',
    address: 'public-address',
    mcaId: null,
    parentContractId: 'parent',
    status: 'inactive'
  }
  const assets = { account, assets: [] }
  const transaction = { operationId: 'operation-1', requestId: 'request-1', status: 'signed' }
  const api = new ZcashAPI({
    async request(args) {
      requests.push(args)
      switch (args.method) {
        case 'zcash_activatePublicAccount':
          return account
        case 'zcash_getPublicAssets':
          return assets
        case 'zcash_sendPublicTransaction':
        case 'zcash_getPublicTransaction':
          return transaction
        default:
          throw new Error(`Unexpected method: ${args.method}`)
      }
    },
    on() {},
    async disconnect() {}
  })
  const params = {
    requestId: 'request-1',
    txRequests: [
      {
        FunctionCall: {
          receiver_id: 'contract',
          function_calls: [{ method_name: 'call', args: '{}', gas: '30000000000000', deposit: '0' }]
        }
      }
    ]
  }

  assert.deepEqual(await api.activatePublicAccount(), account)
  assert.deepEqual(await api.getPublicAssets(), assets)
  assert.deepEqual(await api.sendPublicTransaction(params), transaction)
  assert.deepEqual(await api.getPublicTransaction('operation-1'), transaction)
  assert.deepEqual(requests, [
    { method: 'zcash_activatePublicAccount' },
    { method: 'zcash_getPublicAssets' },
    { method: 'zcash_sendPublicTransaction', params: [params] },
    { method: 'zcash_getPublicTransaction', params: ['operation-1'] }
  ])
})

test('identity selectors keep Native and Public grants separate', async () => {
  const calls = []
  const native = { transparent: 't-native', shielded: 'zs-native' }
  const nativeConnection = {
    ...native,
    accounts: [
      {
        id: 'wallet:account',
        label: 'Wallet',
        walletId: 'wallet',
        accountId: 'account',
        addresses: native
      }
    ]
  }
  const publicAccount = {
    chain: 'zcash-l2',
    network: 'testnet',
    publicKey: 'public-key',
    address: 'public-address',
    mcaId: null,
    parentContractId: 'parent',
    status: 'inactive'
  }
  const api = new ZcashAPI({
    supportedSigningModes: ['current', 'derived', 'legacy_index0', 'noir_protocol_public'],
    async request(args) {
      calls.push(args)
      switch (args.method) {
        case 'zcash_requestAccounts':
          return native
        case 'zcash_getAccounts':
          return null
        case 'zcash_requestPublicAccount':
          return args.params
            ? { identities: { current: nativeConnection, noir_protocol_public: publicAccount } }
            : publicAccount
        case 'zcash_getPublicAccount':
          return null
        case 'zcash_disconnect':
        case 'zcash_disconnectPublic':
          return null
        case 'zcash_getPublicKey':
          return {
            pubkey: 'public-key',
            address: 'public-address',
            signingMode: 'noir_protocol_public'
          }
        case 'zcash_signMessage':
          return {
            signature: 'sig',
            pubkey: 'public-key',
            address: 'public-address',
            signingMode: 'noir_protocol_public'
          }
        default:
          throw new Error(`Unexpected method: ${args.method}`)
      }
    },
    on() {},
    async disconnect() {}
  })
  const normalized = {
    ...native,
    accounts: [
      { id: 'current', label: 'Current Account', walletId: '', accountId: '', addresses: native }
    ]
  }

  assert.deepEqual(await api.connect(), normalized)
  assert.deepEqual(await api.connect({ signingMode: 'noir_protocol_public' }), publicAccount)
  assert.deepEqual(await api.connect({ signingModes: ['noir_protocol_public'] }), {
    identities: { noir_protocol_public: publicAccount }
  })
  assert.deepEqual(await api.connect({ signingModes: ['noir_protocol_public', 'current'] }), {
    identities: { current: nativeConnection, noir_protocol_public: publicAccount }
  })
  assert.equal(await api.getAccounts({ signingMode: 'noir_protocol_public' }), null)
  assert.deepEqual(await api.getAccounts({ signingModes: ['current', 'noir_protocol_public'] }), {
    identities: { current: null, noir_protocol_public: null }
  })
  assert.deepEqual(await api.getPublicKey({ signingMode: 'noir_protocol_public' }), {
    pubkey: 'public-key',
    address: 'public-address',
    signingMode: 'noir_protocol_public'
  })
  assert.deepEqual(await api.signMessage('hello', { signingMode: 'noir_protocol_public' }), {
    signature: 'sig',
    pubkey: 'public-key',
    address: 'public-address',
    signingMode: 'noir_protocol_public'
  })
  await api.disconnect({ signingModes: ['noir_protocol_public', 'current'] })
  assert.deepEqual(calls, [
    { method: 'zcash_requestAccounts' },
    { method: 'zcash_requestPublicAccount' },
    { method: 'zcash_requestPublicAccount' },
    {
      method: 'zcash_requestPublicAccount',
      params: [{ signingModes: ['current', 'noir_protocol_public'] }]
    },
    { method: 'zcash_getPublicAccount' },
    { method: 'zcash_getAccounts' },
    { method: 'zcash_getPublicAccount' },
    { method: 'zcash_getPublicKey', params: [{ signingMode: 'noir_protocol_public' }] },
    { method: 'zcash_signMessage', params: ['hello', { signingMode: 'noir_protocol_public' }] },
    { method: 'zcash_disconnect' },
    { method: 'zcash_disconnectPublic' }
  ])
})

test('unsupported and invalid selectors never fall back to Native RPC', async () => {
  const calls = []
  const api = new ZcashAPI({
    async request(args) {
      calls.push(args)
      throw new Error('Unexpected request')
    },
    on() {},
    async disconnect() {}
  })
  for (const selection of [
    { signingMode: 'noir_protocol_public' },
    { signingModes: ['current', 'noir_protocol_public'] }
  ]) {
    await assert.rejects(api.connect(selection), /does not support/)
    await assert.rejects(api.getAccounts(selection), /does not support/)
    await assert.rejects(api.disconnect(selection), /does not support/)
  }
  await assert.rejects(
    api.getPublicKey({ signingMode: 'noir_protocol_public' }),
    /does not support/
  )
  await assert.rejects(
    api.signMessage('hello', { signingMode: 'noir_protocol_public' }),
    /does not support/
  )
  for (const selection of [
    { signingModes: [] },
    { signingModes: ['current', 'current'] },
    { signingModes: ['unknown'] },
    { signingMode: 'unknown' },
    { signingMode: 'current', unexpected: true },
    { signingMode: 'current', signingModes: ['current'] }
  ]) {
    await assert.rejects(api.connect(selection), TypeError)
    await assert.rejects(api.getAccounts(selection), TypeError)
    await assert.rejects(api.disconnect(selection), TypeError)
  }
  for (const options of [
    null,
    [],
    { signingMode: 'unknown' },
    { signingModes: ['noir_protocol_public'] },
    { signingMode: 'current', unexpected: true }
  ]) {
    await assert.rejects(api.getPublicKey(options), TypeError)
    await assert.rejects(api.signMessage('hello', options), TypeError)
  }
  assert.deepEqual(calls, [])
})

test('combined connection rejects incomplete identity responses', async () => {
  const publicAccount = {
    chain: 'zcash-l2',
    network: 'mainnet',
    publicKey: 'public-key',
    address: 'public-address',
    mcaId: null,
    parentContractId: 'parent',
    status: 'inactive'
  }
  for (const response of [
    null,
    { identities: {} },
    { identities: { current: { transparent: 't', shielded: 'zs' } } },
    { identities: { current: { transparent: 't', shielded: 'zs' }, noir_protocol_public: null } },
    {
      identities: {
        current: { transparent: 't', shielded: 'zs' },
        noir_protocol_public: publicAccount
      }
    },
    {
      identities: {
        current: { transparent: 't', shielded: 'zs', accounts: [] },
        noir_protocol_public: publicAccount
      }
    }
  ]) {
    const api = new ZcashAPI({
      supportedSigningModes: ['noir_protocol_public'],
      async request() {
        return response
      },
      on() {},
      async disconnect() {}
    })
    await assert.rejects(
      api.connect({ signingModes: ['current', 'noir_protocol_public'] }),
      /Invalid combined connection response/
    )
  }
})

test('scoped account listeners isolate Public and Native event channels', () => {
  const listeners = new Map()
  const api = new ZcashAPI({
    async request() {},
    on(event, handler) {
      listeners.set(event, handler)
    },
    removeListener(event, handler) {
      if (listeners.get(event) === handler) listeners.delete(event)
    },
    async disconnect() {}
  })
  const native = () => {}
  const publicHandler = () => {}
  api.on('accountsChanged', native)
  api.on('accountsChanged', native, { signingMode: 'current' })
  api.on('accountsChanged', publicHandler, { signingMode: 'noir_protocol_public' })
  assert.equal(listeners.get('accountsChanged'), native)
  assert.equal(listeners.get('publicAccountChanged'), publicHandler)
  assert.throws(
    () => api.on('accountsChanged', publicHandler, { signingMode: 'unknown' }),
    TypeError
  )
  assert.throws(
    () => api.removeListener('accountsChanged', native, { signingMode: 'unknown' }),
    TypeError
  )
  api.removeListener('accountsChanged', publicHandler, { signingMode: 'noir_protocol_public' })
  assert.equal(listeners.has('publicAccountChanged'), false)
  api.removeListener('accountsChanged', native, { signingMode: 'current' })
  assert.equal(listeners.has('accountsChanged'), false)
})

test('npm-verified provenance must bind the signer and accepted build', async () => {
  const metadata = {
    version: '0.1.9',
    sourceSha: 'a'.repeat(40),
    workflowSha: 'b'.repeat(40),
    runId: 123,
    runAttempt: 2,
    integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`
  }
  const statement = {
    predicateType: 'https://slsa.dev/provenance/v1',
    subject: [
      {
        name: 'pkg:npm/%40noir-wallet/sdk@0.1.9',
        digest: { sha512: Buffer.alloc(64, 7).toString('hex') }
      }
    ],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: 'https://github.com/NoirWallet/noir-wallet',
            path: '.github/workflows/publish-sdk.yml',
            ref: 'refs/heads/main'
          }
        },
        resolvedDependencies: [
          {
            uri: 'git+https://github.com/NoirWallet/noir-wallet@refs/heads/main',
            digest: { gitCommit: metadata.workflowSha }
          }
        ]
      },
      runDetails: {
        metadata: {
          invocationId: 'https://github.com/NoirWallet/noir-wallet/actions/runs/123/attempts/3'
        }
      }
    }
  }
  const auditFor = value => ({
    verified: [
      {
        name: '@noir-wallet/sdk',
        version: metadata.version,
        registry: 'https://registry.npmjs.org/',
        attestations: { url: 'https://registry.npmjs.org/-/npm/v1/attestations/example' },
        attestationBundles: [
          {
            predicateType: 'https://slsa.dev/provenance/v1',
            bundle: {
              dsseEnvelope: { payload: Buffer.from(JSON.stringify(value)).toString('base64') }
            }
          }
        ]
      }
    ]
  })

  const tufCachePath = '/isolated/sigstore-tuf'
  const verifyBundle = async (bundle, options) => {
    assert.equal(
      bundle.dsseEnvelope.payload,
      auditFor(statement).verified[0].attestationBundles[0].bundle.dsseEnvelope.payload
    )
    assert.deepEqual(options, {
      certificateIdentityURI:
        'https://github.com/NoirWallet/noir-wallet/.github/workflows/publish-sdk.yml@refs/heads/main',
      certificateIssuer: 'https://token.actions.githubusercontent.com',
      tufCachePath
    })
  }
  await assert.doesNotReject(
    validateVerifiedPublishedProvenance(auditFor(statement), metadata, verifyBundle, tufCachePath)
  )
  await assert.rejects(
    validateVerifiedPublishedProvenance(
      auditFor(statement),
      metadata,
      async () => {
        throw new Error('certificate identity mismatch')
      },
      tufCachePath
    ),
    /certificate identity mismatch/
  )
  const wrongSource = structuredClone(statement)
  wrongSource.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit =
    metadata.sourceSha
  await assert.rejects(
    validateVerifiedPublishedProvenance(
      auditFor(wrongSource),
      metadata,
      async () => {},
      tufCachePath
    ),
    /workflow commit/
  )

  const wrongRun = structuredClone(statement)
  wrongRun.predicate.runDetails.metadata.invocationId =
    'https://github.com/NoirWallet/noir-wallet/actions/runs/124/attempts/3'
  await assert.rejects(
    validateVerifiedPublishedProvenance(auditFor(wrongRun), metadata, async () => {}, tufCachePath),
    /run identity/
  )

  const wrongSubject = structuredClone(statement)
  wrongSubject.subject[0].digest.sha512 = 'f'.repeat(128)
  await assert.rejects(
    validateVerifiedPublishedProvenance(
      auditFor(wrongSubject),
      metadata,
      async () => {},
      tufCachePath
    ),
    /subject/
  )

  await assert.rejects(
    validateVerifiedPublishedProvenance({ verified: [] }, metadata, async () => {}, tufCachePath),
    /npm-verified/
  )
})
