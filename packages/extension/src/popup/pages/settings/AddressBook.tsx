import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { formatSortAddress } from '@/lib/format'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { InlineError } from '@/popup/components/common/InlineError'
import { ChainIcon } from '@/popup/components/common/ChainIcon'
import { Button } from '@/popup/components/ui/button'
import { ListSkeleton } from '@/popup/components/ui/skeleton'
import { Input } from '@/popup/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/popup/components/ui/dialog'
import { initializeAddressBook, useAddressBookStore } from '@/store/address-book-store'
import type { AddressBookContact } from '@/core/address-book/address-book'

export function AddressBook() {
  const contacts = useAddressBookStore(state => state.contacts)
  const renameContact = useAddressBookStore(state => state.renameContact)
  const removeContact = useAddressBookStore(state => state.removeContact)
  const [editing, setEditing] = useState<AddressBookContact | null>(null)
  const [deleting, setDeleting] = useState<AddressBookContact | null>(null)
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

  const groups = useMemo(() => {
    const grouped = new Map<string, AddressBookContact[]>()
    for (const contact of [...contacts].sort(
      (left, right) =>
        left.networkName.localeCompare(right.networkName) || left.name.localeCompare(right.name)
    )) {
      const group = grouped.get(contact.chainId) ?? []
      group.push(contact)
      grouped.set(contact.chainId, group)
    }
    return [...grouped.values()]
  }, [contacts])

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
      <PageHeader title="Address Book" showBack />
      <div className="page-content !px-4">
        {loadError && groups.length > 0 && (
          <InlineError
            message="Could not refresh saved recipients"
            onRetry={() => void loadContacts()}
            retrying={loading}
            className="mb-4"
          />
        )}
        {groups.length === 0 && loading ? (
          <ListSkeleton rows={4} label="Loading saved recipients" />
        ) : groups.length === 0 && loadError ? (
          <InlineError
            message="Could not load saved recipients"
            onRetry={() => void loadContacts()}
            className="mt-4"
          />
        ) : groups.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-5 pb-12 text-center">
            <div className="flex size-14 items-center justify-center rounded-full bg-card text-muted">
              <Icon icon="lucide:book-user" width={25} height={25} />
            </div>
            <h2 className="mt-4 text-base font-semibold">No saved recipients</h2>
            <p className="mt-2 max-w-[270px] text-sm leading-5 text-muted">
              After a transfer is submitted, you can save its recipient for future sends on that
              network.
            </p>
          </div>
        ) : (
          <div className="space-y-5 pb-4">
            {groups.map(group => {
              const first = group[0]
              const iconAlias = resolveChainIconAlias(first.chainFamily, first.networkName)
              return (
                <section key={first.chainId}>
                  <div className="mb-2 flex items-center gap-2 px-1">
                    <ChainIcon chain={iconAlias} className="size-5 rounded-full" />
                    <h2 className="text-xs font-medium uppercase tracking-wider text-muted">
                      {first.networkName}
                    </h2>
                  </div>
                  <div className="overflow-hidden rounded-xl border border-border/60 bg-card/55">
                    {group.map((contact, index) => (
                      <div
                        key={contact.id}
                        className={index === 0 ? '' : 'border-t border-border/60'}
                      >
                        <div className="flex items-center gap-3 px-3 py-3">
                          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/12 text-sm font-semibold text-primary">
                            {contact.name.slice(0, 1).toUpperCase()}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{contact.name}</p>
                            <p
                              className="mt-0.5 truncate font-mono text-xs text-muted"
                              title={contact.address}
                            >
                              {formatSortAddress(contact.address)}
                            </p>
                          </div>
                          <button
                            type="button"
                            aria-label={`Rename ${contact.name}`}
                            onClick={() => beginEdit(contact)}
                            className="flex size-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-white/[0.06] hover:text-white"
                          >
                            <Icon icon="lucide:pencil" width={15} height={15} />
                          </button>
                          <button
                            type="button"
                            aria-label={`Delete ${contact.name}`}
                            onClick={() => setDeleting(contact)}
                            className="flex size-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-white/[0.06] hover:text-white"
                          >
                            <Icon icon="lucide:trash-2" width={15} height={15} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )
            })}
          </div>
        )}
      </div>

      <Dialog open={editing !== null} onOpenChange={open => !open && setEditing(null)}>
        <DialogContent position="bottom" className="gap-0 p-0">
          <DialogHeader className="px-5 pb-4 pt-5">
            <DialogTitle className="text-center">Rename Contact</DialogTitle>
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
