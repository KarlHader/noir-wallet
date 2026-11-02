import { test as it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mapWasmAccountBalanceToZcashBalance } from '../../../src/core/wallet/balance-summary.ts'
import {
  canShieldTransparentFunds,
  getShieldableTransparentBalance,
  getShieldInputAmountFromHistory
} from '../../../src/core/zcash/shielding.ts'

const describe = it.describe

const readSource = path => readFileSync(new URL(path, import.meta.url), 'utf-8')

const walletConfigSource = readSource('../../../src/config/wallet.ts')
const shieldingSource = readSource('../../../src/core/zcash/shielding.ts')
const shieldSheetSource = readSource(
  '../../../src/popup/components/transaction/ShieldConfirmSheet.tsx'
)
const shieldBannerSource = readSource(
  '../../../src/popup/components/transaction/ShieldFundsBanner.tsx'
)
const shieldHookSource = readSource('../../../src/popup/hooks/useShieldFunds.tsx')
const assetDetailSource = readSource('../../../src/popup/pages/portfolio/AssetDetail.tsx')
const sendSource = readSource('../../../src/popup/pages/transactions/Send.tsx')
const approvalSource = readSource('../../../src/popup/pages/dapp/ApprovalPage.tsx')
const backgroundSource = readSource('../../../src/background/index.ts')
const dappHandlerSource = readSource('../../../src/background/dapp-handler.ts')
const walletRpcErrorsSource = readSource('../../../src/core/zcash/wallet-rpc-errors.ts')

describe('Shielding minimum balance regressions', () => {
  it('excludes pending transparent funds from the shield amount', () => {
    const balance = mapWasmAccountBalanceToZcashBalance({
      unshielded_balance: 328_475,
      unshielded_pending_balance: 152_925,
      unshielded_total_balance: 481_400
    })

    assert.equal(balance.transparent, '0.004814')
    assert.equal(balance.pending?.transparent, '0.00152925')
    assert.equal(balance.shieldable, '0.00328475')
    assert.equal(getShieldableTransparentBalance(balance), '0.00328475')
  })

  it('does not offer shielding when all transparent funds are pending', () => {
    const balance = mapWasmAccountBalanceToZcashBalance({
      unshielded_balance: 0,
      unshielded_pending_balance: 144_300,
      unshielded_total_balance: 144_300
    })

    assert.equal(balance.transparent, '0.001443')
    assert.equal(balance.shieldable, '0')
    assert.equal(canShieldTransparentFunds(balance), false)
    assert.match(sendSource, /getShieldableTransparentBalance\(balance\)/)
    assert.match(shieldBannerSource, /!hasEnoughTransparentBalanceToShield\(transparentBalance\)/)
  })

  it('uses the inputs selected by the broadcast shield transaction', () => {
    const txidBytes = Array.from({ length: 32 }, (_, index) => index)
    const txid = [...txidBytes]
      .reverse()
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('')

    assert.equal(
      getShieldInputAmountFromHistory(
        [
          {
            txid: txidBytes,
            kind: 'shield',
            amount_zatoshis: 330_000,
            fee_zatoshis: 20_000,
            mined_height: null,
            status: 'pending',
            timestamp: null,
            memo: null
          }
        ],
        txid
      ),
      '0.0035'
    )
  })

  it('uses the same 100,000-zatoshi minimum as the WASM shielding proposal', () => {
    assert.match(walletConfigSource, /SHIELDING_THRESHOLD_ZATOSHIS\s*=\s*100_000/)
    assert.match(
      walletConfigSource,
      /SHIELDING_THRESHOLD:\s*SHIELDING_THRESHOLD_ZATOSHIS\s*\/\s*10\s*\*\*\s*ZEC_DECIMALS/
    )
    assert.match(shieldingSource, /safeBig\(balance\)\.gte\(WALLET_CONFIG\.SHIELDING_THRESHOLD\)/)
  })

  it('blocks the built-in shield action and fee estimate below the minimum', () => {
    assert.match(shieldSheetSource, /enabled:\s*open && hasEnoughBalance/)
    assert.match(shieldSheetSource, /disabled=\{!hasEnoughBalance\}/)
    assert.match(shieldSheetSource, /MIN_SHIELDING_BALANCE_MESSAGE/)

    const validation = shieldHookSource.indexOf(
      '!hasEnoughTransparentBalanceToShield(transparentBalance)'
    )
    const transactionCreation = shieldHookSource.indexOf("type: 'ADD_TRANSACTION'")
    assert.ok(validation !== -1 && validation < transactionCreation)
  })

  it('shows a shield action only when the Zcash transparent balance is positive', () => {
    assert.match(assetDetailSource, /aria-label="Zcash balance breakdown"/)
    assert.match(assetDetailSource, />Shielded</)
    assert.match(assetDetailSource, />Transparent</)
    assert.match(assetDetailSource, /BigInt\(asset\.balance\.shieldableRaw \?\? '0'\) > 0n/)
    assert.match(assetDetailSource, /aria-label="Shield transparent ZEC"/)
    assert.match(assetDetailSource, /useShieldFunds\(\)/)
  })

  it('blocks dApp approval and both background execution paths below the minimum', () => {
    assert.match(approvalSource, /disabled=\{[\s\S]*?!hasEnoughShieldingBalance/)

    const dappShieldHandler = dappHandlerSource.slice(
      dappHandlerSource.indexOf('private async shieldFunds'),
      dappHandlerSource.indexOf('private async getTransactionHistory')
    )
    const dappValidation = dappShieldHandler.indexOf('hasEnoughTransparentBalanceToShield')
    const dappShieldCall = dappShieldHandler.indexOf('walletCore.shieldFunds')
    assert.ok(dappValidation !== -1 && dappShieldCall !== -1 && dappValidation < dappShieldCall)

    const backgroundShieldValidation = backgroundSource.indexOf("if (action === 'shield')")
    const backgroundShieldCall = backgroundSource.indexOf(
      'walletCore.shieldFunds',
      backgroundShieldValidation
    )
    assert.ok(
      backgroundShieldValidation !== -1 &&
        backgroundShieldCall !== -1 &&
        backgroundShieldValidation < backgroundShieldCall
    )
  })

  it('does not overwrite a build failure with a confirmation-status failure', () => {
    const failureHandler = backgroundSource.slice(
      backgroundSource.indexOf(
        '} catch (error: any) {',
        backgroundSource.indexOf('async function handleBackgroundZcashTx')
      ),
      backgroundSource.indexOf(
        '// Chrome notification for failure',
        backgroundSource.indexOf('async function handleBackgroundZcashTx')
      )
    )

    assert.match(failureHandler, /transactionRecorder\.updateTransaction/)
    assert.match(failureHandler, /type:\s*'ZCASH_TX_COMPLETED'/)
    assert.doesNotMatch(failureHandler, /type:\s*'TRANSACTION_STATUS_UPDATED'/)
    assert.match(
      walletRpcErrorsSource,
      /InsufficientFunds[\s\S]*return MIN_SHIELDING_BALANCE_MESSAGE/
    )
  })
})
