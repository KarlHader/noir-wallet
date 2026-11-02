export const EVM_WALLET_PREFERENCE_STORAGE_KEY = 'evm_wallet_preference'

export type EvmWalletPreference = 'ask' | 'noir' | 'other'

export function readEvmWalletPreference(value: unknown): EvmWalletPreference {
  return value === 'noir' || value === 'other' ? value : 'ask'
}

export interface EvmWalletOption {
  readonly id: string
  readonly name: string
  readonly icon?: string
}

export interface EvmWalletChoiceRequest {
  readonly requestId: string
  readonly origin: string
  readonly wallets: readonly EvmWalletOption[]
}

export function parseEvmWalletOptions(value: unknown): readonly EvmWalletOption[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new Error('Available wallets are invalid.')
  }
  const ids = new Set<string>()
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Available wallets are invalid.')
    }
    const { id, name, icon } = item as Record<string, unknown>
    if (
      typeof id !== 'string' ||
      !/^(noir|wallet-[a-zA-Z0-9-]{1,64})$/.test(id) ||
      ids.has(id) ||
      typeof name !== 'string' ||
      name.trim().length === 0 ||
      name.length > 80
    ) {
      throw new Error('Available wallets are invalid.')
    }
    ids.add(id)
    const normalizedIcon = typeof icon === 'string' ? icon.trim() : undefined
    const safeIcon =
      normalizedIcon &&
      normalizedIcon.length <= 131_072 &&
      /^data:image\/(png|jpeg|webp|svg\+xml)[;,]/i.test(normalizedIcon)
        ? normalizedIcon
        : undefined
    return { id, name: name.trim(), ...(safeIcon ? { icon: safeIcon } : {}) }
  })
}
