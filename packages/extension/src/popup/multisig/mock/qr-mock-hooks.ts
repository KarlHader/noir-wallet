/**
 * noir-multisig-mock: connects reference phones to the real QR driver.
 *
 * Each guardian slot gets a QrReferencePhone. "The phone scanned this code" hands the code shown
 * on the page to that phone, and "simulate scan" delivers the phone's current reply through the
 * driver exactly as a camera scan would, so the whole QR flow runs without a real iPhone.
 */
import { deviceId } from '@/core/multisig/messages'
import type { DeviceSlot } from '@/core/multisig/types'
import type { QrMockContext, QrMockHooks } from '../create-session-store'
import type { QrDriver } from '../qr-driver'
import { QrReferencePhone } from './qr-reference-phone'

// Also the marker the build-surface check looks for, so it stays a literal.
const NO_PHONE = 'noir-multisig-mock: no simulated phone for this slot'

export function createQrMockHooks(driver: QrDriver, context: QrMockContext): QrMockHooks {
  const phones = new Map<DeviceSlot, { phone: QrReferencePhone; invite: string | null }>()
  let disposed = false

  function guardianSlot(slot: DeviceSlot): 2 | 3 {
    if (slot === 1 || !context.slots.includes(slot)) throw new Error(NO_PHONE)
    return slot
  }

  function phoneFor(slot: 2 | 3, invite: string | null): QrReferencePhone {
    const existing = phones.get(slot)
    // A different invite for the same slot means the extension started pairing it over, as a user
    // would by restarting setup on the phone; the same invite again is a resend the phone handles.
    if (existing && (invite === null || existing.invite === invite)) return existing.phone
    existing?.phone.dispose()
    const phone = new QrReferencePhone(slot, context.loadVault)
    phones.set(slot, { phone, invite })
    return phone
  }

  return {
    async phoneScanned(slot, display) {
      if (disposed) return
      const guardian = guardianSlot(slot)
      const invite = display.envelopes.find(
        envelope =>
          envelope.message_type === 'PAIR_INVITE' && envelope.recipient_id === deviceId(slot)
      )
      const phone = phoneFor(guardian, invite ? JSON.stringify(invite) : null)
      // A one-envelope code is a bare object on screen, a longer one an array.
      await phone.scan(display.envelopes.length === 1 ? display.envelopes[0] : display.envelopes)
    },
    async simulateScan(slot) {
      if (disposed) return
      const phone = phones.get(guardianSlot(slot))?.phone
      if (!phone) return
      await phone.settled()
      const code = phone.nextCode()
      if (code && !disposed) await driver.deliverScan(code)
    },
    identityConfirmed(slot) {
      if (disposed) return
      phones.get(guardianSlot(slot))?.phone.confirmIdentity()
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const { phone } of phones.values()) phone.dispose()
      phones.clear()
    }
  }
}
