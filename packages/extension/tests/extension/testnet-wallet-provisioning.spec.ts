import type { Page } from '@playwright/test'
import {
  expect,
  mockUnknownZcashAccountHistory,
  selectImportedZcashHistory,
  selectNewZcashAccountHistory,
  test,
  terminateExtensionServiceWorker,
  waitForBackgroundWalletInitialization
} from '../helpers/extension-fixtures'
import { BUILTIN_EVM_NETWORKS } from '../../src/config/networks'

const TEST_MNEMONIC_12 =
  'legal winner thank year wave sausage worth useful legal winner thank yellow'
const TEST_MNEMONIC_24 = `${'abandon '.repeat(23)}art`
const TEST_MNEMONIC_24_ACCOUNT_0 = Object.freeze({
  zcash:
    'utest1cqt4k0wjtvhalr5xfsd2s8enlgn72a3zcvecg7zg55qyyku4z4u5t9yansklfuznvuz077hfu2s8gq50nlln5x4wdxhjleapsn9fs6aua6z9kgpypckjxeku3xzh9qaqj96lk9lpq958ruem58kdfstaec8s725rz4l52xtrlj4cudds53aflght5c433gqkk6h8qvn6vq3u2wxuea5',
  evm: '0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb',
  bitcoin: 'tb1qtk89me2ae95dmlp3yfl4q9ynpux8mxjujuf2fr'
})
const V1_TEST_MNEMONICS = Object.freeze({
  12: `${'abandon '.repeat(11)}about`,
  24: TEST_MNEMONIC_24
})
const TESTNET_CHAIN_IDS = Object.freeze(
  [
    'bip122:000000000933ea01ad0ee984209779ba',
    'bip122:05a60a92d99d85997cce3b87616c089f',
    ...BUILTIN_EVM_NETWORKS.mainnet.map(network => network.chainId),
    ...BUILTIN_EVM_NETWORKS.testnet.map(network => network.chainId)
  ].sort()
)

async function enterMnemonic(page: Page, mnemonic: string, birthdayHeight?: number) {
  await page.locator('input[type="text"]').first().fill(mnemonic)
  await page.getByRole('button', { name: 'Continue' }).click()
  await selectImportedZcashHistory(page, { birthdayHeight })
}

async function openCredentialRepositoryIntegration(page: Page, extensionId: string) {
  await page.goto(
    `chrome-extension://${extensionId}/tests/extension/credential-repository-integration.html`
  )
  await expect
    .poll(() => page.evaluate(() => Boolean(window.credentialRepositoryIntegration)))
    .toBe(true)
}

async function openProvisioningInspector(page: Page, extensionId: string) {
  await openCredentialRepositoryIntegration(page, extensionId)
  return page.evaluate(() =>
    window.credentialRepositoryIntegration!.inspectProductionV2Provisioning()
  )
}

async function deriveZcashAddresses(page: Page, mnemonic: string, network: 'mainnet' | 'testnet') {
  const response: unknown = await page.evaluate(
    input =>
      chrome.runtime.sendMessage({
        type: 'WORKER_RPC',
        method: 'mnemonic.toAddresses',
        payload: { phrase: input.mnemonic, accountIndex: 0, network: input.network }
      }),
    { mnemonic, network }
  )
  if (typeof response !== 'object' || response === null || Array.isArray(response)) {
    throw new Error('Zcash address derivation returned an invalid response')
  }
  const result = (response as Record<string, unknown>).result
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new Error('Zcash address derivation did not return an address result')
  }
  const addresses = result as Record<string, unknown>
  if (
    typeof addresses.transparent !== 'string' ||
    typeof addresses.unified !== 'string' ||
    typeof addresses.full_unified !== 'string'
  ) {
    throw new Error('Zcash address derivation returned incomplete addresses')
  }
  return {
    transparent: addresses.transparent,
    shielded: addresses.unified,
    fullUnified: addresses.full_unified
  }
}

