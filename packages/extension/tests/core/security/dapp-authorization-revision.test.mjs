import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DAppManager } from '../../../src/core/dapp/dapp-manager.ts'

const origin = 'https://connected.example'
const account = { walletId: 'wallet-1', accountId: 'account-1' }
const otherAccount = { walletId: 'wallet-2', accountId: 'account-2' }

function managerFixture() {
  const values = new Map()
  let writes = 0
  let failNextWrite = false
  const storage = {
    async get(keys) {
      return Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys])
          .filter(key => values.has(key))
          .map(key => [key, structuredClone(values.get(key))])
      )
    },
    async set(items) {
      writes += 1
      if (failNextWrite) {
        failNextWrite = false
        throw new Error('Storage write failed')
      }
      for (const [key, value] of Object.entries(items)) values.set(key, structuredClone(value))
    }
  }
  return {
    manager: new DAppManager(storage),
    storage,
    get writes() {
      return writes
    },
    failNextWrite() {
      failNextWrite = true
    }
  }
}

test('combined Native and Public approval commits one revision and preserves both grants on failure', async () => {
  const fixture = managerFixture()
  const { manager, storage } = fixture
  const first = await manager.setNativeAndPublicAuthorizedAccount(origin, {}, account, 0)
  assert.equal(first, 1)
  assert.equal(fixture.writes, 1)
  assert.deepEqual(await manager.getAuthorizedAccounts(origin), [account])
  assert.deepEqual(await manager.getPublicAuthorization(origin), {
    revision: first,
    binding: account
  })
  assert.equal(await manager.canAutoConnect(origin), false)

  await assert.rejects(
    manager.setNativeAndPublicAuthorizedAccount(origin, {}, otherAccount, 0),
    /Site authorization changed/
  )
  assert.equal(fixture.writes, 1)
  fixture.failNextWrite()
  await assert.rejects(
    manager.setNativeAndPublicAuthorizedAccount(origin, {}, otherAccount, first),
    /Storage write failed/
  )
  assert.equal(fixture.writes, 2)
  const reloaded = new DAppManager(storage)
  assert.equal(await reloaded.getAuthorizationRevision(origin), first)
  assert.deepEqual(await reloaded.getAuthorizedAccounts(origin), [account])
  assert.deepEqual((await reloaded.getPublicAuthorization(origin)).binding, account)

  const second = await reloaded.setNativeAndPublicAuthorizedAccount(origin, {}, otherAccount, first)
  assert.equal(second, first + 1)
  const afterRestart = new DAppManager(storage)
  assert.deepEqual(await afterRestart.getAuthorizedAccounts(origin), [otherAccount])
  assert.deepEqual(await afterRestart.getPublicAuthorization(origin), {
    revision: second,
    binding: otherAccount
  })
})

test('explicit revocation survives reload and a stale connect approval cannot restore access', async () => {
  const { manager, storage } = managerFixture()
  await manager.setAuthorizedAccounts(origin, {}, [account], account, { automatic: true })
  assert.deepEqual((await manager.getAuthorization(origin)).accounts, [account])
  const pendingRevision = await manager.getAuthorizationRevision(origin)

  await manager.removeConnection(origin)
  const reloaded = new DAppManager(storage)
  assert.equal(await reloaded.isRevoked(origin), true)
  assert.equal(await reloaded.canAutoConnect(origin), false)
  assert.deepEqual(await reloaded.getAuthorizedAccounts(origin), [])
  await assert.rejects(
    reloaded.setAuthorizedAccounts(origin, {}, [account], account, { automatic: true }),
    /Site authorization changed/
  )
  await assert.rejects(
    reloaded.setAuthorizedAccounts(origin, {}, [account], account, {
      expectedRevision: pendingRevision
    }),
    /Site authorization changed/
  )

  const reconnectRevision = await reloaded.getAuthorizationRevision(origin)
  await reloaded.setAuthorizedAccounts(origin, {}, [account], account, {
    expectedRevision: reconnectRevision
  })
  assert.equal(await reloaded.isRevoked(origin), false)
  assert.deepEqual(await reloaded.getAuthorizedAccounts(origin), [account])

  await reloaded.clearConnections()
  const afterModeChange = new DAppManager(storage)
  assert.equal(await afterModeChange.isRevoked(origin), true)
  assert.deepEqual(await afterModeChange.getAuthorizedAccounts(origin), [])
})

