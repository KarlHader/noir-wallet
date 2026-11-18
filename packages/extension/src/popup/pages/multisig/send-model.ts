import { parseDisplayUnitAmount } from '@/lib/number-format'
import { ZEC_DECIMALS } from '@/config/wallet'
import { thresholdDeviceCount } from '@/core/multisig/types'
import { parseVaultGroupScope } from '@/core/multisig/vault-group-rpc'
import type { AccountSource } from '@/core/accounts/domain'
import type { DeviceSlot, MultisigGroupRecord } from '@/core/multisig/types'
import type { MultisigGroupScope } from '@/lib/multisig-group-storage'

interface ActiveSendAccount {
  network: 'mainnet' | 'testnet'
  walletId: string | null
  accountId: string | null
  source?: AccountSource
}

export interface MultisigSendContext {
  scope: MultisigGroupScope
  group: MultisigGroupRecord
}

export function parseMultisigSendScope(search: string): MultisigGroupScope | null {
  const params = new URLSearchParams(search)
  try {
    return parseVaultGroupScope({
      network: params.get('network'),
      walletId: params.get('walletId'),
      accountId: params.get('accountId')
    })
  } catch {
    return null
  }
}

function hasSendRoster(group: MultisigGroupRecord): boolean {
  if (
    group.mock ||
    !['2-of-2', '2-of-3', '3-of-3'].includes(group.threshold) ||
    group.devices.length !== thresholdDeviceCount(group.threshold)
  )
    return false
  const slots = new Set(group.devices.map(device => device.slot))
  return (
    group.devices.every(
      device =>
        Number.isInteger(device.slot) &&
        (device.slot === 1
          ? device.role === 'owner' && device.platform === 'extension'
          : device.slot >= 2 &&
            device.slot <= group.devices.length &&
            device.role === 'guardian' &&
            ['ios', 'android'].includes(device.platform))
    ) &&
    slots.size === group.devices.length &&
    slots.has(1)
  )
}

/** UI slots are one-based; the authenticated signing protocol uses extension slot zero. */
export function getMultisigSendSlots(
  group: MultisigGroupRecord,
  selectedPhone: DeviceSlot | null
): number[] | null {
  if (!hasSendRoster(group)) return null
  if (group.threshold === '2-of-3') {
    if (
      selectedPhone === null ||
      selectedPhone === 1 ||
      !group.devices.some(device => device.slot === selectedPhone && device.role === 'guardian')
    ) {
      return null
    }
    return [0, selectedPhone - 1]
  }
  return group.devices.map(device => device.slot - 1).sort((left, right) => left - right)
}

/** Cached roster display never substitutes for Background's authenticated scope checks. */
export function resolveMultisigSendContext(
  scope: MultisigGroupScope | null,
  active: ActiveSendAccount,
  group: MultisigGroupRecord | null
): MultisigSendContext | null {
  if (
    !scope ||
    !group ||
    !hasSendRoster(group) ||
    active.network !== scope.network ||
    active.walletId !== scope.walletId ||
    active.accountId !== scope.accountId ||
    active.source?.kind !== 'frost-vault' ||
    active.source.version !== 1 ||
    active.source.network !== scope.network ||
    active.source.groupId !== group.groupId
  )
    return null
  return { scope, group }
}

export function parseMultisigSendAmount(amount: string): string | null {
  try {
    const zats = parseDisplayUnitAmount(amount, ZEC_DECIMALS)
    return BigInt(zats) > 0n && BigInt(zats) <= 2_100_000_000_000_000n ? zats : null
  } catch {
    return null
  }
}
