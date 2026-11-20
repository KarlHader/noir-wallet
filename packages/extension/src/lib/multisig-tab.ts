import type { MultisigGroupScope } from './multisig-group-storage'
import type { MultisigTransportKind } from '@/core/multisig/types'

export const MULTISIG_ROUTE_PREFIX = '/multisig'

type MultisigTabScope = Pick<MultisigGroupScope, 'walletId' | 'accountId'>

function multisigRoute(page: 'create' | 'team', scope: MultisigTabScope): string {
  const query = new URLSearchParams({ walletId: scope.walletId, accountId: scope.accountId })
  return `${MULTISIG_ROUTE_PREFIX}/${page}?${query.toString()}`
}

export function multisigCreateRoute(scope: MultisigTabScope): string {
  return multisigRoute('create', scope)
}

export function multisigTeamRoute(scope: MultisigTabScope): string {
  return multisigRoute('team', scope)
}

export function multisigSendRoute(scope: MultisigGroupScope): string {
  return `${MULTISIG_ROUTE_PREFIX}/send?${new URLSearchParams({ ...scope }).toString()}`
}

export async function openMultisigSendTab(scope: MultisigGroupScope): Promise<void> {
  await chrome.tabs.create({ url: chrome.runtime.getURL(`index.html#${multisigSendRoute(scope)}`) })
}

export function multisigRecoverRoute(
  scope: MultisigGroupScope,
  transport: MultisigTransportKind
): string {
  return `${MULTISIG_ROUTE_PREFIX}/recover?${new URLSearchParams({ ...scope, transport }).toString()}`
}

export async function openMultisigRecoverTab(
  scope: MultisigGroupScope,
  transport: MultisigTransportKind
): Promise<void> {
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`index.html#${multisigRecoverRoute(scope, transport)}`)
  })
}

// Chrome rejects requestDevice() without showing the Bluetooth chooser in the popup, the side panel
// and popup-type windows, and the first camera prompt fails the same way in the popup and side
// panel, so the flow always runs in a full tab.
export function openMultisigCreateTab(scope: MultisigTabScope): void {
  chrome.tabs
    .create({ url: chrome.runtime.getURL(`index.html#${multisigCreateRoute(scope)}`) })
    .catch(console.error)
}

export function openMultisigTeamTab(scope: MultisigTabScope): void {
  chrome.tabs
    .create({ url: chrome.runtime.getURL(`index.html#${multisigTeamRoute(scope)}`) })
    .catch(console.error)
}

export function isMultisigTabRoute(hash: string): boolean {
  return hash.includes(`${MULTISIG_ROUTE_PREFIX}/`)
}
