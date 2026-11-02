import {
  test as base,
  chromium,
  expect,
  type BrowserContext,
  type Page,
  type Route,
  type Worker
} from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureScreenshot } from './screenshot-fixture'
import { NETWORKS } from '../../src/config/networks'
import { DEFAULT_ENABLED_CHAIN_FEATURE_FLAGS } from '../../src/config/multichain-feature-flags'

export { captureScreenshot } from './screenshot-fixture'

type ExtensionFixtures = {
  context: BrowserContext
  extensionId: string
  popup: Page
}

export const e2eNetworkMode = process.env.NETWORK_MODE === 'testnet' ? 'testnet' : 'mainnet'
export const e2eBuildProfile = process.env.E2E_BUILD_PROFILE ?? `${e2eNetworkMode}-default`
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(e2eBuildProfile)) {
  throw new Error(`Invalid E2E_BUILD_PROFILE: ${e2eBuildProfile}`)
}
if (!e2eBuildProfile.startsWith(`${e2eNetworkMode}-`)) {
  throw new Error(
    `E2E_BUILD_PROFILE ${e2eBuildProfile} does not match NETWORK_MODE ${e2eNetworkMode}`
  )
}
const extensionPackageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const extensionDir = path.resolve(extensionPackageDir, 'e2e-dist', e2eBuildProfile)
const extensionPackage = JSON.parse(
  readFileSync(path.resolve(extensionPackageDir, 'package.json'), 'utf8')
) as { version?: unknown }

interface E2EBuildProfileMetadata {
  schemaVersion?: unknown
  profile?: unknown
  networkMode?: unknown
  enabledChainFeatureFlags?: unknown
}

const buildProfileMetadata = JSON.parse(
  readFileSync(path.resolve(extensionDir, 'e2e-build-profile.json'), 'utf8')
) as E2EBuildProfileMetadata
export const e2eEnabledChainFeatureFlags = [
  'chain.zcash',
  ...(process.env.ENABLED_CHAIN_FEATURE_FLAGS === undefined
    ? DEFAULT_ENABLED_CHAIN_FEATURE_FLAGS
    : process.env.ENABLED_CHAIN_FEATURE_FLAGS.split(',').map(flag => flag.trim())
  ).filter(flag => flag.length > 0 && flag !== 'chain.zcash')
].sort()

if (
  buildProfileMetadata.schemaVersion !== 1 ||
  buildProfileMetadata.profile !== e2eBuildProfile ||
  buildProfileMetadata.networkMode !== e2eNetworkMode ||
  !Array.isArray(buildProfileMetadata.enabledChainFeatureFlags) ||
  buildProfileMetadata.enabledChainFeatureFlags.some(flag => typeof flag !== 'string') ||
  JSON.stringify([...buildProfileMetadata.enabledChainFeatureFlags].sort()) !==
    JSON.stringify(e2eEnabledChainFeatureFlags)
) {
  throw new Error(
    `E2E build profile mismatch for ${extensionDir}; rebuild with the same NETWORK_MODE, E2E_BUILD_PROFILE, and ENABLED_CHAIN_FEATURE_FLAGS`
  )
}

if (typeof extensionPackage.version !== 'string') {
  throw new Error('Extension package version is missing')
}

export const mockReleaseNotesVersion = extensionPackage.version

export async function waitForBackgroundWalletInitialization(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const response = await chrome.runtime.sendMessage({
            type: 'GET_BACKGROUND_INITIALIZATION_STATE'
          })
          return response?.ready === true
        }),
      { timeout: 20_000 }
    )
    .toBe(true)
}

export async function selectImportedZcashHistory(
  page: Page,
  options: { readonly birthdayHeight?: number } = {}
): Promise<void> {
  await expect(page.getByRole('radio', { name: 'New to Zcash' })).toBeVisible()
  if (options.birthdayHeight === undefined) {
    await page.getByRole('radio', { name: 'New to Zcash' }).click()
  } else {
    await page.getByRole('radio', { name: 'Restore Zcash history' }).click()
    await page.getByRole('radio', { name: 'Block height' }).click()
    await page
      .getByRole('textbox', { name: 'Zcash birthday height' })
      .fill(String(options.birthdayHeight))
  }
  await page.getByRole('button', { name: 'Continue' }).click()
}

export async function mockUnknownZcashAccountHistory(
  context: BrowserContext
): Promise<() => Promise<void>> {
  const urls = new Set(Object.values(NETWORKS).map(network => new URL(network.nodeRpcUrl).href))
  const matcher = (url: URL) => urls.has(url.href)
  const handler = async (route: Route) => {
    const request = route.request().postDataJSON() as { method?: unknown } | null
    if (request?.method === 'getaddresstxids') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] })
      })
      return
    }
    await route.fallback()
  }
  await context.route(matcher, handler)
  return () => context.unroute(matcher, handler)
}

export async function selectNewZcashAccountHistory(page: Page): Promise<void> {
  await expect(page.getByRole('dialog', { name: 'Zcash account history' })).toBeVisible({
    timeout: 60_000
  })
  await page.getByRole('radio', { name: 'New Zcash account' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
}

async function getExtensionWorker(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
}

export async function terminateExtensionServiceWorker(
  context: BrowserContext,
  page: Page
): Promise<void> {
  const worker = await getExtensionWorker(context)
  const cdp = await context.newCDPSession(page)
  try {
    const targets = await cdp.send('Target.getTargets')
    const target = targets.targetInfos.find(
      candidate => candidate.type === 'service_worker' && candidate.url === worker.url()
    )
    if (!target) throw new Error('Extension service worker target was not found')
    await cdp.send('Target.closeTarget', { targetId: target.targetId })
  } finally {
    await cdp.detach()
  }
}

export const test = base.extend<ExtensionFixtures>({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless:
        process.env.NOIR_TESTNET_FUNDING_SOURCE !== '1' && process.env.APPROVAL_WINDOW_E2E !== '1',
      args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
    })
    await use(context)
    await context.close()
  },

  extensionId: async ({ context }, use) => {
    let serviceWorker = context.serviceWorkers()[0]
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker')
    }
    await use(new URL(serviceWorker.url()).host)
  },

  popup: async ({ context, extensionId }, use) => {
    const popup = await context.newPage()
    await popup.setViewportSize({ width: 375, height: 600 })
    await popup.goto(`chrome-extension://${extensionId}/index.html`)
    await use(popup)
    await popup.close()
  }
})

export { expect }
