import { test } from 'node:test'
import assert from 'node:assert/strict'

test('address book retries a failed storage read before importing legacy contacts', async () => {
  const originalChrome = globalThis.chrome
  let failRead = false
  let legacyReads = 0
  const local = {
    get: async key => {
      if (key === 'address_book_v2' && failRead) throw new Error('Storage unavailable')
      if (key === 'wallet_contacts') legacyReads += 1
      return {}
    },
    set: async () => {},
    remove: async () => {}
  }
  globalThis.chrome = { storage: { local, session: local } }

  try {
    const { initializeAddressBook, useAddressBookStore } =
      await import('../../../src/store/address-book-store.ts')
    await useAddressBookStore.persist.rehydrate()
    failRead = true

    await assert.rejects(initializeAddressBook(), /Storage unavailable/)
    assert.equal(legacyReads, 0)

    failRead = false
    await initializeAddressBook()
    assert.equal(legacyReads, 1)
    assert.notEqual(useAddressBookStore.getState().legacyMigration, null)
  } finally {
    globalThis.chrome = originalChrome
  }
})
