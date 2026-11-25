import type { StorageV2ReadRepository, StorageV2Snapshot } from '@/ports/repositories'

export async function readActiveStorageV2Snapshot(
  repository: Pick<StorageV2ReadRepository, 'getActivePointer' | 'getSnapshot'>
): Promise<StorageV2Snapshot | null> {
  const pointer = await repository.getActivePointer()
  if (!pointer) return null
  const snapshot = await repository.getSnapshot(pointer.generationId)
  if (!snapshot) throw new Error('Active Storage V2 generation is missing')
  if (
    snapshot.manifest.status !== 'verified' ||
    snapshot.manifest.generationId !== pointer.generationId ||
    snapshot.manifest.sourceFingerprint !== pointer.sourceFingerprint
  ) {
    throw new Error('Active Storage V2 generation does not match its pointer')
  }
  return snapshot
}
