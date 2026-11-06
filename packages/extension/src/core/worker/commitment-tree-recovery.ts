export function isIncompleteCommitmentTreeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('CommitmentTree(Query(TreeIncomplete')
}

export async function runWithCommitmentTreeRecovery<T>({
  refresh,
  operation
}: {
  refresh: () => Promise<void>
  operation: () => Promise<T>
}): Promise<T> {
  await refresh()

  try {
    return await operation()
  } catch (error) {
    if (!isIncompleteCommitmentTreeError(error)) {
      throw error
    }

    await refresh()
    return operation()
  }
}
