import { CREDENTIAL_REPOSITORY_DATABASE } from './indexed-db-credential-repository'
import { STORAGE_V2_DATABASE } from './indexed-db-storage-v2-database'

function deleteDatabase(databaseName: string, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error(`${label} deletion failed`))
    request.onblocked = () => reject(new Error(`${label} deletion is blocked`))
  })
}

export async function deleteStorageV2Persistence(): Promise<void> {
  await deleteDatabase(STORAGE_V2_DATABASE.name, 'Storage V2 database')
  await deleteDatabase(CREDENTIAL_REPOSITORY_DATABASE.name, 'Credential database')
}
