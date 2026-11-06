import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DAppManager } from '../../../src/core/dapp/dapp-manager.ts'

const origin = 'https://connected.example'
const account = { walletId: 'wallet-1', accountId: 'account-1' }

function managerFixture() {
  const values = new Map()
  const storage = {
    async get(keys) {
      return Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys])
          .filter(key => values.has(key))
          .map(key => [key, structuredClone(values.get(key))])
      )
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) values.set(key, structuredClone(value))
    }
  }
  return { manager: new DAppManager(storage), storage }
}

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

test('Public authorization metadata survives reload without restoring revoked or automatic access', async () => {
  const { manager, storage } = managerFixture()
  const revokedOrigin = 'https://revoked.example'
  const publicOrigin = 'https://public.example'
  const unreviewedOrigin = 'https://unreviewed.example'
  const legacyOrigin = 'https://legacy.example'
  await manager.setAuthorizedAccounts(origin, {}, [account], account)
  await storage.set({
    dapp_authorization_state: {
      [origin]: { revision: 3, mode: 'approved', publicExplicit: true },
      [revokedOrigin]: { revision: 4, mode: 'revoked', publicExplicit: true },
      [publicOrigin]: { revision: 5, publicExplicit: true },
      [unreviewedOrigin]: { revision: 6, mode: 'unreviewed' },
      [legacyOrigin]: { revision: 7 }
    }
  })
  const restored = new DAppManager(storage)
  await restored.initialize()
  assert.deepEqual(await restored.getAuthorization(origin), { revision: 3, accounts: [account] })
  assert.equal(await restored.isRevoked(revokedOrigin), true)
  assert.equal(await restored.canAutoConnect(revokedOrigin), false)
  assert.equal(await restored.canAutoConnect(publicOrigin), false)
  assert.deepEqual(await restored.getAuthorizedAccounts(publicOrigin), [])
  assert.equal(await restored.canAutoConnect(unreviewedOrigin), true)
  assert.equal(await restored.canAutoConnect(legacyOrigin), true)
  await assert.rejects(
    restored.setAuthorizedAccounts(publicOrigin, {}, [account], account, { automatic: true }),
    /Site authorization changed/
  )
  await assert.rejects(
    restored.setAuthorizedAccounts(unreviewedOrigin, {}, [account], account, {
      expectedRevision: 5
    }),
    /Site authorization changed/
  )
  await restored.setAuthorizedAccounts(unreviewedOrigin, {}, [account], account, {
    automatic: true,
    expectedRevision: 6
  })
  await restored.setAuthorizedAccounts(publicOrigin, {}, [account], account, {
    expectedRevision: 5
  })
  await restored.removeConnection(publicOrigin)
  const { dapp_authorization_state: persisted } = await storage.get('dapp_authorization_state')
  assert.deepEqual(persisted[publicOrigin], { revision: 6, mode: 'revoked', publicExplicit: true })
  const reloaded = new DAppManager(storage)
  assert.equal(await reloaded.canAutoConnect(publicOrigin), false)
  assert.equal(await reloaded.isRevoked(revokedOrigin), true)
  assert.deepEqual(await reloaded.getAuthorizedAccounts(unreviewedOrigin), [account])
})

test('a browser favicon data URL does not erase approved connections on reload', async () => {
  const { manager, storage } = managerFixture()
  const favicon = `data:image/png;base64,${'a'.repeat(20_000)}`
  await manager.setAuthorizedAccounts(origin, { favIconUrl: favicon }, [account], account)

  const restored = new DAppManager(storage)
  const [connection] = await restored.getAllConnections()
  assert.equal(connection?.favicon, favicon)
  assert.deepEqual(await restored.getAuthorizedAccounts(origin), [account])

  const { connectedDApps } = await storage.get('connectedDApps')
  await storage.set({
    connectedDApps: [{ ...connectedDApps[0], favicon: `data:image/png;base64,${'a'.repeat(300_000)}` }]
  })
  const oversizedLegacy = new DAppManager(storage)
  assert.equal((await oversizedLegacy.getAllConnections())[0]?.favicon, `${origin}/favicon.ico`)
  assert.deepEqual(await oversizedLegacy.getAuthorizedAccounts(origin), [account])
  await oversizedLegacy.removeConnection(origin)
  const disconnected = new DAppManager(storage)
  assert.deepEqual(await disconnected.getAllConnections(), [])
  assert.equal(await disconnected.isRevoked(origin), true)
})
