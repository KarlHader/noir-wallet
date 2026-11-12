export { getNoirWallet, isNoirWalletInstalled } from './provider'
export {
  addEvmNetwork,
  detectEvmProvider,
  getEvmChainId,
  getEvmProvider,
  switchEvmChain
} from './chains/evm'
export { detectBitcoinProvider, getBitcoinProvider } from './chains/bitcoin'
export {
  DASH_CHAIN_IDS,
  DASH_UNSUPPORTED_SIGN_MESSAGE,
  detectDashProvider,
  getDashProvider,
  isDashChainId,
  isDashProviderError,
  isUnsupportedDashSignMessageError,
  parseDashDuffs
} from './chains/dash'
export { detectPearlProvider, getPearlProvider } from './chains/pearl'
export { detectQuantusProvider, getQuantusProvider } from './chains/quantus'
export { detectSolanaProvider, getSolanaProvider } from './chains/solana'
export { detectNearProvider, getNearProvider } from './chains/near'
export { detectStarknetProvider, getStarknetProvider } from './chains/starknet'
export type {
  Caip25CreateSessionRequest,
  Caip25ScopeRequest,
  Caip25Session,
  Caip25SessionScope,
  Caip27InvokeMethodRequest,
  MultichainProvider,
  MultichainProviderListener,
  MultichainRequestArguments
} from './chains/multichain'

export type {
  NoirWalletProvider,
  ProviderConnectInfo,
  ProviderMessage,
  ProviderRpcError
} from './types'

export type {
  DetectEvmProviderOptions,
  AddEvmNetworkParameters,
  Eip6963ProviderDetail,
  Eip6963ProviderInfo,
  EvmChainId,
  EvmProvider,
  EvmProviderListener,
  EvmRequestArguments
} from './chains/evm'

export type {
  BitcoinBalance,
  BitcoinChain,
  BitcoinChainInfo,
  BitcoinConnectResult,
  BitcoinNetwork,
  BitcoinProvider,
  BitcoinProviderListener,
  BitcoinRequestArguments,
  BitcoinSendOptions,
  BitcoinSignPsbtOptions,
  DetectBitcoinProviderOptions
} from './chains/bitcoin'

export type {
  DashBalance,
  DashChainId,
  DashChainInfo,
  DashConnectResult,
  DashDuffString,
  DashNetwork,
  DashProvider,
  DashProviderError,
  DashProviderErrorCode,
  DashProviderEvent,
  DashProviderListener,
  DashRequestArguments,
  DashSendOptions,
  DashSignPsbtOptions,
  DashUnsupportedSignMessageError,
  DetectDashProviderOptions
} from './chains/dash'

export type {
  DetectPearlProviderOptions,
  PearlBalance,
  PearlChain,
  PearlChainInfo,
  PearlConnectResult,
  PearlNetwork,
  PearlProvider,
  PearlProviderListener,
  PearlRequestArguments,
  PearlSendOptions,
  PearlSignPsbtOptions
} from './chains/pearl'

export type {
  DetectQuantusProviderOptions,
  QuantusBalance,
  QuantusChain,
  QuantusChainInfo,
  QuantusConnectResult,
  QuantusNetwork,
  QuantusProvider,
  QuantusProviderListener,
  QuantusRequestArguments
} from './chains/quantus'

export type {
  DetectSolanaProviderOptions,
  SolanaConnectResult,
  SolanaProvider,
  SolanaProviderListener,
  SolanaPublicKey,
  SolanaSignAndSendTransactionOptions,
  SolanaSignAndSendResult,
  SolanaSignTransactionOptions,
  SolanaSignedMessage,
  SolanaTransactionCommitment
} from './chains/solana'

export type {
  DetectNearProviderOptions,
  NearAction,
  NearFunctionCallAction,
  NearProvider,
  NearProviderListener,
  NearRequestSignInParams,
  NearSignInResult,
  NearSignMessageParams,
  NearSignedMessage,
  NearSignedTransactionBatch,
  NearTransactionBatchRequest,
  NearTransactionRequest,
  NearTransferAction,
  NearWalletSelectorFunctionCallAction
} from './chains/near'

export type {
  DetectStarknetProviderOptions,
  StarknetAccountDeploymentData,
  StarknetChainId,
  StarknetFeltChainId,
  StarknetProvider,
  StarknetProviderRequest,
  StarknetTypedData,
  StarknetWalletStandardChainId
} from './chains/starknet'

export {
  getZcashProvider,
  detectProvider,
  ZcashClient,
  ZcashAPI,
  publicKeyToAddress,
  verifyMessageSignature
} from './chains/zcash'

export type {
  ZcashProvider,
  RequestArguments,
  ZcashAddress,
  ZcashAccount,
  ZcashAccountBalance,
  ZcashConnectResult,
  ZcashBalanceResult,
  Balance,
  FundingSource,
  SendTransactionParams,
  FeeTier,
  MaxTransferParams,
  MaxTransferEstimate,
  TransactionReceipt,
  SignMessageOptions,
  SignMessageResult,
  SigningMode,
  LendingMcaStatus,
  LendingSigningMode,
  TransactionHistoryEntry,
  Network,
  VerifyMessageParams,
  VerifyMessageResult
} from './chains/zcash'
