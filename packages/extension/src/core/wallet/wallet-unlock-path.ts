export type ActiveWalletSetMode =
  | 'inactive'
  | 'native-v2-hardware-only'
  | 'native-v2-private-key-only'
  | 'native-v2-mixed'
  | 'retained-v1-backed'

export type WalletUnlockPath =
  | Readonly<{ kind: 'native-v2'; restoreZcashRuntime: boolean }>
  | Readonly<{ kind: 'retained-v1' }>

export function resolveWalletUnlockPath(
  mode: ActiveWalletSetMode,
  supportsZcash: boolean | null,
  hasRetainedWallet: boolean
): WalletUnlockPath {
  const restoreZcashRuntime = supportsZcash ?? hasRetainedWallet
  if (mode.startsWith('native-v2-') || !restoreZcashRuntime) {
    return { kind: 'native-v2', restoreZcashRuntime: supportsZcash === true }
  }
  return { kind: 'retained-v1' }
}
