import { useEffect, useState } from 'react'
import { Icon } from '@iconify/react'
import evmGroupIcon from '@/images/figma-evm-group.svg'
import { Button } from '@/popup/components/ui/button'
import { ChainIcon } from '@/popup/components/common/ChainIcon'
import { ChainSelector, type ChainSelectorOption } from '@/popup/components/common/ChainSelector'
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
import {
  ALL_EVM_NETWORKS_CHOICE,
  getAddressBookNetworkChoice,
  resolveAddressBookNetwork,
  type AddressBookNetworkChoice
} from './address-book-network'

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
  const getExactContact = useAddressBookStore(state => state.getExactContact)
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [showNetworks, setShowNetworks] = useState(false)
  const [evmChainId, setEvmChainId] = useState<string>(ALL_EVM_NETWORKS_CHOICE.chainId)
  const initialNetwork = networks.find(choice => choice.chainId === initialChainId)
  const detectedNetwork = address.trim()
    ? resolveAddressBookNetwork(address, networks)
    : initialNetwork?.family === 'evm'
      ? ALL_EVM_NETWORKS_CHOICE
      : initialNetwork
  const evmNetworks = networks.filter(
    choice =>
      choice.family === 'evm' &&
      choice.chainId !== ALL_EVM_NETWORKS_CHOICE.chainId &&
      getAddressBookNetworkChoice(choice.chainId)?.family === 'evm'
  )
  const evmNetworkOptions: readonly ChainSelectorOption[] = [
    { id: ALL_EVM_NETWORKS_CHOICE.chainId, name: ALL_EVM_NETWORKS_CHOICE.name, icon: 'evm' },
    ...evmNetworks.map(choice => ({
      id: choice.chainId,
      name: choice.name,
      icon: choice.iconChain ?? choice.chainId
    }))
  ]
  const network =
    detectedNetwork?.family === 'evm'
      ? evmChainId === ALL_EVM_NETWORKS_CHOICE.chainId
        ? ALL_EVM_NETWORKS_CHOICE
        : evmNetworks.find(choice => choice.chainId === evmChainId)
      : detectedNetwork

  useEffect(() => {
    if (detectedNetwork?.family !== 'evm') setEvmChainId(ALL_EVM_NETWORKS_CHOICE.chainId)
  }, [detectedNetwork?.family])

  useEffect(() => {
    if (!open) return
    setName('')
    setAddress('')
    setError(null)
    setShowNetworks(false)
    setEvmChainId(ALL_EVM_NETWORKS_CHOICE.chainId)
  }, [open, initialChainId])

  const save = () => {
    if (!network || !name.trim() || !address.trim()) return
    try {
      if (getExactContact(network.chainId, address)) {
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
          <label className="flex flex-col gap-2 text-sm">
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
          <label className="flex flex-col gap-2 text-sm">
            <span>Address</span>
            <textarea
              aria-label="Address"
              placeholder="Address"
              value={address}
              rows={2}
              spellCheck={false}
              onChange={event => {
                setAddress(event.target.value)
                setError(null)
              }}
              onBlur={() => {
                if (address.trim() && !network) {
                  setError('Enter a valid address for a supported network')
                }
              }}
              className="min-h-[70px] w-full resize-none rounded-xl border border-input bg-card px-3 py-3 text-sm leading-5 break-all outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
            />
          </label>
          <div className="space-y-2 text-sm">
            <span id="address-book-network-label">Network</span>
            {detectedNetwork?.family === 'evm' ? (
              <button
                type="button"
                aria-label="Ethereum & EVM networks"
                aria-haspopup="dialog"
                onClick={() => setShowNetworks(true)}
                className="wallet-interactive flex min-h-[50px] w-full items-center gap-3 rounded-xl border border-input bg-card px-3 py-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary"
              >
                <img src={evmGroupIcon} alt="" className="size-8 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block">Ethereum &amp; EVM</span>
                  <span className="mt-0.5 block truncate text-xs text-muted">
                    {network?.name ?? 'Select network'}
                  </span>
                </span>
                <Icon icon="lucide:chevron-right" width={18} height={18} />
              </button>
            ) : (
              <div
                aria-labelledby="address-book-network-label"
                className="flex min-h-[50px] items-center gap-3 rounded-xl border border-input bg-card px-3 py-2"
              >
                {network && (
                  <ChainIcon chain={network.family} showTooltip={false} className="size-8" />
                )}
                <span className={cn(!network && 'text-muted')}>{network?.name ?? '—'}</span>
              </div>
            )}
          </div>
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
        <ChainSelector
          open={showNetworks}
          onOpenChange={setShowNetworks}
          options={evmNetworkOptions}
          selectedId={evmChainId}
          onSelect={id => {
            setEvmChainId(id)
            setError(null)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
