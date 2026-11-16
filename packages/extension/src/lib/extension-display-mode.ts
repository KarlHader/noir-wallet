export const EXTENSION_DISPLAY_MODE_STORAGE_KEY = 'extension_display_mode'

export interface StoredExtensionDisplayMode {
  sidePanelMode: boolean
}

export function isSidePanelSurface(search: string): boolean {
  return new URLSearchParams(search).get('surface') === 'side-panel'
}

export function readStoredExtensionDisplayMode(value: unknown): boolean | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null

  const sidePanelMode = (value as Record<string, unknown>).sidePanelMode
  return typeof sidePanelMode === 'boolean' ? sidePanelMode : null
}
