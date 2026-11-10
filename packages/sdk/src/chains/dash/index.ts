export {
  detectDashProvider,
  getDashProvider,
  isDashChainId,
  isDashProviderError,
  isUnsupportedDashSignMessageError,
  parseDashDuffs
} from './provider'
export { DASH_CHAIN_IDS, DASH_UNSUPPORTED_SIGN_MESSAGE } from './types'
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
} from './types'
