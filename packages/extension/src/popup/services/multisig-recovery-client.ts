import { requestVaultGroup } from '@/core/worker/client'
import { parseVaultGroupScope } from '@/core/multisig/vault-group-rpc'
import { serveRecoverOverChannel } from '@/core/multisig/recover-ble'
import { BLE_DEVICE_QUERY, openWebBluetoothLink } from '@/core/multisig/ble/link'
import { connectSecureChannel, RECOVER_NOISE_PROLOGUE } from '@/core/multisig/ble/secure-channel'
import { generateNoiseStatic } from '@/core/multisig/ble/noise'
import { createIndexedDbIdentityStore } from '@/lib/multisig-identity-storage'
import { chooseBluetoothDevice } from '@/lib/multisig-bluetooth'
import { base64ToBytes, bytesToBase64 } from '@/lib/bytes'
import { withTimeout } from '@/lib/async-utils'
import { useWalletStore } from '@/store/wallet-store'
import type { MultisigGroupScope } from '@/lib/multisig-group-storage'
import type { MultisigTransportKind } from '@/core/multisig/types'

export interface PhoneRecoveryReply {
  recoveryId: string
  reply: string
  expiresAt: number
}

export function parsePhoneRecoveryLocation(
  search: string
): { scope: MultisigGroupScope; transport: MultisigTransportKind } | null {
  const params = new URLSearchParams(search)
  const transport = params.get('transport')
  if (transport !== 'qr' && transport !== 'ble') return null
  try {
    return {
      scope: parseVaultGroupScope({
        network: params.get('network'),
        walletId: params.get('walletId'),
        accountId: params.get('accountId')
      }),
      transport
    }
  } catch {
    return null
  }
}

export function assertPhoneRecoveryCurrent(scope: MultisigGroupScope, signal: AbortSignal): void {
  const state = useWalletStore.getState()
  if (
    signal.aborted ||
    state.currentNetwork !== scope.network ||
    state.currentWalletId !== scope.walletId ||
    state.currentAccountId !== scope.accountId
  )
    throw new Error('Phone recovery account changed')
}

export async function cancelPhoneRecovery(
  scope: MultisigGroupScope,
  recoveryId: string
): Promise<void> {
  await requestVaultGroup('vault.group.recover.cancel', { scope, recoveryId }).catch(() => {})
}

export async function preparePhoneRecovery(
  scope: MultisigGroupScope,
  request: Uint8Array,
  signal: AbortSignal
): Promise<PhoneRecoveryReply> {
  assertPhoneRecoveryCurrent(scope, signal)
  const reply = await requestVaultGroup('vault.group.recover.prepare', {
    scope,
    request: bytesToBase64(request)
  })
  try {
    assertPhoneRecoveryCurrent(scope, signal)
    return reply
  } catch (error) {
    await cancelPhoneRecovery(scope, reply.recoveryId)
    throw error
  }
}

export async function completePhoneRecovery(
  scope: MultisigGroupScope,
  recoveryId: string,
  signal: AbortSignal
): Promise<void> {
  assertPhoneRecoveryCurrent(scope, signal)
  if ((await requestVaultGroup('vault.group.recover.complete', { scope, recoveryId })) !== true)
    throw new Error('Phone recovery was not saved')
  assertPhoneRecoveryCurrent(scope, signal)
}

/** Uses the phone's existing recovery wire format; only encrypted config leaves the Worker. */
export async function sendPhoneRecoveryOverBluetooth(
  scope: MultisigGroupScope,
  signal: AbortSignal,
  confirmCode: (code: string) => Promise<boolean>,
  onPrepared: (reply: PhoneRecoveryReply) => void
): Promise<PhoneRecoveryReply | null> {
  // The chooser must start within the click's user activation.
  const selection = await chooseBluetoothDevice(BLE_DEVICE_QUERY)
  assertPhoneRecoveryCurrent(scope, signal)
  if (selection.status === 'cancelled') return null
  if (selection.status !== 'selected' || !selection.device) throw new Error('Bluetooth unavailable')
  const identity = await createIndexedDbIdentityStore().load()
  if (!identity) throw new Error('Wallet device identity unavailable')
  assertPhoneRecoveryCurrent(scope, signal)
  const channel = await connectSecureChannel(
    handlers => openWebBluetoothLink(selection.device!, handlers),
    {
      identity,
      noiseStatic: generateNoiseStatic(),
      prologue: RECOVER_NOISE_PROLOGUE,
      signal
    }
  )
  const close = () => channel.close()
  signal.addEventListener('abort', close, { once: true })
  try {
    assertPhoneRecoveryCurrent(scope, signal)
    let prepared: PhoneRecoveryReply | null = null
    const result = await serveRecoverOverChannel(
      {
        ...channel,
        receive: () => {
          assertPhoneRecoveryCurrent(scope, signal)
          return withTimeout(channel.receive(), 120_000, 'Phone recovery request')
        },
        send: bytes => {
          assertPhoneRecoveryCurrent(scope, signal)
          return channel.send(bytes)
        }
      },
      {
        confirmSas: () =>
          withTimeout(confirmCode(channel.sas), 120_000, 'Recovery code confirmation'),
        prepareReply: async request => {
          prepared = await preparePhoneRecovery(scope, request, signal)
          onPrepared(prepared)
          return base64ToBytes(prepared.reply)
        }
      }
    )
    if (!result.ok || !prepared) throw new Error('Phone recovery exchange failed')
    assertPhoneRecoveryCurrent(scope, signal)
    return prepared
  } finally {
    signal.removeEventListener('abort', close)
    channel.close()
  }
}
