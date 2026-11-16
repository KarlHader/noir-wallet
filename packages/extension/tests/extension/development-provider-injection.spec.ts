import { chromium, expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('injects the provider and its icon into the dApp MAIN world from the HMR extension', async () => {
  test.skip(process.env.DEV_EXTENSION_E2E !== '1', 'Requires pnpm dev:extension to be running')
  const extensionDirectory = path.join(extensionRoot, 'dist-dev')
  const profile = await mkdtemp(path.join(tmpdir(), 'noir-dev-provider-'))
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extensionDirectory}`,
      `--load-extension=${extensionDirectory}`
    ]
  })
  try {
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text())
    })
    const dappUrl = 'http://localhost:5005/provider-injection-regression'
    await context.route(dappUrl, route =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Provider integration</title>'
      })
    )
    await page.addInitScript(() => {
      const announcements: boolean[] = []
      Object.assign(window, { __noirEarlyAnnouncements: announcements })
      window.addEventListener('eip6963:announceProvider', (event: Event) => {
        if ((event as CustomEvent).detail?.info?.name === 'Noir Wallet') {
          announcements.push(!('noirwallet' in window))
        }
      })
    })
    await page.goto(dappUrl)
    await expect
      .poll(() =>
        page.evaluate(() =>
          Boolean((window as Window & { noirwallet?: { zcash?: unknown } }).noirwallet?.zcash)
        )
      )
      .toBe(true)
    const expectedIcon = `data:image/png;base64,${readFileSync(path.join(extensionRoot, 'public/icons/icon128.png')).toString('base64')}`
    const announcement = await page.evaluate(() => {
      let info: unknown = null
      const listen = (event: Event) => {
        info = (event as CustomEvent<{ info: unknown }>).detail.info
      }
      window.addEventListener('eip6963:announceProvider', listen)
      window.dispatchEvent(new Event('eip6963:requestProvider'))
      window.removeEventListener('eip6963:announceProvider', listen)
      return info
    })
    expect(announcement).toMatchObject({ name: 'Noir Wallet', icon: expectedIcon })
    expect(
      await page.evaluate(async icon => {
        const image = new Image()
        image.src = icon
        await image.decode()
        return { width: image.naturalWidth, height: image.naturalHeight }
      }, expectedIcon)
    ).toEqual({ width: 128, height: 128 })
    for (let reload = 0; reload < 5; reload += 1) {
      if (reload > 0) await page.reload()
      await expect
        .poll(() =>
          page.evaluate(() =>
            Boolean(
              (window as Window & { noirwallet?: { ethereum?: unknown } }).noirwallet?.ethereum
            )
          )
        )
        .toBe(true)
      const discovery = await page.evaluate(() => {
        let provider: unknown = null
        const listen = (event: Event) => {
          provider = (event as CustomEvent<{ provider: unknown }>).detail.provider
        }
        window.addEventListener('eip6963:announceProvider', listen)
        window.dispatchEvent(new Event('eip6963:requestProvider'))
        window.removeEventListener('eip6963:announceProvider', listen)
        return {
          announcedEarly: (window as Window & { __noirEarlyAnnouncements?: boolean[] })
            .__noirEarlyAnnouncements?.[0],
          sameProvider:
            provider ===
            (window as Window & { noirwallet?: { ethereum?: unknown } }).noirwallet?.ethereum
        }
      })
      expect(discovery).toEqual({ announcedEarly: true, sameProvider: true })
    }
    expect(errors.filter(error => /ReferenceError|__PROVIDER_ICON_DATA_URL__/.test(error))).toEqual(
      []
    )
  } finally {
    await context.close()
    await rm(profile, { recursive: true, force: true })
  }
})
