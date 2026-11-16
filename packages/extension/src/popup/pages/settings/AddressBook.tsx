import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { InlineError } from '@/popup/components/common/InlineError'
import { Button } from '@/popup/components/ui/button'
import { ListSkeleton } from '@/popup/components/ui/skeleton'
import { Input } from '@/popup/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/popup/components/ui/dropdown-menu'
import {
  CopyFeedbackIcon,
  CopyToast,
  useCopyToClipboard
} from '@/popup/components/common/CopyToast'
import { accountNetworksClient } from '@/popup/services/account-networks-client'
import { AddAddressDialog } from '@/popup/components/address-book/AddAddressDialog'
import {
  getAddressBookContactIconChain,
  getAddressBookNetworkChoices,
  type AddressBookNetworkChoice
} from '@/popup/components/address-book/address-book-network'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/popup/components/ui/dialog'
import { initializeAddressBook, useAddressBookStore } from '@/store/address-book-store'
import type { AddressBookContact } from '@/core/address-book/address-book'
import { ChainIcon } from '@/popup/components/common/ChainIcon'

export function AddressBook() {
  const contacts = useAddressBookStore(state => state.contacts)
  const renameContact = useAddressBookStore(state => state.renameContact)
  const removeContact = useAddressBookStore(state => state.removeContact)
  const { copyToClipboard, showToast, isCopied } = useCopyToClipboard()
  const [editing, setEditing] = useState<AddressBookContact | null>(null)
  const [deleting, setDeleting] = useState<AddressBookContact | null>(null)
  const [adding, setAdding] = useState(false)
  const [availableNetworks, setAvailableNetworks] = useState<readonly AddressBookNetworkChoice[]>(
    []
  )
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const loadRevision = useRef(0)

  const loadContacts = useCallback(async () => {
    const revision = ++loadRevision.current
    setLoading(true)
    setLoadError(false)
    try {
      await initializeAddressBook()
    } catch {
      if (revision === loadRevision.current) setLoadError(true)
    } finally {
      if (revision === loadRevision.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadContacts()
    return () => {
      loadRevision.current += 1
    }
  }, [loadContacts])

  useEffect(() => {
    let cancelled = false
    void accountNetworksClient
      .getCatalog()
      .then(catalog => {
        if (cancelled) return
        setAvailableNetworks(
          getAddressBookNetworkChoices(catalog).filter(choice => choice.family !== 'bitcoin')
        )
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const sortedContacts = useMemo(
    () =>
      [...contacts].sort(
        (left, right) =>
          left.name.localeCompare(right.name) || left.networkName.localeCompare(right.networkName)
      ),
    [contacts]
  )

  const beginEdit = (contact: AddressBookContact) => {
    setEditing(contact)
    setName(contact.name)
  }

  const saveEdit = () => {
    if (!editing || !name.trim()) return
    renameContact(editing.id, name)
    setEditing(null)
  }

  return (
    <div className="page-container">
      <CopyToast show={showToast} />
      <PageHeader title="Address Book" showBack />
      <div className="page-content min-h-0 !px-0 !pt-3">
        {loadError && sortedContacts.length > 0 && (
          <InlineError
            message="Could not refresh saved recipients"
            onRetry={() => void loadContacts()}
            retrying={loading}
            className="mb-4"
          />
        )}
        {sortedContacts.length === 0 && loading ? (
          <ListSkeleton rows={4} label="Loading saved recipients" />
        ) : sortedContacts.length === 0 && loadError ? (
          <InlineError
            message="Could not load saved recipients"
            onRetry={() => void loadContacts()}
            className="mt-4"
          />
        ) : sortedContacts.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-5 pb-12 text-center">
            <div className="flex size-14 items-center justify-center rounded-full bg-card text-muted">
              <Icon icon="lucide:book-user" width={25} height={25} />
            </div>
            <h2 className="mt-4 text-base font-semibold">No saved recipients</h2>
          </div>
        ) : (
          <div className="pb-4">
            {sortedContacts.map(contact => (
              <div
                key={contact.id}
                className="flex h-[85px] items-start gap-3 px-4 pt-[15px] hover:bg-wallet-surface"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="min-w-0 flex-1 truncate text-sm font-normal leading-[18px]">
                      {contact.name}
                    </p>
                    <ChainIcon
                      chain={getAddressBookContactIconChain(contact)}
                      width={20}
                      height={20}
                      alt={`${contact.networkName} network`}
                      className="size-5 shrink-0"
                    />
                  </div>
                  <p
                    className="mt-[9px] truncate text-sm leading-[18px] text-muted"
                    title={contact.address}
                  >
                    {contact.address}
                  </p>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={`Actions for ${contact.name}`}
                      className="flex size-6 shrink-0 items-center justify-center text-wallet-secondary hover:text-foreground"
                    >
                      <Icon icon="lucide:ellipsis" width={18} height={18} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    className="w-[182px] rounded-md border-0 bg-wallet-selected p-1 shadow-xl"
                  >
                    <DropdownMenuItem
                      onSelect={event => event.preventDefault()}
                      onClick={() => void copyToClipboard(contact.address, `contact-${contact.id}`)}
                    >
                      <CopyFeedbackIcon
                        copied={isCopied(`contact-${contact.id}`)}
                        className="mr-2 size-4"
                      />
                      {isCopied(`contact-${contact.id}`) ? 'Copied' : 'Copy address'}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => beginEdit(contact)}>
                      <Icon icon="lucide:pencil" className="mr-2 size-4" />
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-danger focus:text-danger"
                      onClick={() => setDeleting(contact)}
                    >
                      <Icon icon="lucide:trash-2" className="mr-2 size-4" />
                      Delete address
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="page-footer bg-background !px-4">
        <Button
          variant="secondary"
          size="wallet"
          className="w-full rounded-[10px] border border-white/10 bg-wallet-surface font-medium text-foreground hover:bg-wallet-selected"
          onClick={() => setAdding(true)}
        >
          Add address
        </Button>
      </div>

      <AddAddressDialog
        open={adding}
        onOpenChange={setAdding}
        networks={availableNetworks}
        fullHeight
      />

      <Dialog open={editing !== null} onOpenChange={open => !open && setEditing(null)}>
        <DialogContent position="bottom" className="gap-0 p-0">
          <DialogHeader className="px-5 pb-4 pt-5">
            <DialogTitle className="text-center">Rename contact</DialogTitle>
            <DialogDescription className="sr-only">
              Change the local contact name.
            </DialogDescription>
          </DialogHeader>
          <div className="px-5">
            <Input
              aria-label="Contact name"
              value={name}
              onChange={event => setName(event.target.value)}
              maxLength={64}
              autoFocus
              className="h-[45px] rounded-xl bg-card"
              onKeyDown={event => event.key === 'Enter' && saveEdit()}
            />
          </div>
          <div className="flex gap-3 p-5">
            <Button variant="outline" className="h-[45px] flex-1" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button className="h-[45px] flex-1" disabled={!name.trim()} onClick={saveEdit}>
              Save
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={deleting !== null} onOpenChange={open => !open && setDeleting(null)}>
        <DialogContent position="bottom" className="gap-0 p-0">
          <DialogHeader className="px-5 pb-2 pt-5">
            <DialogTitle className="text-center">Delete Contact?</DialogTitle>
            <DialogDescription className="pt-2 text-center text-sm leading-5 text-muted">
              {deleting ? `${deleting.name} will be removed from your local Address Book.` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-3 p-5">
            <Button variant="outline" className="h-[45px] flex-1" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="h-[45px] flex-1"
              onClick={() => {
                if (deleting) removeContact(deleting.id)
                setDeleting(null)
              }}
            >
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