test('Public authorization uses shared revision CAS and explicit history survives restart and disconnect', async () => {
  const { manager, storage } = managerFixture()
  const favicon = `data:image/png;base64,${'A'.repeat(20_000)}`
  const first = await manager.setPublicAuthorizedAccount(
    origin,
    { favIconUrl: favicon },
    account,
    0
  )
  assert.equal(first, 1)
  assert.deepEqual(await manager.getPublicAuthorization(origin), {
    revision: first,
    binding: account
  })
  assert.equal(await manager.canAutoConnect(origin), false)
  assert.equal(await manager.isRevoked(origin), false)

  await assert.rejects(
    manager.setPublicAuthorizedAccount(origin, {}, otherAccount, 0),
    /Site authorization changed/
  )
  assert.deepEqual((await manager.getPublicAuthorization(origin)).binding, account)

  const reloaded = new DAppManager(storage)
  assert.deepEqual(await reloaded.getPublicAuthorization(origin), {
    revision: first,
    binding: account
  })
  assert.equal(await reloaded.canAutoConnect(origin), false)
  const second = await reloaded.setPublicAuthorizedAccount(origin, {}, otherAccount, first)
  assert.equal(second, first + 1)
  await reloaded.removeLegacyAuthorization(origin)
  assert.equal(await reloaded.isRevoked(origin), true)
  assert.deepEqual((await reloaded.getPublicAuthorization(origin)).binding, otherAccount)

  const removed = await reloaded.removePublicAuthorization(origin)
  assert.equal(removed, second + 2)
  assert.deepEqual(await reloaded.getPublicAuthorization(origin), {
    revision: removed,
    binding: null
  })
  const afterRemoval = new DAppManager(storage)
  assert.equal(await afterRemoval.canAutoConnect(origin), false)
  await assert.rejects(
    afterRemoval.setPublicAuthorizedAccount(origin, {}, account, second),
    /Site authorization changed/
  )
  await afterRemoval.setPublicAuthorizedAccount(origin, {}, account, removed)
  await afterRemoval.removeConnection(origin)
  assert.equal((await afterRemoval.getPublicAuthorization(origin)).binding, null)
  assert.equal(await new DAppManager(storage).canAutoConnect(origin), false)
})

test('Native approval and revocation do not change Public binding or its Native mode', async () => {
  const { manager, storage } = managerFixture()
  const publicRevision = await manager.setPublicAuthorizedAccount(origin, {}, account, 0)
  const nativeRevision = await manager.setAuthorizedAccounts(
    origin,
    {},
    [otherAccount],
    otherAccount,
    {
      expectedRevision: publicRevision
    }
  )
  assert.equal(nativeRevision, publicRevision + 1)
  assert.deepEqual((await manager.getPublicAuthorization(origin)).binding, account)
  assert.deepEqual(await manager.getAuthorizedAccounts(origin), [otherAccount])
  await assert.rejects(
    manager.setPublicAuthorizedAccount(origin, {}, otherAccount, publicRevision),
    /Site authorization changed/
  )

  const removedPublicRevision = await manager.removePublicAuthorization(origin)
  assert.equal(removedPublicRevision, nativeRevision + 1)
  assert.deepEqual(await manager.getAuthorizedAccounts(origin), [otherAccount])
  assert.equal(await manager.isRevoked(origin), false)
  await manager.setPublicAuthorizedAccount(origin, {}, account, removedPublicRevision)

  await manager.removeLegacyAuthorization(origin)
  assert.equal(await manager.isRevoked(origin), true)
  assert.deepEqual((await manager.getPublicAuthorization(origin)).binding, account)
  const next = await manager.setPublicAuthorizedAccount(
    origin,
    {},
    otherAccount,
    await manager.getAuthorizationRevision(origin)
  )
  assert.equal(await manager.isRevoked(origin), true)
  assert.equal(next, await manager.getAuthorizationRevision(origin))
  assert.deepEqual(
    (await new DAppManager(storage).getPublicAuthorization(origin)).binding,
    otherAccount
  )
})

