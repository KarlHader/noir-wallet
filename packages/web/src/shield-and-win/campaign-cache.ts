import { campaignFromUnknown, type ShieldWinCampaign } from './api'

const STORAGE_KEY = 'shield-win.campaign.v1'

export interface CampaignStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function readCachedCampaign(
  storage: CampaignStorage | null = browserStorage()
): ShieldWinCampaign | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return null
    return campaignFromUnknown(JSON.parse(raw))
  } catch {
    return null
  }
}

export function writeCachedCampaign(
  campaign: ShieldWinCampaign,
  storage: CampaignStorage | null = browserStorage()
): void {
  if (!storage) return
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(campaign))
  } catch {
    return
  }
}

export function clearCachedCampaign(storage: CampaignStorage | null = browserStorage()): void {
  if (!storage) return
  try {
    storage.removeItem(STORAGE_KEY)
  } catch {
    return
  }
}

function browserStorage(): CampaignStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}
