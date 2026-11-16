import assert from 'node:assert/strict'
import { it } from 'node:test'
import { collectLedgerEvmAccounts } from '../../../src/lib/ledger/evm-account-export.ts'

const account = {
  address: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
  publicKey:
    '0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' +
    '483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8'
}

it('reads an Ethereum address before checking app version from dashboard or an open app', async () => {
  for (const initialApp of ['BOLOS', 'Ethereum']) {
    let currentApp = initialApp
    const calls = []
    const exported = await collectLedgerEvmAccounts({
      paths: [{ derivationPath: "m/44'/60'/0'/0/0", path: "44'/60'/0'/0/0" }],
      async readAddress(path) {
        calls.push(['address', path, currentApp])
        currentApp = 'Ethereum'
        return account
      },
      async readApp() {
        calls.push(['app', currentApp])
        return { name: currentApp, version: '1.14.0' }
      },
      deviceModel: 'nanoX',
      deviceName: 'Ledger Nano X'
    })
    assert.equal(exported[0].appVersion, '1.14.0')
    assert.equal(exported[0].address, account.address.toLowerCase())
    assert.deepEqual(calls, [
      ['address', "44'/60'/0'/0/0", initialApp],
      ['app', 'Ethereum']
    ])
  }
})

it('rejects an app mismatch after address export', async () => {
  await assert.rejects(
    collectLedgerEvmAccounts({
      paths: [{ derivationPath: "m/44'/60'/0'/0/0", path: "44'/60'/0'/0/0" }],
      readAddress: async () => account,
      readApp: async () => ({ name: 'BOLOS', version: '1.0.0' }),
      deviceModel: 'nanoX',
      deviceName: 'Ledger Nano X'
    }),
    /verify.*Ethereum/
  )
})