test('provisions every released testnet chain account atomically', async ({
  extensionId,
  popup
}) => {
  test.setTimeout(120_000)

  await popup.getByRole('button', { name: 'Create Wallet' }).click()
  await popup.getByPlaceholder('8–64 characters').fill('testnet-provisioning-password')
  await popup.getByPlaceholder('Confirm password').fill('testnet-provisioning-password')
  await popup.getByRole('checkbox').check()
  await popup.getByRole('button', { name: 'Create', exact: true }).click()
  await popup.getByLabel('Account name').fill('Primary Test Account')
  await popup.getByRole('radio', { name: '12 words' }).click()
  await popup.getByRole('button', { name: 'Continue' }).click()
  await popup.getByRole('button', { name: 'Start backup' }).click()
  await popup.getByRole('button', { name: 'Click to reveal seed phrase' }).click()

  const words = await popup.locator('div.grid.grid-cols-3 > div > div').allTextContents()
  expect(words).toHaveLength(12)
  await popup.getByRole('checkbox').check()
  await popup.getByRole('button', { name: 'Next' }).click()

  const firstVerificationPrompt = await popup.getByText(/^Select the .* words\.$/).textContent()
  const firstVerificationIndices = (firstVerificationPrompt?.match(/\d+/g) ?? []).map(
    ordinal => Number.parseInt(ordinal, 10) - 1
  )
  await popup.getByRole('button', { name: 'Back' }).click()
  await popup.getByRole('button', { name: 'Next' }).click()
  const verificationPrompt = await popup.getByText(/^Select the .* words\.$/).textContent()
  const verificationIndices = (verificationPrompt?.match(/\d+/g) ?? []).map(
    ordinal => Number.parseInt(ordinal, 10) - 1
  )
  expect(verificationIndices).not.toEqual(firstVerificationIndices)
  expect(verificationIndices).toHaveLength(2)
  for (const index of verificationIndices) {
    await popup
      .getByRole('button', { name: words[index], exact: true, pressed: false })
      .first()
      .click()
  }
  await popup.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Congratulations!' })).toBeVisible({
    timeout: 60_000
  })
  await popup.getByRole('button', { name: 'Got it' }).click()
  await expect(popup.getByRole('button', { name: 'Show account addresses' })).toBeVisible()
  await expect(popup.getByRole('tab', { name: 'Assets' })).toBeVisible()

  const provisioned = await openProvisioningInspector(popup, extensionId)
  expect(provisioned.activeGenerationId).not.toBeNull()
  expect(provisioned.chainAccounts).toHaveLength(TESTNET_CHAIN_IDS.length)
  expect(provisioned.accounts).toEqual([
    expect.objectContaining({ displayName: 'Primary Test Account' })
  ])
  expect([...new Set(provisioned.chainAccounts.map(item => item.chainId))].sort()).toEqual(
    TESTNET_CHAIN_IDS
  )
  expect(provisioned.chainAccounts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        chainId: 'bip122:05a60a92d99d85997cce3b87616c089f',
        path: "m/32'/1'/0'",
        identity: expect.stringMatching(/^utest1/)
      }),
      expect.objectContaining({
        chainId: 'eip155:11155111',
        path: "m/44'/60'/0'/0/0",
        identity: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/)
      }),
      expect.objectContaining({
        chainId: 'bip122:000000000933ea01ad0ee984209779ba',
        path: "m/84'/1'/0'/0/0",
        identity: expect.stringMatching(/^tb1q/)
      })
    ])
  )
  expect(provisioned.credentialPolicies).toEqual([
    expect.objectContaining({
      source: 'software',
      mnemonicWordCount: 12,
      zcashSeedPolicy: 'direct-bip39-v1'
    })
  ])
})

