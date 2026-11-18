import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  choosePublicAccountCandidate,
  isPublicScopeCandidate,
  publicAccountLookupKey,
  publicScopeAuthorizesAccount,
  PUBLIC_ACCOUNT_SELECTION_METHODS,
  rankPublicAccountCandidates
} from '../../../../src/core/services/noir-protocol/public/account-selection.ts'

const account = {
  chain: 'evm',
  network: 'mainnet',
  publicKey: '0x1111111111111111111111111111111111111111',
  signingMode: 'evm',
  address: '0x1111111111111111111111111111111111111111',
  mcaId: null,
  parentContractId: 'ma.private-mainnet.ref-dev-team.near',
  status: 'inactive'
}

test('Public scope selection requires complete permission for the active account', () => {
  const zcashScope = 'bip122:00040fe8ec8471911baa1db1266ea15d'
  const active = { walletId: 'wallet-current', accountId: 'account-current' }
  const grant = {
    chainId: 'eip155:1',
    methods: PUBLIC_ACCOUNT_SELECTION_METHODS,
    accounts: [{ walletId: 'wallet-other', accountId: 'account-other' }]
  }
  assert.equal(isPublicScopeCandidate(grant, zcashScope), true)
  assert.equal(publicScopeAuthorizesAccount(grant, active, zcashScope), false)
  assert.equal(
    publicScopeAuthorizesAccount({ ...grant, accounts: [active] }, active, zcashScope),
    true
  )
  const storedZcashScope = { chainId: zcashScope, methods: PUBLIC_ACCOUNT_SELECTION_METHODS }
  assert.equal(publicScopeAuthorizesAccount(storedZcashScope, active, zcashScope, [active]), true)
  assert.equal(
    publicScopeAuthorizesAccount(storedZcashScope, active, zcashScope, grant.accounts),
    false
  )
  assert.equal(
    publicScopeAuthorizesAccount({ ...grant, accounts: undefined }, active, zcashScope, [active]),
    false
  )
  assert.equal(
    isPublicScopeCandidate(
      {
        ...grant,
        methods: grant.methods.filter(method => method !== 'noir_sendPublicTransaction')
      },
      zcashScope
    ),
    false
  )
  assert.equal(isPublicScopeCandidate({ ...grant, chainId: 'eip155:0' }, zcashScope), false)
})

test('Public MCA lookup deduplicates EVM networks sharing one active identity', () => {
  const identity = {
    network: 'mainnet',
    walletId: 'wallet-current',
    accountId: 'account-current',
    evmAddress: account.address
  }
  assert.equal(
    publicAccountLookupKey({ ...identity, chainId: 'eip155:1' }),
    publicAccountLookupKey({ ...identity, chainId: 'eip155:8453' })
  )
  assert.notEqual(
    publicAccountLookupKey({ ...identity, chainId: 'eip155:1' }),
    publicAccountLookupKey({ ...identity, chainId: 'eip155:1', evmAddress: `0x${'2'.repeat(40)}` })
  )
})

test('Public account ranking reuses MCA before preferring native gas', () => {
  const funded = { scope: 'eip155:1', account, nativeGas: 'positive' }
  const existing = {
    scope: 'eip155:8453',
    account: { ...account, mcaId: 'existing.near', status: 'active' },
    nativeGas: 'zero'
  }
  const pending = {
    scope: 'eip155:137',
    account: { ...account, status: 'activating' },
    nativeGas: 'unknown'
  }
  assert.deepEqual(rankPublicAccountCandidates([funded, pending, existing]), [
    existing,
    pending,
    funded
  ])
})

test('Public account ranking keeps an unfunded single scope and orders unknown gas deterministically', () => {
  const unfunded = { scope: 'eip155:1', account, nativeGas: 'zero' }
  const unknown = { scope: 'eip155:8453', account, nativeGas: 'unknown' }
  const positive = { scope: 'eip155:137', account, nativeGas: 'positive' }
  assert.deepEqual(rankPublicAccountCandidates([unfunded]), [unfunded])
  assert.deepEqual(rankPublicAccountCandidates([unknown, unfunded, positive]), [
    positive,
    unknown,
    unfunded
  ])
  assert.deepEqual(
    rankPublicAccountCandidates([
      { ...unknown, scope: 'eip155:8453' },
      { ...unknown, scope: 'eip155:10' }
    ]).map(candidate => candidate.scope),
    ['eip155:10', 'eip155:8453']
  )
})

test('an unknown MCA candidate cannot displace an existing MCA or justify a new activation', () => {
  const active = {
    scope: 'eip155:1',
    account: { ...account, mcaId: 'existing.near', status: 'active' },
    nativeGas: 'zero'
  }
  const inactive = { scope: 'eip155:8453', account, nativeGas: 'positive' }
  assert.equal(choosePublicAccountCandidate([active, inactive], 1), active)
  assert.throws(() => choosePublicAccountCandidate([inactive], 1), /status is unavailable/)
  assert.throws(() => choosePublicAccountCandidate([], 1), /status is unavailable/)
})
