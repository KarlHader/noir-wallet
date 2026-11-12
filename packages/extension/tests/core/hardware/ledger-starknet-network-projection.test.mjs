import assert from 'node:assert/strict'
import { it } from 'node:test'
import { DASH_CHAIN_IDS } from '../../../src/core/chains/registry/chain-ids.ts'
import { STARKNET_CHAIN_IDS } from '../../../src/core/chains/starknet/identifiers.ts'
import { ledgerStarknetProjectionAdditions } from '../../../src/infrastructure/keyring/ledger-starknet-network-projection.ts'
import {
  ledgerAccountCoversRequest,
  ledgerRegisteredFamilies,
  resolveStarknetLedgerSelection
} from '../../../src/popup/pages/hardware/ledger-connect-model.ts'

const PATH = "m/2645'/1195502025'/1148870696'/0'/0'/0"
const ADDRESS = '0x6a62e3abc08f1190cf071afeec31d1693f71c9f126e820b98d7017f133e6a27'

function starknetAccount(network) {
  return {
    family: 'starknet',
    accountIndex: 0,
    derivationPath: PATH,
    network,
    publicKey: '0x2',
    address: ADDRESS,
    classHash: '0x036078334509b514626504edc9fb252328d1a240e4e948bef8d0c08dff45927f',
    accountType: 'argent',
    appVersion: '2.4.3'
  }
}

function chainAccount(id, chainId, keyDomainId = 'wallet:ledger') {
  return {
    id,
    scope: { keyDomainId, accountId: 'account:ledger:0', chainId },
    derivation: { scheme: chainId.startsWith('starknet:') ? 'eip2645' : 'bip44', path: PATH },
    identity: { kind: 'account-identifier', value: ADDRESS },
    createdAt: 1
  }
}

function address(id, chainAccountId) {
  return {
    id,
    chainAccountId,
    value: ADDRESS,
    scheme: 'starknet',
    purpose: 'receive',
    derivation: { scheme: 'eip2645', path: PATH },
    rotatable: false,
    preferredForReceive: true,
    privacy: 'transparent',
    walletCompatibility: 'broad'
  }
}

function snapshot(chainAccounts, keyDomains) {
  return {
    keyDomains,
    chainAccounts,
    addresses: chainAccounts.map(item => address(`address:${item.id}`, item.id))
  }
}

const ledgerDomain = {
  id: 'wallet:ledger',
  source: { kind: 'hardware', vendor: 'ledger', capabilities: ['starknet', 'dash'] }
}

it('projects a mainnet Starknet Ledger address onto Sepolia and leaves Dash alone', () => {
  const source = snapshot(
    [
      chainAccount('chain:starknet:main', STARKNET_CHAIN_IDS.mainnet),
      chainAccount('chain:dash:main', DASH_CHAIN_IDS.mainnet)
    ],
    [ledgerDomain, { id: 'wallet:software', source: { kind: 'software' } }]
  )
  source.chainAccounts.push(
    chainAccount('chain:software:main', STARKNET_CHAIN_IDS.mainnet, 'wallet:software')
  )
  const projected = ledgerStarknetProjectionAdditions(source, 'testnet')
  assert.equal(projected.chainAccounts.length, 1)
  assert.equal(projected.chainAccounts[0].scope.chainId, STARKNET_CHAIN_IDS.testnet)
  assert.equal(projected.chainAccounts[0].identity.value, ADDRESS)
  assert.equal(projected.chainAccounts[0].derivation.path, PATH)
  assert.equal(projected.addresses[0].value, ADDRESS)
  assert.equal(projected.addresses[0].chainAccountId, projected.chainAccounts[0].id)
  assert.equal(
    projected.chainAccounts.some(item => item.scope.chainId === DASH_CHAIN_IDS.testnet),
    false
  )
  const again = ledgerStarknetProjectionAdditions(
    {
      ...source,
      chainAccounts: [...source.chainAccounts, ...projected.chainAccounts],
      addresses: [...source.addresses, ...projected.addresses]
    },
    'testnet'
  )
  assert.equal(again.chainAccounts.length, 0)
})

it('treats one Starknet Ledger account as registered on both modes without a second record', () => {
  const credential = {
    schemaVersion: 3,
    accountExport: { accounts: [starknetAccount('mainnet')] }
  }
  assert.deepEqual(ledgerRegisteredFamilies(credential, 0, 'testnet'), ['starknet'])
  assert.equal(
    ledgerAccountCoversRequest(starknetAccount('mainnet'), 'starknet', 0, 'testnet'),
    true
  )
  assert.equal(
    ledgerAccountCoversRequest(
      { family: 'dash', accountIndex: 0, network: 'mainnet' },
      'dash',
      0,
      'testnet'
    ),
    false
  )
  const selected = resolveStarknetLedgerSelection([starknetAccount('testnet')], 'mainnet', PATH)
  assert.equal(selected.network, 'mainnet')
  assert.equal(selected.address, ADDRESS)
  assert.equal(selected.publicKey, '0x2')
  assert.throws(
    () => resolveStarknetLedgerSelection([starknetAccount('testnet')], 'mainnet', `${PATH}9`),
    /account list/
  )
})