test('imports 24 words and extends the testnet wallet tree without crossing networks', async ({
  context,
  extensionId,
  popup
}) => {
  test.setTimeout(300_000)

  await popup.getByRole('button', { name: 'Import wallet' }).click()
  await expect(
    popup.getByText('This recovery phrase will restore accounts for every supported network.')
  ).toBeVisible()
  await popup.getByLabel('Account name').fill('Imported Test Account')
  await expect(popup.getByRole('radio', { name: '24 words' })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await popup.getByRole('button', { name: 'Continue' }).click()
  await enterMnemonic(popup, TEST_MNEMONIC_24, 3_000_000)

  await popup.getByPlaceholder('8–64 characters').fill('testnet-import-password')
  await popup.getByPlaceholder('Confirm password').fill('testnet-import-password')
  await popup.getByRole('checkbox').check()
  await popup.getByRole('button', { name: 'Import Wallet' }).click()
  await expect(popup.getByRole('heading', { name: 'Congratulations!' })).toBeVisible({
    timeout: 60_000
  })
  await expect(
    popup.getByText(
      'Your wallet is ready. Accounts for every supported network were restored from this recovery phrase.'
    )
  ).toBeVisible()

  const imported = await openProvisioningInspector(popup, extensionId)
  expect(imported.keyDomainIds).toHaveLength(1)
  expect(imported.accountIds).toHaveLength(1)
  expect(imported.accounts).toEqual([
    expect.objectContaining({ displayName: 'Imported Test Account' })
  ])
  expect(imported.chainAccounts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        chainId: 'bip122:05a60a92d99d85997cce3b87616c089f',
        path: "m/32'/1'/0'",
        identity: TEST_MNEMONIC_24_ACCOUNT_0.zcash
      }),
      expect.objectContaining({
        chainId: 'eip155:11155111',
        path: "m/44'/60'/0'/0/0",
        identity: TEST_MNEMONIC_24_ACCOUNT_0.evm
      }),
      expect.objectContaining({
        chainId: 'bip122:000000000933ea01ad0ee984209779ba',
        path: "m/84'/1'/0'/0/0",
        identity: TEST_MNEMONIC_24_ACCOUNT_0.bitcoin
      })
    ])
  )
  expect(imported.credentialPolicies).toEqual([
    expect.objectContaining({
      source: 'software',
      mnemonicWordCount: 24,
      zcashSeedPolicy: 'direct-bip39-v1'
    })
  ])

  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  const removeZcashHistoryMock = await mockUnknownZcashAccountHistory(context)
  await popup.getByRole('button', { name: 'Add Account', exact: true }).click()
  await selectNewZcashAccountHistory(popup)
  await expect(popup.getByText('Account 2', { exact: true })).toBeVisible({ timeout: 60_000 })
  await removeZcashHistoryMock()
  await expect(popup.getByRole('button', { name: 'Add Account', exact: true })).toBeEnabled({
    timeout: 60_000
  })

  await terminateExtensionServiceWorker(context, popup)
  await waitForBackgroundWalletInitialization(popup)
  await expect
    .poll(() =>
      popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_WALLET_SESSION_STATE' }))
    )
    .toEqual({ active: true })

  await popup.getByRole('button', { name: 'Add Wallet' }).click()
  await popup.getByRole('button', { name: 'Import Wallet', exact: true }).click()
  await popup.getByRole('button', { name: 'Secret Recovery Phrase', exact: true }).click()
  await popup.getByRole('radio', { name: '12 words' }).click()
  await popup.getByRole('button', { name: 'Continue' }).click()
  await enterMnemonic(popup, TEST_MNEMONIC_12)
  await expect(popup.getByRole('heading', { name: 'Congratulations!' })).toBeVisible({
    timeout: 60_000
  })

  const extended = await openProvisioningInspector(popup, extensionId)
  expect(extended.keyDomainIds).toHaveLength(2)
  expect(extended.accountIds).toHaveLength(3)
  expect(extended.chainAccounts).toHaveLength(3 * TESTNET_CHAIN_IDS.length)
  expect([...new Set(extended.chainAccounts.map(item => item.chainId))].sort()).toEqual(
    TESTNET_CHAIN_IDS
  )

  const policyByWordCount = new Map(
    extended.credentialPolicies.map(policy => [policy.mnemonicWordCount, policy])
  )
  expect([...policyByWordCount.keys()].sort()).toEqual([12, 24])
  expect(
    extended.credentialPolicies.every(
      policy => policy.source === 'software' && policy.zcashSeedPolicy === 'direct-bip39-v1'
    )
  ).toBe(true)

  const importedKeyDomainId = policyByWordCount.get(24)?.keyDomainId
  expect(importedKeyDomainId).toBeDefined()
  const importedChainAccounts = extended.chainAccounts.filter(
    item => item.keyDomainId === importedKeyDomainId
  )
  expect(importedChainAccounts).toHaveLength(2 * TESTNET_CHAIN_IDS.length)
  expect(importedChainAccounts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        chainId: 'bip122:05a60a92d99d85997cce3b87616c089f',
        path: "m/32'/1'/1'",
        identity: expect.stringMatching(/^utest1/)
      }),
      expect.objectContaining({
        chainId: 'eip155:11155111',
        path: "m/44'/60'/0'/0/1",
        identity: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/)
      }),
      expect.objectContaining({
        chainId: 'bip122:000000000933ea01ad0ee984209779ba',
        path: "m/84'/1'/1'/0/0",
        identity: expect.stringMatching(/^tb1q/)
      })
    ])
  )

  const addedWalletKeyDomainId = policyByWordCount.get(12)?.keyDomainId
  expect(addedWalletKeyDomainId).toBeDefined()
  expect(
    extended.chainAccounts.filter(item => item.keyDomainId === addedWalletKeyDomainId)
  ).toHaveLength(TESTNET_CHAIN_IDS.length)
  expect(extended.addressSchemes).toEqual([
    'bitcoin-p2wpkh',
    'evm',
    'zcash-full-unified',
    'zcash-shielded-unified',
    'zcash-transparent-p2pkh'
  ])

  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await popup.getByRole('button', { name: 'Choose wallet' }).click()
  await popup.getByRole('button', { name: 'Add Wallet' }).click()
  await popup.getByRole('button', { name: 'Create New Wallet' }).click()
  await expect(popup.getByRole('radio', { name: '24 words' })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await popup.getByRole('button', { name: 'Continue' }).click()
  await popup.getByRole('button', { name: 'Start backup' }).click()
  await popup.getByRole('button', { name: 'Click to reveal seed phrase' }).click()

  const generatedWords = await popup.locator('div.grid.grid-cols-3 > div > div').allTextContents()
  expect(generatedWords).toHaveLength(24)
  await popup.getByRole('checkbox').check()
  await popup.getByRole('button', { name: 'Next' }).click()

  const generatedPrompt = await popup.getByText(/^Select the .* words\.$/).textContent()
  const generatedIndices = (generatedPrompt?.match(/\d+/g) ?? []).map(
    ordinal => Number.parseInt(ordinal, 10) - 1
  )
  expect(generatedIndices).toHaveLength(2)
  for (const index of generatedIndices) {
    await popup.getByRole('button', { name: generatedWords[index], exact: true }).first().click()
  }
  await popup.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(popup.getByRole('heading', { name: 'Congratulations!' })).toBeVisible({
    timeout: 60_000
  })

  const generated = await openProvisioningInspector(popup, extensionId)
  expect(generated.keyDomainIds).toHaveLength(3)
  expect(generated.accountIds).toHaveLength(4)
  expect(generated.chainAccounts).toHaveLength(4 * TESTNET_CHAIN_IDS.length)
  expect(
    generated.credentialPolicies.filter(policy => policy.mnemonicWordCount === 24)
  ).toHaveLength(2)
})

