import { expect, type Page } from '@playwright/test'

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
