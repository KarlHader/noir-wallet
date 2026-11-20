import type { BluetoothDeviceLike } from '@/core/multisig/ble/link'

/** The options of `navigator.bluetooth.requestDevice` this wallet uses. */
export interface BluetoothDeviceQuery {
  acceptAllDevices?: boolean
  filters?: readonly { services?: readonly string[] }[]
  optionalServices?: readonly string[]
}

export type BluetoothSelection =
  | { status: 'selected'; id: string; name: string | null; device?: BluetoothDeviceLike }
  | { status: 'cancelled' }
  | { status: 'unavailable' }

type RequestedBluetoothDevice = BluetoothDeviceLike

// TypeScript's DOM library does not declare Web Bluetooth yet.
interface BluetoothNavigator {
  bluetooth?: {
    requestDevice(query: BluetoothDeviceQuery): Promise<RequestedBluetoothDevice>
  }
}

// Chrome rejects with NotFoundError for a closed chooser and for a missing adapter or a blocked
// API alike, so only the message tells the user's choice apart from a real failure.
function isChooserCancelled(error: unknown): boolean {
  return (
    error instanceof Error && error.name === 'NotFoundError' && error.message.includes('cancelled')
  )
}

/**
 * Opens the browser's Bluetooth chooser. Must be called from a click: everything before
 * `requestDevice` runs synchronously so the browser still sees the user's gesture.
 */
export async function chooseBluetoothDevice(
  query: BluetoothDeviceQuery
): Promise<BluetoothSelection> {
  const { bluetooth } = navigator as BluetoothNavigator
  if (!bluetooth) return { status: 'unavailable' }

  try {
    const device = await bluetooth.requestDevice(query)
    return { status: 'selected', id: device.id, name: device.name || null, device }
  } catch (error) {
    if (isChooserCancelled(error)) return { status: 'cancelled' }
    return { status: 'unavailable' }
  }
}