for (const wordCount of [12, 24] as const) {
  test(`migrates a retained V1 ${wordCount}-word profile into the testnet chain set`, async ({
    extensionId,
    popup
  }) => {
    test.setTimeout(180_000)
    const password = `testnet-v1-${wordCount}-password`

    await waitForBackgroundWalletInitialization(popup)
    const addresses = await deriveZcashAddresses(popup, V1_TEST_MNEMONICS[wordCount], 'testnet')
    await openCredentialRepositoryIntegration(popup, extensionId)
    const prepared = await popup.evaluate(
      input =>
        window.credentialRepositoryIntegration!.prepareProductionV1Migration(
          input.password,
          input.wordCount,
          false,
          { network: 'testnet', addresses: input.addresses }
        ),
      { password, wordCount, addresses }
    )
    expect(prepared).toEqual({
      walletId: 'wallet:retained-v1-e2e',
      wordCount,
      network: 'testnet'
    })

    await popup.goto(`chrome-extension://${extensionId}/index.html`)
    if (wordCount === 12) {
      const wrongPassword = await popup.evaluate(() =>
        chrome.runtime.sendMessage({
          type: 'WALLET_UNLOCK',
          password: 'wrong-testnet-v1-password'
        })
      )
      expect(wrongPassword?.success).not.toBe(true)
      const inactive = await openProvisioningInspector(popup, extensionId)
      expect(inactive.activeGenerationId).toBeNull()
      await popup.goto(`chrome-extension://${extensionId}/index.html`)
    }
    const unlock = await popup.evaluate(
      value => chrome.runtime.sendMessage({ type: 'WALLET_UNLOCK', password: value }),
      password
    )
    expect(unlock).toMatchObject({ success: true, credentialStatus: 'migrated' })

    const provisioned = await openProvisioningInspector(popup, extensionId)
    expect(provisioned).toMatchObject({
      mainKeyDomainId: 'wallet:retained-v1-e2e',
      activeAccount: {
        keyDomainId: 'wallet:retained-v1-e2e',
        accountId: 'account:retained-v1-e2e:0'
      },
      keyDomainIds: ['wallet:retained-v1-e2e'],
      accountIds: ['account:retained-v1-e2e:0'],
      credentialPolicies: [
        {
          keyDomainId: 'wallet:retained-v1-e2e',
          source: 'software',
          mnemonicWordCount: wordCount,
          zcashSeedPolicy: 'direct-bip39-v1'
        }
      ]
    })
    expect(provisioned.activeGenerationId).not.toBeNull()
    const activeGenerationId = provisioned.activeGenerationId
    expect(provisioned.chainAccounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chainId: 'bip122:05a60a92d99d85997cce3b87616c089f',
          path: "m/32'/1'/0'",
          identity: addresses.fullUnified
        }),
        expect.objectContaining({
          chainId: 'eip155:11155111',
          path: "m/44'/60'/0'/0/0",
          identity:
            wordCount === 12
              ? '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
              : TEST_MNEMONIC_24_ACCOUNT_0.evm
        }),
        expect.objectContaining({
          chainId: 'bip122:000000000933ea01ad0ee984209779ba',
          path: "m/84'/1'/0'/0/0",
          identity: expect.stringMatching(/^tb1q/)
        })
      ])
    )
    expect(provisioned.chainAccounts).toHaveLength(TESTNET_CHAIN_IDS.length)
    expect([...new Set(provisioned.chainAccounts.map(item => item.chainId))].sort()).toEqual(
      TESTNET_CHAIN_IDS
    )
    expect(
      provisioned.chainAccounts.some(item =>
        [
          'bip122:00040fe8ec8471911baa1db1266ea15d',
          'bip122:000000000019d6689c085ae165831e93'
        ].includes(item.chainId)
      )
    ).toBe(false)
    await expect(
      popup.evaluate(async walletId => {
        const key = `seed_${walletId}`
        const local = await chrome.storage.local.get(key)
        const legacySession = await chrome.storage.session.get([
          'session_password',
          'session_key_material'
        ])
        return {
          retainedEnvelopePresent: local[key] !== undefined,
          legacySession
        }
      }, prepared.walletId)
    ).resolves.toEqual({ retainedEnvelopePresent: true, legacySession: {} })

    await popup.goto(`chrome-extension://${extensionId}/index.html`)
    await expect(
      popup.evaluate(() => chrome.runtime.sendMessage({ type: 'WALLET_LOCKED' }))
    ).resolves.toEqual({ success: true })
    await expect(
      popup.evaluate(
        value => chrome.runtime.sendMessage({ type: 'WALLET_UNLOCK', password: value }),
        password
      )
    ).resolves.toMatchObject({ success: true })
    const reprovisioned = await openProvisioningInspector(popup, extensionId)
    expect(reprovisioned.activeGenerationId).toBe(activeGenerationId)
  })
}

