export type BitcoinAddressType = 'p2pkh' | 'p2sh-p2wpkh' | 'p2wpkh' | 'p2tr'
export type BitcoinDerivationScheme = 'bip44' | 'bip49' | 'bip84' | 'bip86'

export interface BitcoinAddressTarget {
  readonly addressType: BitcoinAddressType
  readonly addressScheme:
    | 'bitcoin-p2pkh'
    | 'bitcoin-p2sh-p2wpkh'
    | 'bitcoin-p2wpkh'
    | 'bitcoin-p2tr'
  readonly derivationScheme: BitcoinDerivationScheme
  readonly purpose: 44 | 49 | 84 | 86
  readonly createByDefault: boolean
  readonly discoverOnImport: boolean
}

export interface BitcoinImportDiscoverySupport {
  readonly available: readonly BitcoinAddressTarget[]
  readonly waiting: readonly BitcoinAddressTarget[]
}

const BIP_44 = Object.freeze({
  addressType: 'p2pkh',
  addressScheme: 'bitcoin-p2pkh',
  derivationScheme: 'bip44',
  purpose: 44,
  createByDefault: false,
  discoverOnImport: true
} as const satisfies BitcoinAddressTarget)

const BIP_49 = Object.freeze({
  addressType: 'p2sh-p2wpkh',
  addressScheme: 'bitcoin-p2sh-p2wpkh',
  derivationScheme: 'bip49',
  purpose: 49,
  createByDefault: false,
  discoverOnImport: true
} as const satisfies BitcoinAddressTarget)

const BIP_84 = Object.freeze({
  addressType: 'p2wpkh',
  addressScheme: 'bitcoin-p2wpkh',
  derivationScheme: 'bip84',
  purpose: 84,
  createByDefault: true,
  discoverOnImport: true
} as const satisfies BitcoinAddressTarget)

const BIP_86 = Object.freeze({
  addressType: 'p2tr',
  addressScheme: 'bitcoin-p2tr',
  derivationScheme: 'bip86',
  purpose: 86,
  createByDefault: false,
  discoverOnImport: true
} as const satisfies BitcoinAddressTarget)

/** Versioned product policy; private-key operations remain in the Multichain WASM. */
export const BITCOIN_ADDRESS_POLICY = Object.freeze({
  version: 1 as const,
  id: 'bitcoin-mainstream-v1' as const,
  defaultCreate: BIP_84,
  importDiscovery: Object.freeze([BIP_84, BIP_44, BIP_49, BIP_86])
})

const ADDRESS_TYPES = new Set<BitcoinAddressType>(['p2pkh', 'p2sh-p2wpkh', 'p2wpkh', 'p2tr'])

export function resolveBitcoinImportDiscoverySupport(
  availableAddressTypes: readonly BitcoinAddressType[]
): BitcoinImportDiscoverySupport {
  const availableTypes = new Set<BitcoinAddressType>()
  for (const addressType of availableAddressTypes) {
    if (!ADDRESS_TYPES.has(addressType)) {
      throw new Error(`Unsupported Bitcoin address type: ${String(addressType)}`)
    }
    if (availableTypes.has(addressType)) {
      throw new Error(`Duplicate Bitcoin address type: ${addressType}`)
    }
    availableTypes.add(addressType)
  }

  return Object.freeze({
    available: Object.freeze(
      BITCOIN_ADDRESS_POLICY.importDiscovery.filter(target =>
        availableTypes.has(target.addressType)
      )
    ),
    waiting: Object.freeze(
      BITCOIN_ADDRESS_POLICY.importDiscovery.filter(
        target => !availableTypes.has(target.addressType)
      )
    )
  })
}
