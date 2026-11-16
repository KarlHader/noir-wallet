import type { UR } from '@ngraveio/bc-ur'
import { parseBitcoinAccount, parseMultiAccounts } from './account-ur'
import type { KeystoneFirmwareProfile } from './firmware-profile'
import { parseZcashAccounts } from './ur'

export type KeystoneConnectionAccount =
  | Readonly<{
      firmwareProfile: 'cypherpunk'
      accountExport: ReturnType<typeof parseZcashAccounts>
    }>
  | Readonly<{
      firmwareProfile: 'multi-coin'
      accountExport: ReturnType<typeof parseMultiAccounts>
    }>
  | Readonly<{
      firmwareProfile: 'bitcoin-only'
      accountExport: ReturnType<typeof parseBitcoinAccount>
    }>

export function parseKeystoneConnectionAccount(
  firmwareProfile: KeystoneFirmwareProfile,
  ur: UR
): KeystoneConnectionAccount {
  if (firmwareProfile === 'cypherpunk') {
    return Object.freeze({ firmwareProfile, accountExport: parseZcashAccounts(ur) })
  }
  if (firmwareProfile === 'multi-coin') {
    return Object.freeze({ firmwareProfile, accountExport: parseMultiAccounts(ur) })
  }
  return Object.freeze({ firmwareProfile, accountExport: parseBitcoinAccount(ur) })
}
