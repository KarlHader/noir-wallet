import {
  ASSET_PRICE_SOURCE_ASSETS,
  CUSTOM_TOKEN_CONTRACT,
  EVM_HISTORY_PROXY_ORIGINS,
  GNOSIS_USDC_CONTRACT,
  NEAR_NETWORKS,
  SOLANA_NETWORKS,
  captureScreenshot,
  expect,
  importTestWallet,
  mockEvmHistoryProxy,
  mockExternalAssetIcons,
  mockReleasedBitcoinEsplora,
  mockReleasedEvmRpc,
  nearEnabled,
  seedFreshAssetPrices,
  solanaEnabled,
  test,
  waitForBackgroundWalletInitialization
} from '../../helpers/release-default'

test('loads Home totals when Token activity opens before the Assets tab', async ({
  context,
  popup
}) => {
  test.setTimeout(180_000)
  await mockExternalAssetIcons(context)
  await context.route('**/get_multichain_lending_tokens_data**', route => route.abort())
  await context.route('https://1click.chaindefuser.com/v0/tokens', route => route.abort())
  await mockReleasedEvmRpc(context)
  await mockReleasedBitcoinEsplora(context)
  await mockEvmHistoryProxy(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await seedFreshAssetPrices(popup)
  const total = popup.getByTestId('home-total-assets')
  await expect(total).toContainText('$', { timeout: 60_000 })
  const initialTotal = await total.innerText()
  await captureScreenshot(popup, 'home-assets-total-before-activity.png')
  await popup.getByRole('button', { name: 'Show chain view' }).click()
  await popup.getByRole('button', { name: 'Expand Ethereum tokens', exact: true }).click()
  await popup.getByRole('button', { name: 'View ETH details on Ethereum', exact: true }).click()
  const viewAll = popup.getByRole('button', { name: 'View all', exact: true })
  await expect(viewAll).toBeVisible()
  await viewAll.scrollIntoViewIfNeeded()
  await captureScreenshot(popup, 'home-token-detail-view-all.png')
  await viewAll.click()
  await expect(popup.getByRole('tab', { name: 'Activity', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toHaveCount(0)
  await expect(popup.getByRole('status', { name: 'Loading activity', exact: true })).toHaveCount(
    0,
    {
      timeout: 30_000
    }
  )
  await expect(total).toHaveText(initialTotal, { timeout: 30_000 })
  await expect(popup.getByRole('status', { name: 'Loading total assets' })).toHaveCount(0)
  await captureScreenshot(popup, 'home-token-activity-total.png')

  await popup.getByRole('tab', { name: 'Lending', exact: true }).click()
  await expect(total).toHaveText(initialTotal)
  await captureScreenshot(popup, 'home-lending-total-after-activity.png')
  await popup.getByRole('tab', { name: 'Assets', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible()
  await expect(total).toHaveText(initialTotal)
})

test('adds and removes an exact custom Token without symbol or icon spoofing', async ({
  context,
  popup
}) => {
  test.setTimeout(180_000)
  const priceUpdatedAt = new Date().toISOString()
  await context.route('https://1click.chaindefuser.com/v0/tokens', route =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([
        {
          assetId: 'nep141:zec.omft.near',
          blockchain: 'zec',
          contractAddress: null,
          decimals: 8,
          price: 40,
          priceUpdatedAt,
          symbol: 'ZEC'
        },
        {
          assetId: ASSET_PRICE_SOURCE_ASSETS.usdc,
          blockchain: 'eth',
          contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          decimals: 6,
          price: 1,
          priceUpdatedAt,
          symbol: 'USDC'
        }
      ])
    })
  )
  await context.route('**/get_multichain_lending_tokens_data**', route =>
    route.fulfill({ contentType: 'application/json', body: '[]' })
  )
  await mockReleasedEvmRpc(context)
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)

  await popup.getByRole('button', { name: 'Manage Tokens' }).click()
  await expect(popup.getByRole('heading', { name: 'Manage Tokens' })).toBeVisible()
  await expect(popup.getByLabel('Search Tokens')).toBeVisible()
  await expect(
    popup.getByRole('button', { name: 'Manage Tokens network: All Networks' })
  ).toBeVisible()
  await popup.getByRole('button', { name: 'Add Token' }).click()
  const addDialog = popup.getByRole('dialog')
  await captureScreenshot(popup, 'release-default-add-token-sheet.png')
  await addDialog.getByRole('button', { name: 'Token network' }).click()
  await captureScreenshot(popup, 'release-default-add-token-network-menu.png')
  await popup.getByRole('menuitemradio', { name: 'Ethereum' }).click()
  await addDialog.getByLabel('EVM contract address').fill(CUSTOM_TOKEN_CONTRACT)
  await addDialog.getByRole('button', { name: 'Verify Token' }).click()
  await expect(addDialog.getByText('Example Token', { exact: true })).toBeVisible()
  await expect(addDialog.getByText('USDC · 18 decimals', { exact: true })).toBeVisible()
  await addDialog.getByRole('button', { name: 'Add Token' }).click()

  await expect(addDialog).toBeHidden()
  await expect(popup.getByRole('button', { name: 'Remove USDC' })).toBeVisible()
  await expect(popup.getByText('Ethereum · 0x3333...333333', { exact: true })).toBeVisible()
  await popup.getByLabel('Search Tokens').fill('0x333333')
  await expect(popup.getByText('No matching Tokens', { exact: true })).toBeVisible()
  await popup.getByLabel('Search Tokens').fill(CUSTOM_TOKEN_CONTRACT)
  await expect(popup.getByRole('button', { name: 'Remove USDC' })).toBeVisible()
  await popup.getByLabel('Search Tokens').fill('')
  await captureScreenshot(popup, 'release-default-manage-custom-token.png')
  await expect(
    popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_USER_EVM_ASSETS' }))
  ).resolves.toMatchObject({
    result: [
      {
        assetId: `eip155:1/erc20:${CUSTOM_TOKEN_CONTRACT}`,
        metadata: { symbol: 'USDC', decimals: 18 }
      }
    ]
  })
  const customTokenRow = popup.locator('div.rounded-xl').filter({ hasText: '0x3333...333333' })
  await expect(
    customTokenRow.locator('[data-slot="token-icon"]').getByRole('img', { name: 'Ethereum' })
  ).toBeVisible()
  await customTokenRow.getByRole('switch', { name: 'Disable USDC on Ethereum' }).click()
  await expect
    .poll(() =>
      popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_MANAGED_TOKEN_ASSETS' }))
    )
    .toMatchObject({ result: { hiddenAssetIds: [`eip155:1/erc20:${CUSTOM_TOKEN_CONTRACT}`] } })
  await customTokenRow.getByRole('switch', { name: 'Enable USDC on Ethereum' }).click()
  await expect
    .poll(() =>
      popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_MANAGED_TOKEN_ASSETS' }))
    )
    .toMatchObject({ result: { hiddenAssetIds: [] } })

  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 30_000 })
  await expect(popup.getByRole('status', { name: 'Loading portfolio' })).toHaveCount(0, {
    timeout: 30_000
  })
  await expect(popup.getByRole('button', { name: /Portfolio network filter/ })).toHaveCount(0)
  await popup.getByRole('button', { name: 'Expand low value assets' }).click()
  const customAsset = popup.locator('article').filter({ hasText: 'Custom' })
  await expect(customAsset).toHaveCount(1)
  await expect(customAsset.getByText('Custom', { exact: true })).toBeVisible()
  await expect(customAsset.locator('img[alt="USDC"]')).toHaveCount(0)
  await captureScreenshot(popup, 'release-default-portfolio-custom-token-isolation.png')

  await popup.getByRole('button', { name: 'Send', exact: true }).click()
  const customSendAsset = popup.getByRole('button', {
    name: 'Send USDC custom Token on Ethereum'
  })
  await expect(customSendAsset).toBeVisible()
  await expect(customSendAsset.getByText('Custom', { exact: true })).toBeVisible()
  await expect(customSendAsset.getByText(/0x3333.*3333/)).toBeVisible()
  await customSendAsset.click()
  await popup.getByLabel('Send To').fill('0x1111111111111111111111111111111111111111')
  await popup.getByLabel('USDC amount').fill('0.5')
  await popup.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Review Send' })).toBeVisible({
    timeout: 30_000
  })
  const sendReview = popup.getByRole('dialog', { name: 'Review Send' })
  await expect(sendReview).toContainText(
    'This transfer calls a custom Token contract you added. Verify the network, Token, and recipient.'
  )
  await captureScreenshot(popup, 'release-default-custom-token-send-review.png')
  await sendReview.getByRole('button', { name: 'Send anyway', exact: true }).click()
  await expect(popup.getByText('Transaction Confirmed', { exact: true })).toBeVisible({
    timeout: 30_000
  })
  await captureScreenshot(popup, 'release-default-custom-token-transaction-final.png')
  await popup.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 30_000 })
  await popup.getByRole('button', { name: 'Not now' }).click()

  await popup.getByRole('button', { name: 'Manage Tokens' }).click()
  await popup.getByRole('button', { name: 'Remove USDC' }).click()
  const removeDialog = popup.getByRole('dialog')
  await removeDialog.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(popup.getByRole('button', { name: 'Remove USDC' })).toHaveCount(0)
  await expect
    .poll(() => popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_USER_EVM_ASSETS' })))
    .toEqual({ result: [] })
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible({ timeout: 30_000 })
  await popup.getByRole('tab', { name: 'Activity' }).click()
  const customActivity = popup.getByRole('button', { name: 'View Sent USDC details' })
  await expect(customActivity).toBeVisible({ timeout: 30_000 })
  await customActivity.click()
  const customActivityDetail = popup.locator('[data-activity-detail-id]')
  await expect(customActivityDetail.getByText('−0.5 USDC', { exact: true })).toBeVisible()
  await expect(customActivityDetail.locator('img[alt="USDC"]')).toHaveCount(0)
  await captureScreenshot(popup, 'release-default-custom-token-activity-after-removal.png')
})

