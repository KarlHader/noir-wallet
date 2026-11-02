import {
  registerProtocolFixtures,
  captureScreenshot,
  expect,
  expectNoOverflow,
  importTestWallet,
  mockBitcoinNetwork,
  mockEvmNetwork,
  mockProtocolApis,
  test,
  waitForBackgroundWalletInitialization
} from '../../helpers/protocol-wallet'

registerProtocolFixtures()

test('isolates EVM Lending identities, positions, and retry across account changes', async ({
  context,
  popup
}) => {
  test.setTimeout(180_000)
  const emptyAddress = '7e5f4552091a69125d5dfcb7b8c2659029395bdf'
  const suppliedAddress = '2b5ad5c4795c026514f8317c7a215e218dccd6cf'
  const queriedWallets: string[] = []
  const errors: string[] = []
  popup.on('console', message => {
    if (message.text().includes('[LendingStore]')) errors.push(message.text())
  })
  await mockEvmNetwork(context)
  await mockBitcoinNetwork(context)
  const protocol = await mockProtocolApis(context, {
    mcaId: 'rhea00000x.multica.near',
    includeMultichainMarkets: true,
    mcaByWallet: wallet => {
      if (!wallet.EVM) return 'rhea00000x.multica.near'
      const address = wallet.EVM.toLowerCase()
      queriedWallets.push(address)
      return address === suppliedAddress ? 'rhea00000x.multica.near' : null
    }
  })
  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)

  const importEvmAccount = (digit: number) =>
    popup.evaluate(async keyDigit => {
      const response = await chrome.runtime.sendMessage({
        type: 'IMPORT_PRIVATE_KEY_WALLET',
        privateKey: `0x${'00'.repeat(31)}0${keyDigit}`,
        chainFamily: 'eip155',
        displayName: `EVM ${keyDigit}`
      })
      if (response.success !== true) throw new Error('Synthetic EVM import failed')
      return { walletId: response.result.keyDomainId, accountId: response.result.accountId }
    }, digit)

  const first = await importEvmAccount(1)
  await popup.getByRole('tab', { name: 'Lending', exact: true }).click()
  await expect(popup.getByText('No lending positions yet', { exact: true })).toBeVisible({
    timeout: 30_000
  })
  await expect(popup.getByText('Unable to check lending account', { exact: true })).toHaveCount(0)
  expect(queriedWallets).toContain(emptyAddress)
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'protocol-wallet-lending-evm-empty.png')

  await importEvmAccount(2)
  const position = popup.locator('[data-home-lending-position="eth.bridge.near"]')
  await expect(position).toContainText('1.5 ETH', { timeout: 30_000 })
  expect(queriedWallets).toContain(suppliedAddress)
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'protocol-wallet-lending-evm-position.png')

  protocol.setNearOnline(false)
  await importEvmAccount(3)
  await expect(position).toHaveCount(0)
  await expect(popup.getByText('Unable to check lending account', { exact: true })).toBeVisible({
    timeout: 45_000
  })
  await expect(popup.getByText('No lending positions yet', { exact: true })).toHaveCount(0)
  await captureScreenshot(popup, 'protocol-wallet-lending-evm-retry.png')
  protocol.setNearOnline(true)
  await popup.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(popup.getByText('No lending positions yet', { exact: true })).toBeVisible({
    timeout: 30_000
  })
  await expect(popup.getByText('Unable to check lending account', { exact: true })).toHaveCount(0)
  await captureScreenshot(popup, 'protocol-wallet-lending-evm-recovered.png')

  const firstAccountQueries = queriedWallets.filter(address => address === emptyAddress).length
  await expect(
    popup.evaluate(scope => chrome.runtime.sendMessage({ type: 'SWITCH_ACCOUNT', ...scope }), first)
  ).resolves.toMatchObject({ success: true })
  await expect
    .poll(() => queriedWallets.filter(address => address === emptyAddress).length)
    .toBeGreaterThan(firstAccountQueries)
  await expect(popup.getByText('No lending positions yet', { exact: true })).toBeVisible({
    timeout: 30_000
  })
  await expect(position).toHaveCount(0)
  await captureScreenshot(popup, 'protocol-wallet-lending-evm-switch-back.png')
  expect(errors.some(error => error.includes('identity resolver required'))).toBe(false)
  expect(errors.some(error => error.includes('Invalid cached Lending market icon'))).toBe(false)
})

test('renders RHEA multi-asset lending positions on Home', async ({ context, popup }) => {
  test.setTimeout(180_000)
  await mockEvmNetwork(context)
  await mockBitcoinNetwork(context)
  await mockProtocolApis(context, {
    mcaId: 'rhea00000x.multica.near',
    includeMultichainMarkets: true
  })

  await waitForBackgroundWalletInitialization(popup)
  await importTestWallet(popup)
  await popup.getByRole('tab', { name: 'Lending' }).click()
  await expect(popup.locator('[data-home-lending-position="eth.bridge.near"]')).toContainText(
    '1.5 ETH',
    {
      timeout: 30_000
    }
  )
  await expect(popup.getByText('$3,750.00', { exact: true }).first()).toBeVisible()
  await expect(popup.getByTestId('home-total-assets')).toContainText('$', { timeout: 30_000 })
  await expectNoOverflow(popup)
  await captureScreenshot(popup, 'protocol-wallet-home-lending-multichain-positions.png')
})