test('Public chain removal and account cleanup invalidate previously reviewed revisions', async () => {
  const { manager } = managerFixture()
  const granted = await manager.setPublicAuthorizedAccount(origin, {}, account, 0)
  await manager.removeChainAuthorization(origin, 'noir:mainnet')
  const afterChainRemoval = await manager.getAuthorizationRevision(origin)
  assert.equal(afterChainRemoval, granted + 1)
  assert.equal((await manager.getPublicAuthorization(origin)).binding, null)
  await assert.rejects(
    manager.setPublicAuthorizedAccount(origin, {}, account, granted),
    /Site authorization changed/
  )

  const rebound = await manager.setPublicAuthorizedAccount(origin, {}, account, afterChainRemoval)
  await manager.removeAccountReferences(account.walletId, account.accountId)
  assert.equal(await manager.getAuthorizationRevision(origin), rebound + 1)
  assert.equal((await manager.getPublicAuthorization(origin)).binding, null)

  const again = await manager.setPublicAuthorizedAccount(
    origin,
    {},
    account,
    await manager.getAuthorizationRevision(origin)
  )
  await manager.removeChainAuthorizations(['noir:mainnet'])
  assert.equal(await manager.getAuthorizationRevision(origin), again + 1)
  assert.equal((await manager.getPublicAuthorization(origin)).binding, null)
})

test('CAIP session commit rejects a Public grant raced against its reviewed revision', async () => {
  const { manager } = managerFixture()
  const chainId = 'eip155:1'
  const authorizations = [{ chainId, accounts: [account], binding: account }]
  const session = {
    scopes: [{ chainId, methods: ['eth_accounts'], notifications: [] }]
  }
  const reviewedRevision = await manager.getAuthorizationRevision(origin)
  const publicRevision = await manager.setPublicAuthorizedAccount(
    origin,
    {},
    otherAccount,
    reviewedRevision
  )
  await assert.rejects(
    manager.setCaip25Session(origin, {}, authorizations, session, undefined, reviewedRevision),
    /Site authorization changed/
  )
  assert.equal(await manager.getChainAuthorization(origin, chainId), null)
  const committedRevision = await manager.setCaip25Session(
    origin,
    {},
    authorizations,
    session,
    undefined,
    publicRevision
  )
  assert.equal(committedRevision, publicRevision + 1)
  assert.deepEqual((await manager.getPublicAuthorization(origin)).binding, otherAccount)
  assert.equal(await manager.isRevoked(origin), false)
  assert.deepEqual((await manager.getChainAuthorization(origin, chainId)).binding, account)
})

test('Public chain ID is exact and the generic chain grant cannot bypass revision CAS', async () => {
  const { manager } = managerFixture()
  await assert.rejects(
    manager.setChainAuthorizedAccounts(origin, {}, 'noir:mainnet', [account], account),
    /reviewed revision/
  )
  await assert.rejects(
    manager.setChainAuthorizedAccounts(origin, {}, 'noir:testnet', [account], account),
    /released provider chain/
  )
  assert.equal(await manager.getAuthorizationRevision(origin), 0)
})

test('Other chain revisions preserve legacy Native auto-connect eligibility', async () => {
  const { manager, storage } = managerFixture()
  await manager.setChainAuthorizedAccounts(origin, {}, 'eip155:1', [account], account)
  assert.equal(await manager.getAuthorizationRevision(origin), 1)
  assert.equal(await new DAppManager(storage).canAutoConnect(origin), true)
  await manager.setAuthorizedAccounts(origin, {}, [account], account, { automatic: true })
  assert.deepEqual(await manager.getAuthorizedAccounts(origin), [account])
  assert.equal(await manager.getAuthorizationRevision(origin), 1)

  await manager.removeLegacyAuthorization(origin)
  assert.equal(await manager.canAutoConnect(origin), false)
  await assert.rejects(
    manager.setAuthorizedAccounts(origin, {}, [account], account, { automatic: true }),
    /Site authorization changed/
  )
})