test('automatically manages Intents Tokens on newly released chains', async ({
  context,
  popup
}) => {
  test.skip(!solanaEnabled || !nearEnabled, 'Requires explicit Solana and NEAR verification flags')
  test.setTimeout(180_000)
  const unexpectedHistoryProxyRequests: string[] = []
  context.on('request', request => {
    const url = new URL(request.url())
    if (
      EVM_HISTORY_PROXY_ORIGINS.has(url.origin) &&
      /^\/(?:bitcoin|solana|near|evm)(?:\/|$)/.test(url.pathname)
    ) {
      unexpectedHistoryProxyRequests.push(request.url())
    }
  })
  const priceUpdatedAt = new Date().toISOString()
  const solanaUsdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  const solanaJupMint = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'
  const rnearContract = 'lst.rhealab.near'
  const rnearAssetId = `${NEAR_NETWORKS.mainnet.chainId}/nep141:${rnearContract}`
  const protocolTokens = [
    {
      assetId: `nep141:gnosis-${GNOSIS_USDC_CONTRACT}.omft.near`,
      blockchain: 'gnosis',
      contractAddress: GNOSIS_USDC_CONTRACT,
      decimals: 6,
      icon: '',
      price: 1,
      priceUpdatedAt,
      symbol: 'USDC',
      coingeckoId: 'usd-coin'
    },
    {
      assetId: 'nep141:sol-usdc.omft.near',
      blockchain: 'sol',
      contractAddress: solanaUsdcMint,
      decimals: 6,
      icon: '',
      price: 1,
      priceUpdatedAt,
      symbol: 'USDC',
      coingeckoId: 'usd-coin'
    },
    {
      assetId: 'nep141:sol-jup.omft.near',
      blockchain: 'sol',
      contractAddress: solanaJupMint,
      decimals: 6,
      icon: '',
      price: 1,
      priceUpdatedAt,
      symbol: 'JUP',
      coingeckoId: 'jupiter-exchange-solana'
    },
    {
      assetId: 'nep141:usdt.tether-token.near',
      blockchain: 'near',
      contractAddress: 'usdt.tether-token.near',
      decimals: 6,
      icon: '',
      price: 1,
      priceUpdatedAt,
      symbol: 'USDT',
      coingeckoId: 'tether'
    },
    {
      assetId: 'nep141:jambo-1679.meme-cooking.near',
      blockchain: 'near',
      contractAddress: 'jambo-1679.meme-cooking.near',
      decimals: 18,
      icon: '',
      price: 0.00022792420856958625,
      priceUpdatedAt,
      symbol: 'JAMBO'
    }
  ]
  const priceTokens = [
    ...protocolTokens.map(({ icon: _icon, ...token }) => token),
    {
      assetId: 'nep141:wrap.near',
      blockchain: 'near',
      contractAddress: null,
      decimals: 24,
      price: 4,
      priceUpdatedAt,
      symbol: 'NEAR'
    },
    {
      assetId: 'nep141:zec.omft.near',
      blockchain: 'zec',
      contractAddress: null,
      decimals: 8,
      price: 40,
      priceUpdatedAt,
      symbol: 'ZEC'
    },
    {
      assetId: ASSET_PRICE_SOURCE_ASSETS.usdc,
      blockchain: 'eth',
      contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      decimals: 6,
      price: 1,
      priceUpdatedAt,
      symbol: 'USDC'
    }
  ]
  await mockExternalAssetIcons(context)
  await mockReleasedEvmRpc(context)
  await mockReleasedBitcoinEsplora(context)
  const solanaRpcUrl = new URL(SOLANA_NETWORKS.mainnet.rpcUrl).href
  const solanaHistorySignature = '1'.repeat(64)
  const solanaHistoryTokenAccount = '11111111111111111111111111111112'
  let solanaOwner = ''
  let requestedSolanaMints: string[] = []
  const directSolanaHistoryMethods: string[] = []
  let directNearHistoryRequests = 0
  await context.route(
    url => url.href === solanaRpcUrl,
    async route => {
      const request = route.request().postDataJSON() as {
        id?: unknown
        method?: unknown
        params?: [unknown, { encoding?: string; programId?: string }?]
      }
      if (request.method === 'getTokenAccountsByOwner') {
        solanaOwner = String(request.params?.[0] ?? '')
        const legacyTokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              context: { slot: 123 },
              value:
                request.params?.[1]?.programId === legacyTokenProgram
                  ? [
                      {
                        pubkey: solanaHistoryTokenAccount,
                        account: {
                          data: {
                            program: 'spl-token',
                            parsed: {
                              type: 'account',
                              info: {
                                isNative: false,
                                mint: solanaUsdcMint,
                                owner: solanaOwner,
                                state: 'initialized',
                                tokenAmount: {
                                  amount: '0',
                                  decimals: 6,
                                  uiAmount: 0,
                                  uiAmountString: '0'
                                }
                              }
                            },
                            space: 165
                          },
                          executable: false,
                          lamports: 2_039_280,
                          owner: legacyTokenProgram,
                          rentEpoch: 0,
                          space: 165
                        }
                      }
                    ]
                  : []
            }
          })
        })
        return
      }
      if (request.method === 'getBalance') {
        solanaOwner = String(request.params?.[0] ?? '')
        await route.fallback()
        return
      }
      if (request.method === 'getSignaturesForAddress') {
        directSolanaHistoryMethods.push(request.method)
        const address = String(request.params?.[0] ?? '')
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result:
              address === solanaHistoryTokenAccount
                ? [
                    {
                      signature: solanaHistorySignature,
                      slot: 124,
                      blockTime: 1_700_000_001,
                      err: null,
                      memo: null,
                      confirmationStatus: 'finalized'
                    }
                  ]
                : []
          })
        })
        return
      }
      if (request.method === 'getTransaction') {
        directSolanaHistoryMethods.push(request.method)
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              slot: 124,
              blockTime: 1_700_000_001,
              version: 0,
              transaction: {
                signatures: [solanaHistorySignature],
                message: {
                  accountKeys: [
                    { pubkey: solanaOwner, signer: true, source: 'transaction', writable: true },
                    {
                      pubkey: solanaHistoryTokenAccount,
                      signer: false,
                      source: 'transaction',
                      writable: true
                    }
                  ],
                  instructions: [],
                  recentBlockhash: '11111111111111111111111111111111'
                }
              },
              meta: {
                err: null,
                fee: 5000,
                preBalances: [1_000_000, 0],
                postBalances: [995_000, 0],
                preTokenBalances: [],
                postTokenBalances: [
                  {
                    accountIndex: 1,
                    mint: solanaUsdcMint,
                    owner: solanaOwner,
                    programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                    uiTokenAmount: {
                      amount: '2500000',
                      decimals: 6,
                      uiAmount: 2.5,
                      uiAmountString: '2.5'
                    }
                  }
                ]
              }
            }
          })
        })
        return
      }
      if (request.method !== 'getMultipleAccounts') {
        await route.fallback()
        return
      }
      const addresses = Array.isArray(request.params?.[0])
        ? request.params[0].map(value => String(value))
        : []
      const mintLookup = request.params?.[1]?.encoding === 'base64'
      if (mintLookup) requestedSolanaMints = addresses
      const programId = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
      const tokenAccount = (mint: string, amount: string) => ({
        data: {
          program: 'spl-token',
          parsed: {
            info: {
              isNative: false,
              mint,
              owner: solanaOwner,
              state: 'initialized',
              tokenAmount: {
                amount,
                decimals: 6,
                uiAmount: Number(amount) / 1_000_000,
                uiAmountString: (Number(amount) / 1_000_000).toString()
              }
            },
            type: 'account'
          },
          space: 165
        },
        executable: false,
        lamports: 2_039_280,
        owner: programId,
        rentEpoch: 0,
        space: 165
      })
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            context: { slot: 123 },
            value: mintLookup
              ? addresses.map(mint => ({
                  data: ['', 'base64'],
                  executable: false,
                  lamports: 1,
                  owner: programId,
                  rentEpoch: 0,
                  space: 82
                }))
              : requestedSolanaMints.map(mint =>
                  tokenAccount(
                    mint,
                    mint === solanaUsdcMint ? '2500000' : mint === solanaJupMint ? '3000000' : '0'
                  )
                )
          }
        })
      })
    }
  )
  await context.route('https://api.fastnear.com/v1/account/**/ft', async route => {
    const accountId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2)!)
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        account_id: accountId,
        tokens: [
          {
            contract_id: 'usdt.tether-token.near',
            balance: '4500000',
            last_update_block_height: 123
          },
          {
            contract_id: rnearContract,
            balance: '200000000000000000000000',
            last_update_block_height: 124
          }
        ]
      })
    })
  })
  await context.route('https://transfers.main.fastnear.com/v0/transfers', async route => {
    directNearHistoryRequests += 1
    const request = route.request().postDataJSON() as { direction?: string }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        resume_token: null,
        transfers:
          request.direction === 'receiver'
            ? [
                {
                  amount: '200000000000000000000000',
                  asset_id: `nep141:${rnearContract}`,
                  block_height: '214090596',
                  block_timestamp: '1788429096000000000',
                  other_account_id: 'duducat.near',
                  receipt_id: 'rnear-receipt',
                  transaction_id: 'rnear-transaction',
                  transfer_index: 0
                }
              ]
            : []
      })
    })
  })
  await context.route('https://1click.chaindefuser.com/v0/tokens', route =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(priceTokens) })
  )
  const rheaTokenListChainIds: Readonly<Record<string, number>> = {
    eth: 1,
    gnosis: 100,
    sol: 501,
    near: 900001,
    zec: 900010
  }
  const rheaTokenRows = priceTokens.map(token => ({
    ...token,
    address: token.assetId,
    chainId: rheaTokenListChainIds[token.blockchain],
    isNative: token.contractAddress === null
  }))
  await context.route('https://api.rhea.finance/get_chain_prices**', route => {
    const chainId = Number(new URL(route.request().url()).searchParams.get('chain'))
    const rows = rheaTokenRows.filter(token => token.chainId === chainId)
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        code: 0,
        msg: 'success',
        data: Object.fromEntries(rows.map((token, index) => [`${token.assetId}:${index}`, token]))
      })
    })
  })
  await context.route('https://api.rhea.finance/api/swap/supported_to_tokens**', route => {
    const chainId = Number(new URL(route.request().url()).searchParams.get('chain'))
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        code: 0,
        msg: 'success',
        data: { tokens: rheaTokenRows.filter(token => token.chainId === chainId) }
      })
    })
  })
  const coinGeckoHistoryRequests: string[] = []
  await context.route(
    url =>
      url.origin === 'https://api.coingecko.com' &&
      url.pathname.startsWith('/api/v3/coins/') &&
      url.pathname.endsWith('/market_chart'),
    route => {
      coinGeckoHistoryRequests.push(route.request().url())
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          prices: [
            [Date.now() - 7_200_000, 0.99],
            [Date.now() - 3_600_000, 1],
            [Date.now(), 1.01]
          ],
          market_caps: [],
          total_volumes: []
        })
      })
    }
  )
  const marketById = {
    'coingecko:usd-coin': { price: 1, percent24h: 0.01 },
    'coingecko:jupiter-exchange-solana': { price: 1, percent24h: -2.5 },
    'coingecko:tether': { price: 1, percent24h: 0.02 }
  }
  await context.route(
    url =>
      url.origin === 'https://coins.llama.fi' &&
      (url.pathname.startsWith('/percentage/') || url.pathname.startsWith('/prices/current/')),
    route => {
      const url = new URL(route.request().url())
      const requestedIds = new Set(decodeURIComponent(url.pathname).split('/').at(-1)?.split(','))
      const percentage = url.pathname.startsWith('/percentage/')
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          coins: Object.fromEntries(
            Object.entries(marketById)
              .filter(([marketId]) => requestedIds.has(marketId))
              .map(([marketId, value]) => [
                marketId,
                percentage
                  ? value.percent24h
                  : { price: value.price, timestamp: Math.floor(Date.now() / 1_000) }
              ])
          )
        })
      })
    }
  )
  let releaseProtocolCatalog = () => {}
  const protocolCatalogGate = new Promise<void>(resolve => {
    releaseProtocolCatalog = resolve
  })
  let protocolCatalogRequests = 0
  await context.route('**/get_multichain_lending_tokens_data**', async route => {
    protocolCatalogRequests += 1
    await protocolCatalogGate
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(protocolTokens) })
  })

  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  const initialPortfolioRefresh = popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_PORTFOLIO', action: 'refresh' })
  )
  await expect.poll(() => protocolCatalogRequests).toBeGreaterThan(0)
  releaseProtocolCatalog()
  const initialPortfolioResponse = await initialPortfolioRefresh
  expect(initialPortfolioResponse).toHaveProperty('result.model')
  expect(
    (
      initialPortfolioResponse as {
        result: {
          model: {
            chains: Array<{
              chain: { id: string }
              assets: Array<{ asset: { id: string }; balance: { totalRaw: string } }>
            }>
          }
        }
      }
    ).result.model.chains
      .find(chain => chain.chain.id === SOLANA_NETWORKS.mainnet.chainId)
      ?.assets.find(
        asset => asset.asset.id === `${SOLANA_NETWORKS.mainnet.chainId}/token:${solanaUsdcMint}`
      )?.balance.totalRaw
  ).toBe('2500000')
  await popup.getByRole('button', { name: 'Manage Tokens' }).click()
  await expect(popup.getByRole('heading', { name: 'Manage Tokens' })).toBeVisible()
  await expect(popup.getByRole('switch', { name: 'Disable USDC on Solana' })).toBeVisible({
    timeout: 30_000
  })
  await expect(popup.getByRole('switch', { name: 'Disable USDT on NEAR' })).toBeVisible()
  await popup.getByRole('button', { name: 'Manage Tokens network: All Networks' }).click()
  await popup.getByRole('menuitemradio', { name: 'Solana', exact: true }).click()
  await expect(popup.getByRole('switch', { name: 'Disable USDC on Solana' })).toBeVisible()
  await expect(popup.getByRole('switch', { name: 'Disable USDT on NEAR' })).toHaveCount(0)
  await popup.getByRole('button', { name: 'Manage Tokens network: Solana' }).click()
  await popup.getByRole('menuitemradio', { name: 'All Networks', exact: true }).click()
  await expect(popup.getByRole('switch', { name: 'Disable USDT on NEAR' })).toBeVisible()
  const gnosisUsdcSwitch = popup.getByRole('switch', { name: 'Disable USDC on Gnosis' })
  await expect(gnosisUsdcSwitch).toBeVisible()
  await gnosisUsdcSwitch.click()
  const enableGnosisUsdc = popup.getByRole('switch', { name: 'Enable USDC on Gnosis' })
  await expect(enableGnosisUsdc).toBeVisible()
  await enableGnosisUsdc.click()
  await expect(popup.getByRole('switch', { name: 'Disable USDC on Gnosis' })).toBeVisible()
  await expect(popup.getByText('Token Could Not Be Enabled', { exact: true })).toHaveCount(0)
  const jupSwitch = popup.getByRole('switch', { name: 'Disable JUP on Solana' })
  await expect(jupSwitch).toBeVisible()

  const jupAssetId = `${SOLANA_NETWORKS.mainnet.chainId}/token:${solanaJupMint}`
  await expect
    .poll(async () => {
      const response = (await popup.evaluate(() =>
        chrome.runtime.sendMessage({ type: 'GET_MANAGED_TOKEN_ASSETS' })
      )) as { result?: { hiddenAssetIds?: readonly string[] } }
      return response.result?.hiddenAssetIds?.includes(jupAssetId) ?? true
    })
    .toBe(false)

  await popup.getByRole('button', { name: 'Back' }).click()
  const solanaUsdcRow = popup.getByRole('button', { name: 'View USDC details on Solana' })
  await expect(solanaUsdcRow).toBeVisible({
    timeout: 30_000
  })
  const refreshedAssetPrices = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_ASSET_PRICES', action: 'refresh' })
  )
  expect(refreshedAssetPrices).toHaveProperty('result.quotes')
  await expect
    .poll(async () => {
      const state = (await popup.evaluate(async () => {
        const response = await chrome.runtime.sendMessage({
          type: 'GET_ASSET_PRICES',
          action: 'read'
        })
        return { response }
      })) as {
        response?: {
          result?: {
            quotes?: Array<{
              assetId: string
              marketChange?: { source: string; percent24h: string }
            }>
          }
        }
      }
      const quote = state.response?.result?.quotes?.find(
        candidate =>
          candidate.assetId === `${SOLANA_NETWORKS.mainnet.chainId}/token:${solanaUsdcMint}`
      )
      return quote?.marketChange
    })
    .toEqual(expect.objectContaining({ source: 'defi-llama', percent24h: '0.01' }))
  await expect
    .poll(() =>
      solanaUsdcRow.locator('img[alt="USDC"]').evaluate(image => {
        const icon = image as HTMLImageElement
        return icon.complete && icon.naturalWidth > 0
      })
    )
    .toBe(true)
  await expect(solanaUsdcRow.getByText('$2.5', { exact: true })).toBeVisible()
  await expect(solanaUsdcRow.getByText('+0.01%', { exact: true })).toBeVisible()
  await expect(solanaUsdcRow.getByText('Solana', { exact: true })).toHaveCount(0)
  const solanaJupRow = popup.getByRole('button', { name: 'View JUP details on Solana' })
  await expect(solanaJupRow).toBeVisible()
  await expect(solanaJupRow.getByText('$3', { exact: true })).toBeVisible()
  await expect(solanaJupRow.getByText('-2.5%', { exact: true })).toBeVisible()
  await solanaJupRow.click()
  await expect(popup.getByRole('heading', { name: 'JUP', exact: true })).toBeVisible()
  await expect(popup.getByRole('img', { name: '1D price history' })).toBeVisible()
  expect(
    coinGeckoHistoryRequests.some(request =>
      new URL(request).pathname.endsWith('/coins/jupiter-exchange-solana/market_chart')
    )
  ).toBe(true)
  await popup.getByRole('button', { name: 'Back' }).click()
  await expect(popup.getByRole('heading', { name: 'Portfolio' })).toBeVisible()
  const nearUsdtRow = popup.getByRole('button', { name: 'View USDT details on NEAR' })
  await expect(nearUsdtRow).toBeVisible()
  await expect(nearUsdtRow.getByText('$4.5', { exact: true })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'View rNEAR details on NEAR' })).toBeVisible()
  const portfolioResponse = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_PORTFOLIO', action: 'refresh' })
  )
  expect(portfolioResponse).toHaveProperty('result.model')
  const model = (
    portfolioResponse as {
      result: {
        model: {
          chains: Array<{
            chain: { id: string }
            status: string
            errorCodes: readonly string[]
            assets: Array<{ asset: { id: string }; balance: { totalRaw: string } }>
          }>
        }
      }
    }
  ).result.model
  const solanaChain = model.chains.find(chain => chain.chain.id === SOLANA_NETWORKS.mainnet.chainId)
  const nearChain = model.chains.find(chain => chain.chain.id === NEAR_NETWORKS.mainnet.chainId)
  const solanaUsdcAssetId = `${SOLANA_NETWORKS.mainnet.chainId}/token:${solanaUsdcMint}`
  const nearUsdtAssetId = `${NEAR_NETWORKS.mainnet.chainId}/nep141:usdt.tether-token.near`
  expect({
    found: solanaChain !== undefined,
    status: solanaChain?.status,
    errorCodes: solanaChain?.errorCodes,
    assetBalances: Object.fromEntries(
      solanaChain?.assets.map(asset => [asset.asset.id, asset.balance.totalRaw]) ?? []
    )
  }).toEqual({
    found: true,
    status: 'ready',
    errorCodes: [],
    assetBalances: expect.objectContaining({
      [solanaUsdcAssetId]: '2500000',
      [jupAssetId]: '3000000'
    })
  })
  expect({
    found: nearChain !== undefined,
    status: nearChain?.status,
    errorCodes: nearChain?.errorCodes,
    assetBalances: Object.fromEntries(
      nearChain?.assets.map(asset => [asset.asset.id, asset.balance.totalRaw]) ?? []
    )
  }).toEqual({
    found: true,
    status: 'ready',
    errorCodes: [],
    assetBalances: expect.objectContaining({
      [nearUsdtAssetId]: '4500000',
      [rnearAssetId]: '200000000000000000000000'
    })
  })
  await popup.getByRole('tab', { name: 'Activity' }).click()
  const solanaUsdcActivity = popup.getByRole('button', {
    name: 'View Received USDC details on Solana'
  })
  await expect(solanaUsdcActivity).toBeVisible({ timeout: 30_000 })
  await expect(solanaUsdcActivity.getByText('+2.5 USDC', { exact: true })).toBeVisible()
  await expect(solanaUsdcActivity.locator('img[alt="USDC"]')).toBeVisible()
  const rnearActivity = popup.getByRole('button', { name: 'View Received rNEAR details on NEAR' })
  await expect(rnearActivity).toBeVisible({ timeout: 30_000 })
  await expect(rnearActivity.getByText('+0.2 rNEAR', { exact: true })).toBeVisible()
  expect(directSolanaHistoryMethods).toContain('getSignaturesForAddress')
  expect(directSolanaHistoryMethods).toContain('getTransaction')
  expect(directNearHistoryRequests).toBeGreaterThan(0)
  expect(unexpectedHistoryProxyRequests).toEqual([])
  await rnearActivity.click()
  const rnearActivityDetail = popup.locator('[data-activity-detail-id]')
  await expect(rnearActivityDetail.getByText('+0.2 rNEAR', { exact: true })).toBeVisible()
  await expect(rnearActivityDetail.getByText('Amount unavailable', { exact: true })).toHaveCount(0)
  await captureScreenshot(popup, 'release-default-rnear-activity.png')
  await popup.getByRole('button', { name: 'Close' }).click()

  await popup.getByRole('tab', { name: 'Assets' }).click()
  await popup.getByRole('button', { name: 'Manage Tokens' }).click()
  await popup.getByRole('button', { name: 'Add Token' }).click()
  let addTokenDialog = popup.getByRole('dialog')
  await addTokenDialog.getByRole('button', { name: 'Token network' }).click()
  const solanaTokenNetwork = popup.getByRole('menuitemradio', { name: /^Solana/ })
  await expect(solanaTokenNetwork).toBeVisible()
  await expect(popup.getByRole('menuitemradio', { name: /^NEAR/ })).toBeVisible()
  await solanaTokenNetwork.scrollIntoViewIfNeeded()
  await captureScreenshot(popup, 'REF-13204-near-solana-token-network-menu.png')
  await solanaTokenNetwork.click()
  await addTokenDialog.getByLabel('SPL Token mint address').fill(solanaJupMint)
  await addTokenDialog.getByRole('button', { name: 'Verify Token' }).click()
  await expect(addTokenDialog.getByText('JUP · 6 decimals', { exact: true })).toBeVisible()
  await captureScreenshot(popup, 'REF-13204-solana-spl-token-verified.png')
  await addTokenDialog.getByRole('button', { name: 'Add Token' }).click()
  await expect(addTokenDialog).toBeHidden()

  await popup.getByRole('button', { name: 'Add Token' }).click()
  addTokenDialog = popup.getByRole('dialog')
  await addTokenDialog.getByRole('button', { name: 'Token network' }).click()
  await popup.getByRole('menuitemradio', { name: /^NEAR/ }).click()
  await addTokenDialog.getByLabel('NEP-141 contract account').fill('jambo-1679.meme-cooking.near')
  await addTokenDialog.getByRole('button', { name: 'Verify Token' }).click()
  await expect(addTokenDialog.getByText('JAMBO · 18 decimals', { exact: true })).toBeVisible()
  await captureScreenshot(popup, 'REF-13204-near-nep141-token-verified.png')
  await addTokenDialog.getByRole('button', { name: 'Add Token' }).click()
  await expect(addTokenDialog).toBeHidden()
  await popup.getByRole('button', { name: 'Back' }).click()

  await popup.getByRole('button', { name: 'Swap', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Swap' })).toBeVisible()
  await popup.getByRole('button', { name: 'To asset' }).click()
  const assetSelector = popup.getByRole('dialog')
  await expect(assetSelector.getByText('Powered by CoinGecko', { exact: true })).toHaveCount(0)
  const [tokenSearchBox, networkFilterBox] = await Promise.all([
    assetSelector.getByPlaceholder('Search tokens').boundingBox(),
    assetSelector
      .getByRole('button', { name: 'Filter assets by network: All Networks' })
      .boundingBox()
  ])
  if (!tokenSearchBox || !networkFilterBox) {
    throw new Error('Swap asset selector controls do not have layout boxes')
  }
  expect(tokenSearchBox.y).toBeLessThan(networkFilterBox.y)
  await assetSelector
    .getByRole('button', { name: 'Filter assets by network: All Networks' })
    .click()
  await popup.getByRole('menuitemradio', { name: 'Gnosis', exact: true }).click()
  const tokenSearch = assetSelector.getByPlaceholder('Search tokens')
  await tokenSearch.fill('gnosis')
  await expect(assetSelector.getByText('No destination assets are available')).toBeVisible()
  await tokenSearch.fill('USDC')
  await expect(assetSelector.getByRole('button', { name: /^USDC on Gnosis/ })).toBeVisible()
  await assetSelector.getByRole('button', { name: 'Filter assets by network: Gnosis' }).click()
  await popup.getByRole('menuitemradio', { name: 'NEAR', exact: true }).click()
  await tokenSearch.fill('NEAR')
  await assetSelector.getByRole('button', { name: /^NEAR on NEAR/ }).click()
  const nearReceiveAddress = popup
    .getByText('Receive address', { exact: true })
    .locator('..')
    .locator('span[title]')
  await expect(nearReceiveAddress).toHaveAttribute('title', /^[a-f0-9]{64}$/)
  await expect(popup.getByText('Custom address', { exact: true })).toHaveCount(0)

  await popup.getByRole('button', { name: 'Back' }).click()
  await popup.getByRole('button', { name: 'Swap', exact: true }).click()
  await expect(popup.getByRole('status', { name: 'Loading swap assets' })).toHaveCount(0)
  await expect(popup.getByRole('button', { name: 'To asset' })).toContainText('NEAR')

  await popup.getByRole('button', { name: 'From asset' }).click()
  let sourceSelector = popup.getByRole('dialog')
  await sourceSelector
    .getByRole('button', { name: 'Filter assets by network: All Networks' })
    .click()
  await popup.getByRole('menuitemradio', { name: 'Gnosis', exact: true }).click()
  await sourceSelector.getByPlaceholder('Search tokens').fill('USDC')
  await sourceSelector.getByRole('button', { name: /^USDC on Gnosis/ }).click()
  await popup.getByRole('button', { name: 'Choose source account, current main' }).click()
  await popup
    .getByRole('dialog', { name: 'Choose source account' })
    .getByRole('radio', { name: /Confidential account/ })
    .click()
  await expect(
    popup.getByRole('button', { name: 'Choose source account, current private' })
  ).toBeVisible()

  await popup.getByRole('button', { name: 'From asset' }).click()
  sourceSelector = popup.getByRole('dialog')
  await sourceSelector
    .getByRole('button', { name: 'Filter assets by network: All Networks' })
    .click()
  await popup.getByRole('menuitemradio', { name: 'Solana', exact: true }).click()
  await sourceSelector.getByPlaceholder('Search tokens').fill('USDC')
  await sourceSelector.getByRole('button', { name: /^USDC on Solana/ }).click()
  await expect(
    popup.getByRole('button', { name: 'Choose source account, current private' })
  ).toHaveCount(0)
  const solanaSourceCard = popup.locator('section').filter({
    has: popup.getByRole('button', { name: 'From asset' })
  })
  await expect(solanaSourceCard.getByText('USDC', { exact: true })).toBeVisible()
  await expect(solanaSourceCard.getByRole('button', { name: /Choose source account/ })).toHaveCount(
    0
  )
  await captureScreenshot(popup, 'REF-13212-solana-source-uses-main-account.png')
})
