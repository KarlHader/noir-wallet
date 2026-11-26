import { isSidePanelSurface } from '@/lib/extension-display-mode'

const HARDWARE_SHIELD_SURFACE = 'hardware-shield'

export function isShieldHardwareTab(search: string): boolean {
  return new URLSearchParams(search).get('surface') === HARDWARE_SHIELD_SURFACE
}

export function needsShieldHardwareTab(hardware: boolean): boolean {
  const { search } = window.location
  return hardware && !isSidePanelSurface(search) && !isShieldHardwareTab(search)
}

export async function openShieldHardwareTab(path: string): Promise<void> {
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`index.html?surface=${HARDWARE_SHIELD_SURFACE}#${path}`)
  })
}
