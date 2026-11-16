import { useState } from 'react'
import { formatSortAddress } from '@/lib/format'
import { Button } from '@/popup/components/ui/button'
import { Input } from '@/popup/components/ui/input'
import { openModal } from '@/popup/provider/ModalManager'
import { toast } from '@/store/toast-store'
import { useAddressBookStore } from '@/store/address-book-store'
import {
  createAddressBookContact,
  type AddressBookContact,
  type CreateAddressBookContactInput
} from '@/core/address-book/address-book'

const DISMISSED_RECIPIENTS_KEY = 'address_book_prompt_dismissals'
const MAX_SESSION_DISMISSALS = 100

export interface SaveRecipientPromptContext extends CreateAddressBookContactInput {
  readonly selfTransfer?: boolean
}

function SaveRecipientForm({
  context,
  onResolve
}: {
  readonly context: SaveRecipientPromptContext
  readonly onResolve: (contact?: AddressBookContact) => void
}) {
  const [name, setName] = useState(context.znsName ?? '')
  const [error, setError] = useState<string | null>(null)

  const save = () => {
    try {
      const contact = useAddressBookStore.getState().addContact({ ...context, name })
      onResolve(contact)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Contact could not be saved')
    }
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-border/60 bg-card/60 px-4 py-3">
        <p className="text-xs text-muted">{context.networkName}</p>
        <p className="mt-1 font-mono text-xs text-white/75" title={context.address}>
          {formatSortAddress(context.address)}
        </p>
      </div>
      <div>
        <label htmlFor="address-book-contact-name" className="mb-2 block text-sm text-muted">
          Contact name
        </label>
        <Input
          id="address-book-contact-name"
          value={name}
          onChange={event => {
            setName(event.target.value)
            setError(null)
          }}
          placeholder="Enter a name"
          maxLength={64}
          autoFocus
          className="h-[45px] rounded-xl bg-card"
          onKeyDown={event => {
            if (event.key === 'Enter' && name.trim()) save()
          }}
        />
        {error && (
          <p role="alert" className="mt-2 text-xs text-danger">
            {error}
          </p>
        )}
      </div>
      <div className="flex gap-3">
        <Button variant="outline" className="h-[45px] flex-1" onClick={() => onResolve()}>
          Cancel
        </Button>
        <Button className="h-[45px] flex-1" disabled={!name.trim()} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  )
}

async function getSessionDismissals(): Promise<Record<string, number>> {
  try {
    const stored = await chrome.storage.session.get(DISMISSED_RECIPIENTS_KEY)
    const value = stored[DISMISSED_RECIPIENTS_KEY]
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
    const entries = Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, number] =>
        entry[0].length <= 600 && Number.isSafeInteger(entry[1]) && (entry[1] as number) >= 0
    )
    return Object.fromEntries(entries.slice(-MAX_SESSION_DISMISSALS))
  } catch {
    return {}
  }
}

async function dismissForSession(contactId: string): Promise<void> {
  const dismissals = await getSessionDismissals()
  const next = Object.entries({ ...dismissals, [contactId]: Date.now() })
    .sort((left, right) => left[1] - right[1])
    .slice(-MAX_SESSION_DISMISSALS)
  await chrome.storage.session
    .set({ [DISMISSED_RECIPIENTS_KEY]: Object.fromEntries(next) })
    .catch(() => {})
}

async function openSaveRecipient(context: SaveRecipientPromptContext): Promise<void> {
  const result = await openModal<AddressBookContact | undefined>({
    title: 'Save to Address Book',
    position: 'bottom',
    showCloseButton: true,
    body: resolve => <SaveRecipientForm context={context} onResolve={resolve} />
  })
  if (result) toast.success('Contact saved', `${result.name} · ${result.networkName}`)
}

export async function offerSaveRecipient(context: SaveRecipientPromptContext): Promise<boolean> {
  if (context.selfTransfer) return false

  let candidate: AddressBookContact
  try {
    candidate = createAddressBookContact({ ...context, name: 'Recipient' })
  } catch {
    return false
  }
  if (useAddressBookStore.getState().getContact(context.chainId, context.address)) return false
  const dismissals = await getSessionDismissals()
  if (dismissals[candidate.id]) return false

  toast.action(
    'Save recipient?',
    `${formatSortAddress(context.address)} · ${context.networkName}`,
    {
      action: {
        label: 'Save',
        onClick: () => void openSaveRecipient(context)
      },
      secondaryAction: {
        label: 'Not now',
        onClick: () => void dismissForSession(candidate.id)
      }
    }
  )
  return true
}
