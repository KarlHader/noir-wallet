export async function resolveAccountIdForRemoval(
  cached: { wasmAccountId: number; hdIndex: number } | undefined,
  derivationIndex: number,
  lookup?: () => Promise<number | null>
): Promise<number | null> {
  if (cached?.hdIndex === derivationIndex) return cached.wasmAccountId
  if (!lookup) return null
  try {
    return await lookup()
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('WALLET_DIRTY:')) return null
    throw error
  }
}
