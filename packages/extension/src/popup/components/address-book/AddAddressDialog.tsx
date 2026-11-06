import { useEffect, useState } from 'react'
import { Button } from '@/popup/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/popup/components/ui/dialog'
import { Input } from '@/popup/components/ui/input'
import { useAddressBookStore } from '@/store/address-book-store'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { cn } from '@/lib/utils'
import type { AddressBookNetworkChoice } from './address-book-network'

export function AddAddressDialog({
  open,
  onOpenChange,
  networks,
  initialChainId = '',
  fullHeight = false
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly networks: readonly AddressBookNetworkChoice[]
  readonly initialChainId?: string
  readonly fullHeight?: boolean
}) {
  const addContact = useAddressBookStore(state => state.addContact)
  const getContact = useAddressBookStore(state => state.getContact)
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const soleNetworkChainId = networks.length === 1 ? networks[0].chainId : ''
  const [chainId, setChainId] = useState(initialChainId || soleNetworkChainId)
  const [error, setError] = useState<string | null>(null)
  const network = networks.find(choice => choice.chainId === chainId)

  useEffect(() => {
    if (!open) return
    setName('')
    setAddress('')
    setChainId(initialChainId || soleNetworkChainId)
    setError(null)
  }, [open, initialChainId, soleNetworkChainId])

  const save = () => {
    if (!network || !name.trim() || !address.trim()) return
    try {
      if (getContact(network.chainId, address)) {
        setError('This address is already saved on this network')
        return
      }
      addContact({
        chainId: network.chainId,
        chainFamily: network.family,
        network: DEFAULT_NETWORK,
        networkName: network.name,
        address: address.trim(),
        name: name.trim()
      })
      onOpenChange(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save address')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        position="bottom"
        className={cn(
          'gap-0 p-0',
          fullHeight && '!flex h-[calc(100dvh-56px)] max-h-[calc(100dvh-56px)] flex-col'
        )}
      >
        <DialogHeader className="px-5 pb-5 pt-5">
          <DialogTitle className={fullHeight ? 'text-left' : 'text-center'}>
            Add address
          </DialogTitle>
          <DialogDescription className="sr-only">Save a recipient address</DialogDescription>
        </DialogHeader>
        <div className={cn('space-y-4 px-5', fullHeight && 'min-h-0 overflow-y-auto')}>
          <label className="block space-y-2 text-sm">
            <span>Name</span>
            <Input
              aria-label="Contact name"
              placeholder="Name"
              value={name}
              maxLength={64}
              onChange={event => {
                setName(event.target.value)
                setError(null)
              }}
              className="h-[45px] rounded-xl bg-card"
            />
          </label>
          {networks.length > 1 ? (
            <label className="block space-y-2 text-sm">
              <span>Network</span>
              <select
                aria-label="Network"
                value={chainId}
                onChange={event => {
                  setChainId(event.target.value)
                  setError(null)
                }}
                className="h-[45px] w-full rounded-xl border border-input bg-card px-3 text-sm text-foreground"
              >
                <option value="">Select network</option>
                {networks.map(choice => (
                  <option key={choice.chainId} value={choice.chainId}>
                    {choice.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="block space-y-2 text-sm">
            <span>Address</span>
            <Input
              aria-label="Address"
              placeholder="Address"
              value={address}
              onChange={event => {
                setAddress(event.target.value)
                setError(null)
              }}
              className="h-[45px] rounded-xl bg-card"
            />
          </label>
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
        </div>
        <div className={cn('p-5', fullHeight && 'mt-auto')}>
          <Button
            className="w-full"
            disabled={!network || !name.trim() || !address.trim()}
            onClick={save}
          >
            Save address
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
