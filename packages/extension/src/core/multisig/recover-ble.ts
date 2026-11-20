/**
 * The extension's side of restoring a phone over Bluetooth (iOS `KGBleRecovery`).
 *
 * The phone advertises, this side connects and runs the handshake (`connectSecureChannel` with
 * `RECOVER_NOISE_PROLOGUE`). Both screens then show the same code and the user compares them. Only
 * after that does the phone send its recovery request. The Worker verifies the share and returns
 * only the encrypted reply; this transport helper never handles the group config.
 */
import { bytesToBase64 } from '@/lib/bytes'
import type { SecureChannel } from './ble/secure-channel'
import { parseRecoverRequest } from './recover-handshake'

export type RecoverBleFailure =
  | 'format'
  /** The user said the two codes differ, so nothing was sent. */
  | 'sas'
  /** The request names another identity than the one the channel proved. */
  | 'identity'

export type RecoverBleResult = { ok: true } | { ok: false; reason: RecoverBleFailure }

export interface RecoverBleOptions {
  /** Resolves with the user's decision once they have compared the code on both screens. */
  confirmSas: () => Promise<boolean>
  /** The Worker verifies the request and returns an opaque encrypted reply. */
  prepareReply: (requestBytes: Uint8Array) => Promise<Uint8Array>
}

/**
 * Runs one restore on an established channel and closes it afterwards. Never sends anything before
 * the user has confirmed the code.
 */
export async function serveRecoverOverChannel(
  channel: SecureChannel,
  options: RecoverBleOptions
): Promise<RecoverBleResult> {
  try {
    if (!(await options.confirmSas())) return { ok: false, reason: 'sas' }
    const requestBytes = await channel.receive()
    const request = parseRecoverRequest(requestBytes)
    if (!request) return { ok: false, reason: 'format' }
    if (bytesToBase64(request.identityPublicKey) !== bytesToBase64(channel.peerIdentity)) {
      return { ok: false, reason: 'identity' }
    }
    await channel.send(await options.prepareReply(requestBytes))
    return { ok: true }
  } finally {
    channel.close()
  }
}
