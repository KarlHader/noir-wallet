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
