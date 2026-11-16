/** Keep panel-origin signing alive without replacing the tab that owns the panel. */
export async function launchHardwareSignSurface(
  url: string
): Promise<chrome.tabs.Tab & { id: number }> {
  const tab = await chrome.tabs.create({ url, active: true })
  if (typeof tab.id === 'number') return tab as chrome.tabs.Tab & { id: number }
  throw new Error('Hardware signing tab opened without an ID')
}
