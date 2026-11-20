import { useState } from 'react'
import { Icon } from '@iconify/react'
import { cn } from '@/lib/utils'
import { Pill } from '@/popup/components/multisig/Pill'
import { Button } from '@/popup/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/popup/components/ui/dialog'

export interface MockChooserDevice {
  slot: 2 | 3
  advertisedName: string
}

interface MockDeviceChooserProps {
  open: boolean
  devices: readonly MockChooserDevice[]
  onPick: (device: MockChooserDevice) => void
  onCancel: () => void
}

/**
 * Stand-in for the browser's Bluetooth device chooser, selected in the developer panel. The real
 * one is native UI that automation cannot drive and that needs a nearby Bluetooth device.
 */
export function MockDeviceChooser({ open, devices, onPick, onCancel }: MockDeviceChooserProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        // Escape and an outside click count as closing the chooser, like the native one.
        if (!next) onCancel()
      }}
    >
      <DialogContent position="center" showCloseButton={false} className="sm:max-w-sm">
        <ChooserBody devices={devices} onPick={onPick} onCancel={onCancel} />
      </DialogContent>
    </Dialog>
  )
}

type ChooserBodyProps = Omit<MockDeviceChooserProps, 'open'>

// Radix unmounts the content while closed, so the selection starts empty on every open.
function ChooserBody({ devices, onPick, onCancel }: ChooserBodyProps) {
  const [selectedSlot, setSelectedSlot] = useState<2 | 3 | null>(null)
  const selected = devices.find(device => device.slot === selectedSlot)

  return (
    <>
      <div className="flex">
        <Pill tone="muted">Simulated chooser</Pill>
      </div>

      <div className="space-y-2">
        <DialogTitle>Noir Wallet wants to pair</DialogTitle>
        <DialogDescription className="text-sm text-muted">
          Select a nearby device.
        </DialogDescription>
      </div>

      <div role="radiogroup" aria-label="Nearby devices" className="space-y-2">
        {devices.map(device => {
          const checked = device.slot === selected?.slot

          return (
            <button
              key={device.slot}
              type="button"
              role="radio"
              aria-checked={checked}
              onClick={() => setSelectedSlot(device.slot)}
              className={cn(
                'flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                checked
                  ? 'border-primary bg-primary/10'
                  : 'border-border bg-card/40 hover:bg-card/70'
              )}
            >
              <Icon
                icon="lucide:bluetooth"
                width={18}
                height={18}
                className="shrink-0 text-muted"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate text-sm">{device.advertisedName}</span>
              {/* The marker keeps the selected state readable without relying on color alone. */}
              <span
                aria-hidden="true"
                className={cn(
                  'flex size-4 shrink-0 items-center justify-center rounded-full border-2',
                  checked ? 'border-primary' : 'border-muted'
                )}
              >
                {checked && <span className="size-2 rounded-full bg-primary" />}
              </span>
            </button>
          )
        })}
      </div>

      <div className="flex gap-2">
        <Button variant="outline" className="h-11 flex-1" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          className="h-11 flex-1"
          disabled={!selected}
          onClick={() => selected && onPick(selected)}
        >
          Pair
        </Button>
      </div>
    </>
  )
}
