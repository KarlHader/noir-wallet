import type { Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const screenshotDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../e2e-output/screenshots'
)

export async function captureScreenshot(
  page: Page,
  filename: string,
  options: { readonly preservePointer?: boolean } = {}
): Promise<void> {
  if (process.env.E2E_SCREENSHOTS !== '1') return
  if (!options.preservePointer) await page.mouse.move(1, 1)
  await page
    .waitForFunction(
      () =>
        Array.from(document.images).every(image => {
          const bounds = image.getBoundingClientRect()
          const visible =
            bounds.width > 0 &&
            bounds.height > 0 &&
            bounds.bottom > 0 &&
            bounds.right > 0 &&
            bounds.top < window.innerHeight &&
            bounds.left < window.innerWidth
          return !visible || image.complete
        }),
      undefined,
      { timeout: 5_000 }
    )
    .catch(() => undefined)
  await page.evaluate(async () => {
    const animations = document
      .getAnimations()
      .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
    await Promise.all(animations.map(animation => animation.finished.catch(() => undefined)))
  })
  await mkdir(screenshotDirectory, { recursive: true })
  await page.screenshot({ path: path.join(screenshotDirectory, filename), fullPage: true })
}
