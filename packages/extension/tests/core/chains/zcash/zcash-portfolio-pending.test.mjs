import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildPortfolioReadModel,
  parsePortfolioReadModel
} from '../../../../src/core/portfolio/index.ts'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions,
  getZcashChainId
} from '../../../../src/core/chains/registry/index.ts'
import { readZcashPortfolioSource } from '../../../../src/infrastructure/chains/zcash/zcash-balance-reader.ts'
import { getZcashPrivacyBalanceDisplay } from '../../../../src/popup/pages/portfolio/asset-detail-balance.ts'

const chainId = getZcashChainId('mainnet')
const chains = createInitialProductChainRegistry('mainnet')
const assets = createAssetRegistry(chains, getBundledInitialProductAssetDefinitions('mainnet'))
const scope = { keyDomainId: 'wallet:pending', accountId: 'account:pending' }
const chainAccount = {
  id: 'chain-account:zcash:pending',
  scope: { ...scope, chainId },
  derivation: { scheme: 'zip32-unified', path: "m/32'/133'/0'" },
  identity: { kind: 'account-identifier', value: 'u1example' },
  createdAt: 1000
}

test('ZEC portfolio and cached read model retain each pool pending independently', () => {
  const source = readZcashPortfolioSource({
    chainId,
    chainAccount,
    chains,
    assets,
    status: 'ready',
    updatedAt: 2000,
    balance: {
      shielded: '2',
      transparent: '3.8053',
      total: '5.8053',
      spendable: '1',
      available: '0.9996',
      shieldable: '0',
      pending: { shielded: '1', transparent: '3.8053', total: '4.8053' },
      confirmed: { shielded: '1', transparent: '0' }
    }
  })
  const balance = source.balances[0]
  assert.equal(balance.pendingRaw, '480530000')
  assert.equal(balance.shieldedPendingRaw, '100000000')
  assert.equal(balance.transparentPendingRaw, '380530000')

  const model = buildPortfolioReadModel(scope, [source], chains, assets)
  const cached = parsePortfolioReadModel(JSON.parse(JSON.stringify(model)), chains, assets)
  const zec = cached.assets.find(item => item.asset.id === `${chainId}/slip44:133`)
  assert.equal(zec.balance.shieldedPendingRaw, '100000000')
  assert.equal(zec.balance.transparentPendingRaw, '380530000')
  assert.equal(zec.balance.availableRaw, '99960000')
  assert.deepEqual(getZcashPrivacyBalanceDisplay(zec.balance, 8), {
    shielded: '2',
    transparent: '3.8053',
    shieldedPending: '1',
    transparentPending: '3.8053'
  })
  assert.equal(
    getZcashPrivacyBalanceDisplay(
      { ...zec.balance, shieldedPendingRaw: '0', transparentPendingRaw: '0' },
      8
    ).transparentPending,
    null
  )
})
