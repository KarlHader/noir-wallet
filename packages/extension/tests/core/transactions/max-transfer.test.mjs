import { test as it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveZcashSwapMaximumAdjustment } from '../../../src/popup/services/swap-maximum.ts'

const describe = it.describe
const readSource = relativePath =>
  readFileSync(new URL(`../../../${relativePath}`, import.meta.url), 'utf-8')

describe('dynamic maximum transfer regressions', () => {
  it('does not run an ordinary fee proposal for an exact Max transfer', () => {
    const send = readSource('src/popup/pages/transactions/Send.tsx')
    const swap = readSource('src/popup/pages/swap/Swap.tsx')

    for (const source of [send, swap]) {
      assert.match(source, /const isMaxTransferAmount\s*=/)
      assert.match(source, /!maxSelected[\s\S]*?!isMaxTransferAmount/)
      assert.match(source, /const displayedFeeByTier = isMaxFeeMode \? maxFeeByTier : feeByTier/)
      assert.match(
        source,
        /maxTransfer\.fee && isMaxTransferAmount \? maxTransfer\.fee : estimatedFeeZec/
      )
    }
  })

  it('re-quotes cross-chain Max transfers after the exact destination is known', () => {
    assert.deepEqual(
      resolveZcashSwapMaximumAdjustment({
        currentAmount: '0.9',
        exactMaximum: '0.88',
        adjustmentCount: 0
      }),
      { amount: '0.88', adjustmentCount: 1 }
    )
    assert.equal(
      resolveZcashSwapMaximumAdjustment({
        currentAmount: '0.88',
        exactMaximum: '0.88',
        adjustmentCount: 1
      }),
      null
    )
    assert.equal(
      resolveZcashSwapMaximumAdjustment({
        currentAmount: '0.9',
        exactMaximum: null,
        adjustmentCount: 0
      }),
      null
    )
    assert.throws(
      () =>
        resolveZcashSwapMaximumAdjustment({
          currentAmount: '0.9',
          exactMaximum: '0.88',
          adjustmentCount: 2
        }),
      /maximum spendable/
    )
  })

  it('does not attach shielded memos to transparent protocol deposit transfers', () => {
    const swap = readSource('src/popup/pages/swap/Swap.tsx')

    assert.doesNotMatch(swap, /memo:\s*`Swap /)
  })

  it('clears a pending wallet Max and quote when the active Account or chain scope changes', () => {
    const swap = readSource('src/popup/pages/swap/Swap.tsx')
    const multichainSend = readSource('src/popup/pages/transactions/MultichainSend.tsx')
    const background = readSource('src/background/index.ts')
    const popupContextSync = readSource('src/popup/hooks/usePersistedExtensionContextSync.ts')
    const resultPage = readSource('src/popup/pages/transactions/TransactionResultPage.tsx')

    assert.match(swap, /const activeScopeRef = useRef<string \| null \| undefined>\(undefined\)/)
    assert.match(swap, /getChainEndpointRuntimeKey\(state\.chainEndpointSettings\)/)
    assert.match(swap, /previousScope === undefined \|\| previousScope === activeScope/)
    assert.match(
      swap,
      /quoteRequestSequence\.current \+= 1[\s\S]*?void discardPreparedQuoteTransfer\(\)[\s\S]*?setViewStep\('input'\)[\s\S]*?setQuoteResult\(null\)[\s\S]*?setMaxSelected\(false\)[\s\S]*?swap\.resetSwap\(\)/
    )
    assert.match(swap, /requestSequence !== quoteRequestSequence\.current/)
    assert.match(popupContextSync, /if \(walletChanged\) await rehydrateWalletStore\(\)/)
    assert.match(popupContextSync, /useSettingsStore\.persist\.rehydrate\(\)/)
    assert.doesNotMatch(popupContextSync, /ZcashWalletRuntime|synchronizeActiveWalletFromStore/)
    assert.match(popupContextSync, /useTransactionResultStore\.getState\(\)\.clear\(\)/)
    assert.match(
      resultPage,
      /if \(!data && !leavingResultRef\.current\)[\s\S]*?navigate\('\/', \{ replace: true \}\)[\s\S]*?\[data, navigate\]/
    )
    assert.match(
      multichainSend,
      /\[effectiveWalletId, effectiveAccountId, chainEndpointRuntimeKey, load\]/
    )
    assert.match(
      background,
      /accountContextTransition[\s\S]*?\.runActiveOperation\(\(\) => handleBackgroundZcashTx\(message\)\)/
    )
    assert.match(
      background,
      /assertActiveBackgroundAccountScope\(walletId, accountId, accountKey\)/
    )
  })

  it('exposes the parameterized estimate to authorized dApps and the SDK', () => {
    const runtimeMessageSecurity = readSource('src/lib/runtime-message-security.ts')
    const handler = readSource('src/background/dapp-handler.ts')
    const sdkApi = readSource('../sdk/src/chains/zcash/api.ts')
    const sdkTypes = readSource('../sdk/src/chains/zcash/types.ts')
    const sdkExample = readSource('../sdk/example/src/App.tsx')

    assert.match(runtimeMessageSecurity, /'zcash_getMaxTransfer'/)
    assert.match(handler, /case 'zcash_getMaxTransfer'/)
    assert.match(handler, /Current account is not authorized/)
    assert.match(sdkApi, /async getMaxTransfer\(params: MaxTransferParams\)/)
    assert.match(sdkTypes, /feeTier\?: FeeTier/)
    assert.doesNotMatch(sdkTypes, /interface MaxTransferParams\s*\{[^}]*accountId\?: string/)
    assert.match(sdkExample, /zcash\.getMaxTransfer\(\{[\s\S]*?to: sendForm\.to/)
  })

  it('routes optional dApp funding sources through the existing RPCs', () => {
    const contentScript = readSource('src/content-script/index.ts')
    const handler = readSource('src/background/dapp-handler.ts')
    const worker = readSource('src/core/worker/zcash.worker.ts')
    const approval = readSource('src/popup/pages/dapp/ApprovalPage.tsx')
    const sdkApi = readSource('../sdk/src/chains/zcash/api.ts')
    const sdkTypes = readSource('../sdk/src/chains/zcash/types.ts')

    assert.doesNotMatch(contentScript, /zcash_getMaxTransferV2/)
    assert.doesNotMatch(contentScript, /zcash_sendTransactionV2/)
    assert.doesNotMatch(handler, /zcash_getMaxTransferV2/)
    assert.doesNotMatch(handler, /zcash_sendTransactionV2/)
    assert.match(handler, /if \(value === undefined\) return 'shielded'/)
    assert.match(handler, /"fundingSource" must be "shielded" or "transparent"/)
    assert.match(handler, /fromType: fundingSource/)
    assert.match(handler, /\(\?:tex\|textest\)1/)
    assert.match(handler, /isTransparentZcashAddress\(p\.to\)/)
    assert.match(worker, /w\.estimate_pczt_max_transparent_transfer\(/)
    assert.match(worker, /w\.estimate_transfer\(/)
    assert.match(worker, /w\.oneclick_transfer\(/)
    assert.doesNotMatch(worker, /w\.estimate_pczt_transparent_transfer_fee\(/)
    assert.doesNotMatch(worker, /w\.oneclick_pczt_transparent_transfer_dynamic_fee\(/)
    assert.match(approval, /Spending transparent funds reveals and may link/)
    assert.match(approval, /feeZats: feeByTier\[feeTier\]/)
    assert.match(handler, /feeZats: extras\?\.feeZats/)
    assert.match(sdkTypes, /export type FundingSource = 'shielded' \| 'transparent'/)
    assert.match(sdkTypes, /fundingSource\?: FundingSource/)
    assert.match(sdkApi, /method: 'zcash_getMaxTransfer'/)
    assert.match(sdkApi, /method: 'zcash_sendTransaction'/)
    assert.doesNotMatch(sdkApi, /zcash_getMaxTransferV2/)
    assert.doesNotMatch(sdkApi, /zcash_sendTransactionV2/)
  })

  it('repairs incomplete spendability metadata once instead of returning a false Max', () => {
    const backgroundZcashWalletRuntime = readSource('src/background/zcash-wallet-runtime.ts')
    const handler = readSource('src/background/dapp-handler.ts')

    assert.match(backgroundZcashWalletRuntime, /WALLET_SPENDABILITY_INCONSISTENT/)
    assert.match(backgroundZcashWalletRuntime, /spendabilityRecoveryAttemptedWalletIds/)
    assert.match(
      backgroundZcashWalletRuntime,
      /core\.estimateTransferFee[\s\S]*?recoverSpendabilityMetadata/
    )
    assert.match(handler, /backgroundZcashWalletRuntime\.estimateMaxTransferFor\(/)
  })

  it('serializes signing with wallet reset operations', () => {
    const worker = readSource('src/core/worker/zcash.worker.ts')
    const signCase = worker.slice(
      worker.indexOf("case 'message.sign':"),
      worker.indexOf("case 'wallet.getPublicKey':")
    )

    assert.match(signCase, /runForWallet\(walletId, async \(\) =>/)
    assert.match(worker, /const tail = previous\.then\(\(\) => current\)/)
    assert.match(worker, /walletOperationChains\.get\(walletId\) === tail/)
  })
})