test('rejects a mainnet V1 Zcash anchor in the testnet build without activating V2', async ({
  extensionId,
  popup
}) => {
  test.setTimeout(120_000)
  const password = 'testnet-v1-cross-network-password'

  await waitForBackgroundWalletInitialization(popup)
  const mainnetAddresses = await deriveZcashAddresses(popup, V1_TEST_MNEMONICS[12], 'mainnet')
  await openCredentialRepositoryIntegration(popup, extensionId)
  const prepared = await popup.evaluate(
    input =>
      window.credentialRepositoryIntegration!.prepareProductionV1Migration(
        input.password,
        12,
        false,
        { network: 'testnet', addresses: input.addresses }
      ),
    { password, addresses: mainnetAddresses }
  )

  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  const unlock = await popup.evaluate(
    value => chrome.runtime.sendMessage({ type: 'WALLET_UNLOCK', password: value }),
    password
  )
  expect(unlock?.success).not.toBe(true)

  const inactive = await openProvisioningInspector(popup, extensionId)
  expect(inactive.activeGenerationId).toBeNull()
  await expect(
    popup.evaluate(async walletId => {
      const key = `seed_${walletId}`
      const local = await chrome.storage.local.get(key)
      return local[key] !== undefined
    }, prepared.walletId)
  ).resolves.toBe(true)
  await popup.goto(`chrome-extension://${extensionId}/index.html`)
  await expect(
    popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_WALLET_SESSION_STATE' }))
  ).resolves.toEqual({ active: false })
})
