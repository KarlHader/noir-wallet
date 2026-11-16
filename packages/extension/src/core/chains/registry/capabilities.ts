export type CapabilityStatus = 'available' | 'waiting' | 'unsupported'
export type ChainFamily = 'zcash' | 'evm' | 'bitcoin' | 'solana' | 'tron' | 'near'
export type ChainNetworkKind = 'mainnet' | 'testnet' | 'devnet' | 'custom'
export type TransactionModel = 'account' | 'utxo' | 'hybrid-utxo'
export type TransactionAction =
  | 'native-transfer'
  | 'token-transfer'
  | 'contract-call'
  | 'shield'
  | 'unshield'

export interface AddressCapabilities {
  readonly status: CapabilityStatus
  readonly addressSchemes: readonly string[]
  readonly derivationSchemes: readonly string[]
  readonly supportsRotation: boolean
  readonly supportsChange: boolean
}

export interface SigningCapabilities {
  readonly status: CapabilityStatus
  readonly transactionFormats: readonly string[]
  readonly messageFormats: readonly string[]
}

export interface TransactionCapabilities {
  readonly status: CapabilityStatus
  readonly model: TransactionModel
  readonly actions: readonly TransactionAction[]
}

export interface ChainCapabilities {
  readonly address: AddressCapabilities
  readonly signing: SigningCapabilities
  readonly transaction: TransactionCapabilities
}
