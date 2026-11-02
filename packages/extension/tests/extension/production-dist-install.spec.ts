import { chromium, expect, test } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureScreenshot } from '../helpers/screenshot-fixture'

const extensionPackageDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
)
const productionExtensionDirectory = path.join(extensionPackageDirectory, 'dist')
test('installs the production dist without test-only extension surfaces', async () => {
  test.setTimeout(90_000)
  const manifest = JSON.parse(
    readFileSync(path.join(productionExtensionDirectory, 'manifest.json'), 'utf8')
  ) as { name?: unknown; manifest_version?: unknown }
  expect(manifest).toMatchObject({ name: 'Noir Wallet', manifest_version: 3 })
  expect(existsSync(path.join(productionExtensionDirectory, 'e2e-build-profile.json'))).toBe(false)
  expect(existsSync(path.join(productionExtensionDirectory, 'tests'))).toBe(false)

  const profileDirectory = await mkdtemp(path.join(tmpdir(), 'noir-production-dist-'))
  const context = await chromium.launchPersistentContext(profileDirectory, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${productionExtensionDirectory}`,
      `--load-extension=${productionExtensionDirectory}`
    ]
  })
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
    const extensionId = new URL(worker.url()).host
    await context.route('https://provider-install.example/**', route =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Provider install</title>'
      })
    )
    const dapp = await context.newPage()
    await dapp.addInitScript(() => {
      const events: string[] = []
      Object.assign(window, { __providerDiscoveryEvents: events })
      window.addEventListener('eip6963:announceProvider', (event: Event) => {
        if ((event as CustomEvent).detail?.info?.name === 'Noir Wallet') events.push('announce')
      })
      window.addEventListener('eip6963:requestProvider', () => events.push('request'))
    })
    await dapp.goto('https://provider-install.example/')
    await expect
      .poll(() =>
        dapp.evaluate(() => {
          const target = window as Window & {
            __providerDiscoveryEvents?: string[]
            noirwallet?: { ethereum?: unknown }
          }
          return {
            firstEvent: target.__providerDiscoveryEvents?.[0],
            providerReady: Boolean(target.noirwallet?.ethereum)
          }
        })
      )
      .toEqual({ firstEvent: 'announce', providerReady: true })

    const popup = await context.newPage()
    await popup.setViewportSize({ width: 375, height: 600 })
    await popup.goto(`chrome-extension://${extensionId}/index.html`)

    await expect(popup.getByRole('heading', { name: 'Welcome to Noir Wallet' })).toBeVisible({
      timeout: 60_000
    })
    const hardwareWalletButton = popup.getByRole('button', {
      name: 'Connect Hardware Wallet'
    })
    await expect(hardwareWalletButton).toBeVisible()
    await expect
      .poll(() =>
        popup.evaluate(() => ({
          viewportWidth: document.documentElement.clientWidth,
          contentWidth: document.documentElement.scrollWidth
        }))
      )
      .toEqual({ viewportWidth: 375, contentWidth: 375 })
    await expect(
      popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_NETWORK_MODE' }))
    ).resolves.toEqual({
      result: { networkMode: 'mainnet', restartRequired: false }
    })
    await expect(
      popup.evaluate(() =>
        chrome.runtime.sendMessage({ type: 'SWITCH_NETWORK_MODE', networkMode: 'testnet' })
      )
    ).resolves.toEqual({ error: 'Unlock the wallet before switching networks' })

    await captureScreenshot(popup, 'production-dist-mainnet-install.png')
  } finally {
    await context.close()
    await rm(profileDirectory, { recursive: true, force: true })
  }
})
