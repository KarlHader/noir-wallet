import {
  browserStorage,
  readStored,
  removeStored,
  writeStored,
  type KeyValueStorage
} from '../lib/storage'
import { campaignFromUnknown, type ShieldWinCampaign } from './api'

const STORAGE_KEY = 'shield-win.campaign.v1'

export type CampaignStorage = KeyValueStorage

export function readCachedCampaign(
  storage: CampaignStorage | null = browserStorage()
): ShieldWinCampaign | null {
  return readStored(STORAGE_KEY, campaignFromUnknown, storage)
}

export function writeCachedCampaign(
  campaign: ShieldWinCampaign,
  storage: CampaignStorage | null = browserStorage()
): void {
  writeStored(STORAGE_KEY, campaign, storage)
}

export function clearCachedCampaign(storage: CampaignStorage | null = browserStorage()): void {
  removeStored(STORAGE_KEY, storage)
}
