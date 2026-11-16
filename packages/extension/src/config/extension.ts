/**
 * UI configuration constants
 */

export const UI_CONFIG = {
  DAPP_WINDOW: {
    WIDTH: 375,
    HEIGHT: 632
  },

  POPUP: {
    WIDTH: 375,
    HEIGHT: 600
  }
} as const

export const EXTENSION_POPUP_PATH = 'index.html'
export const EXTENSION_SIDE_PANEL_PATH = 'index.html?surface=side-panel'

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export const DAPP_CONTENT_SCRIPT_MATCHES = ['https://*/*', 'http://localhost/*'] as const
