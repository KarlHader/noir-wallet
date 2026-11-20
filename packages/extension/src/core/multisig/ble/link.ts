/** GATT contract with the phone (Peripheral). The phone's `KGBleProfile` uses the same UUIDs. */
export const BLE_SERVICE_UUID = '7d2e0001-4c8b-4a5e-9b1e-6e6f69720001'
export const BLE_RX_UUID = '7d2e0002-4c8b-4a5e-9b1e-6e6f69720001'
export const BLE_TX_UUID = '7d2e0003-4c8b-4a5e-9b1e-6e6f69720001'

/** What the chooser must filter on. The phone advertises only the service, never a device name. */
export const BLE_DEVICE_QUERY = Object.freeze({
  filters: Object.freeze([Object.freeze({ services: Object.freeze([BLE_SERVICE_UUID]) })])
})

/** A byte pipe that carries exactly one frame per write and one frame per notification. */
export interface FrameLink {
  send(frame: Uint8Array): Promise<void>
  close(): void
}

export interface FrameLinkHandlers {
  readonly signal?: AbortSignal
  onFrame(frame: Uint8Array): void
  /** The link ended: the phone went away, Bluetooth was switched off, or `close` was called. */
  onClosed(): void
}

// TypeScript's DOM library does not declare Web Bluetooth.
interface GattCharacteristic extends EventTarget {
  value?: DataView
  startNotifications(): Promise<unknown>
  writeValueWithResponse?(value: BufferSource): Promise<void>
  writeValue(value: BufferSource): Promise<void>
}
interface GattService {
  getCharacteristic(uuid: string): Promise<GattCharacteristic>
}
interface GattServer {
  connected: boolean
  connect(): Promise<GattServer>
  disconnect(): void
  getPrimaryService(uuid: string): Promise<GattService>
}
export interface BluetoothDeviceLike extends EventTarget {
  id: string
  name?: string
  gatt?: GattServer
}

/** Connects to the phone's GATT service and subscribes to its notifications. */
export async function openWebBluetoothLink(
  device: BluetoothDeviceLike,
  handlers: FrameLinkHandlers
): Promise<FrameLink> {
  const gatt = device.gatt
  if (!gatt) throw new Error('bluetooth_unavailable')
  let closed = false
  let tx: GattCharacteristic | null = null
  const onNotification = (event: Event) => {
    const value = (event.target as GattCharacteristic | null)?.value
    if (!value || closed) return
    handlers.onFrame(
      new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
    )
  }
  const cleanup = () => {
    handlers.signal?.removeEventListener('abort', onAbort)
    device.removeEventListener('gattserverdisconnected', finish)
    tx?.removeEventListener('characteristicvaluechanged', onNotification)
  }
  const finish = () => {
    if (closed) return
    closed = true
    cleanup()
    handlers.onClosed()
  }
  const onAbort = () => {
    finish()
    if (gatt.connected) gatt.disconnect()
  }
  handlers.signal?.addEventListener('abort', onAbort, { once: true })
  device.addEventListener('gattserverdisconnected', finish)
  try {
    if (handlers.signal?.aborted) throw new Error('bluetooth_closed')
    const server = await gatt.connect()
    if (closed) throw new Error('bluetooth_closed')
    const service = await server.getPrimaryService(BLE_SERVICE_UUID)
    if (closed) throw new Error('bluetooth_closed')
    const rx = await service.getCharacteristic(BLE_RX_UUID)
    if (closed) throw new Error('bluetooth_closed')
    tx = await service.getCharacteristic(BLE_TX_UUID)
    if (closed) throw new Error('bluetooth_closed')
    tx.addEventListener('characteristicvaluechanged', onNotification)
    await tx.startNotifications()
    if (closed) throw new Error('bluetooth_closed')
    return {
      async send(frame) {
        if (closed) throw new Error('bluetooth_closed')
        // Acknowledged writes keep frames in order and show a lost link at once.
        if (rx.writeValueWithResponse) await rx.writeValueWithResponse(frame as BufferSource)
        else await rx.writeValue(frame as BufferSource)
      },
      close() {
        finish()
        if (gatt.connected) gatt.disconnect()
      }
    }
  } catch (error) {
    finish()
    if (gatt.connected) gatt.disconnect()
    throw error
  }
}
