import { test as it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { shouldAutoConnectDApp } from '../../../src/core/dapp/first-party-policy.ts'

const describe = it.describe

const handlerSource = readFileSync(
  new URL('../../../src/background/dapp-handler.ts', import.meta.url),
  'utf-8'
)

describe('zkNoir application integration', () => {
  it('auto-connects only the exact first-party application origin', () => {
    assert.equal(shouldAutoConnectDApp('https://app.zknoir.com'), true)
    assert.equal(shouldAutoConnectDApp('http://app.zknoir.com'), false)
    assert.equal(shouldAutoConnectDApp('https://evil.app.zknoir.com'), false)
    assert.equal(shouldAutoConnectDApp('https://app.zknoir.com.evil.example'), false)
    assert.equal(shouldAutoConnectDApp('https://app.zknoir.com/lending'), false)
  })

  it('synchronizes every wallet account without bypassing action approvals', () => {
    assert.match(
      handlerSource,
      /private async authorizeAllWalletAccounts[\s\S]*?this\.buildAllWalletAccounts\(\)/
    )
    assert.match(
      handlerSource,
      /private async getAccounts[\s\S]*?shouldAutoConnectDApp\(origin\)[\s\S]*?authorizeAllWalletAccounts\(origin\)/
    )
    assert.match(
      handlerSource,
      /private async requestAccounts[\s\S]*?shouldAutoConnectDApp\(origin\)[\s\S]*?authorizeAllWalletAccounts\(origin\)/
    )
    assert.match(
      handlerSource,
      /private async ensurePermission[\s\S]*?shouldAutoConnectDApp\(origin\)[\s\S]*?authorizeAllWalletAccounts\(origin\)/
    )
    assert.match(handlerSource, /private async sendTransaction[\s\S]*?requestUserApprovalWithId/)
    assert.match(
      handlerSource,
      /private async signMessage[\s\S]*?requestUserApproval\([\s\S]*?origin,[\s\S]*?'signMessage'/
    )
    assert.match(
      handlerSource,
      /private async shieldFunds[\s\S]*?requestUserApprovalWithId\([\s\S]*?origin,[\s\S]*?'shieldFunds'/
    )
  })
})
