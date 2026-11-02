import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { createChromeStorageAdapter } from '@/lib/chrome-storage-adapter'
import {
  ADDRESS_BOOK_MAX_CONTACTS,
  createAddressBookContact,
  migrateLegacyContacts,
  normalizeAddressBookAddress,
  parseAddressBookContacts,
  readLegacyContactsStorage,
  type AddressBookContact,
  type CreateAddressBookContactInput
} from '@/core/address-book/address-book'

export const ADDRESS_BOOK_STORAGE_KEY = 'address_book_v2'
export const LEGACY_CONTACTS_STORAGE_KEY = 'wallet_contacts'
let hydrationFailure: unknown = null

interface LegacyMigrationState {
  readonly completedAt: number
  readonly importedCount: number
  readonly skippedCount: number
}

interface AddressBookStore {
  readonly contacts: readonly AddressBookContact[]
  readonly legacyMigration: LegacyMigrationState | null
  addContact: (input: CreateAddressBookContactInput) => AddressBookContact
  renameContact: (id: string, name: string) => void
  removeContact: (id: string) => void
  getContact: (chainId: string, address: string) => AddressBookContact | undefined
  getContactsForChain: (chainId: string) => readonly AddressBookContact[]
  importLegacyContacts: (
    contacts: readonly AddressBookContact[],
    skippedCount: number,
    completedAt?: number
  ) => void
}

function mergeContact(
  contacts: readonly AddressBookContact[],
  contact: AddressBookContact
): readonly AddressBookContact[] {
  const existingIndex = contacts.findIndex(entry => entry.id === contact.id)
  if (existingIndex < 0) {
    if (contacts.length >= ADDRESS_BOOK_MAX_CONTACTS) {
      throw new Error(`Address Book supports up to ${ADDRESS_BOOK_MAX_CONTACTS} contacts`)
    }
    return [...contacts, contact]
  }
  return contacts.map((entry, index) => (index === existingIndex ? contact : entry))
}

function parseLegacyMigration(value: unknown): LegacyMigrationState | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) return null
  const migration = value as Record<string, unknown>
  if (
    !Number.isSafeInteger(migration.completedAt) ||
    (migration.completedAt as number) < 0 ||
    !Number.isSafeInteger(migration.importedCount) ||
    (migration.importedCount as number) < 0 ||
    !Number.isSafeInteger(migration.skippedCount) ||
    (migration.skippedCount as number) < 0
  ) {
    return null
  }
  return {
    completedAt: migration.completedAt as number,
    importedCount: migration.importedCount as number,
    skippedCount: migration.skippedCount as number
  }
}

export const useAddressBookStore = create<AddressBookStore>()(
  persist(
    (set, get) => ({
      contacts: [],
      legacyMigration: null,

      addContact: input => {
        const current = get().getContact(input.chainId, input.address)
        const contact = createAddressBookContact({
          ...input,
          ...(current
            ? {
                addedAt: current.addedAt,
                updatedAt: Date.now(),
                znsName: input.znsName ?? current.znsName
              }
            : {})
        })
        set({ contacts: mergeContact(get().contacts, contact) })
        return contact
      },

      renameContact: (id, name) => {
        const current = get().contacts.find(contact => contact.id === id)
        if (!current) return
        const renamed = createAddressBookContact({
          ...current,
          name,
          updatedAt: Date.now()
        })
        set({ contacts: mergeContact(get().contacts, renamed) })
      },

      removeContact: id => {
        set({ contacts: get().contacts.filter(contact => contact.id !== id) })
      },

      getContact: (chainId, address) => {
        const parsed = get().contacts.find(contact => contact.chainId === chainId)
        if (!parsed) return undefined
        const normalized = normalizeAddressBookAddress(parsed.chainFamily, address.trim())
        return get().contacts.find(
          contact => contact.chainId === chainId && contact.normalizedAddress === normalized
        )
      },

      getContactsForChain: chainId =>
        get()
          .contacts.filter(contact => contact.chainId === chainId)
          .sort((left, right) => left.name.localeCompare(right.name)),

      importLegacyContacts: (contacts, skippedCount, completedAt = Date.now()) => {
        if (get().legacyMigration) return
        let next = get().contacts
        let importedCount = 0
        for (const contact of contacts) {
          if (!next.some(existing => existing.id === contact.id)) importedCount += 1
          next = mergeContact(next, contact)
        }
        set({
          contacts: next,
          legacyMigration: { completedAt, importedCount, skippedCount }
        })
      }
    }),
    {
      name: ADDRESS_BOOK_STORAGE_KEY,
      version: 2,
      storage: createJSONStorage(() => createChromeStorageAdapter('local', { strictRead: true })),
      onRehydrateStorage: () => (_state, error) => {
        hydrationFailure = error ?? null
      },
      partialize: state => ({
        contacts: state.contacts,
        legacyMigration: state.legacyMigration
      }),
      merge: (persisted, current) => {
        const value =
          typeof persisted === 'object' && persisted !== null
            ? (persisted as Record<string, unknown>)
            : {}
        let contacts: readonly AddressBookContact[] = []
        try {
          contacts = parseAddressBookContacts(value.contacts ?? [])
        } catch (error) {
          console.error('[AddressBook] Ignoring invalid persisted contacts:', error)
        }
        return {
          ...current,
          contacts,
          legacyMigration: parseLegacyMigration(value.legacyMigration)
        }
      }
    }
  )
)

let initialization: Promise<void> | null = null

export function initializeAddressBook(): Promise<void> {
  if (initialization) return initialization
  initialization = (async () => {
    hydrationFailure = null
    await useAddressBookStore.persist.rehydrate()
    if (hydrationFailure) throw hydrationFailure
    if (useAddressBookStore.getState().legacyMigration) return
    const stored = await chrome.storage.local.get(LEGACY_CONTACTS_STORAGE_KEY)
    const legacyContacts = readLegacyContactsStorage(stored[LEGACY_CONTACTS_STORAGE_KEY])
    const migration = migrateLegacyContacts(legacyContacts)
    useAddressBookStore.getState().importLegacyContacts(migration.contacts, migration.skippedCount)
  })().catch(error => {
    initialization = null
    console.error('[AddressBook] V1 contact migration failed:', error)
    throw error
  })
  return initialization
}
