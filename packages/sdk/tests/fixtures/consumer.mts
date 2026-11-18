import { ZcashAPI, getNoirWallet, isNoirWalletInstalled } from '@noir-wallet/sdk'
import {
  getZcashProvider,
  detectProvider,
  publicKeyToAddress,
  verifyMessageSignature
} from '@noir-wallet/sdk/chains/zcash'
import type * as RootTypes from '@noir-wallet/sdk'
import type * as ZcashTypes from '@noir-wallet/sdk/chains/zcash'

type RootContracts = [
  RootTypes.NoirWalletProvider,
  RootTypes.ProviderConnectInfo,
  RootTypes.ProviderMessage,
  RootTypes.ProviderRpcError,
  RootTypes.ZcashProvider,
  RootTypes.RequestArguments,
  RootTypes.ZcashAddress,
  RootTypes.ZcashAccount,
  RootTypes.ZcashAccountBalance,
  RootTypes.ZcashConnectResult,
  RootTypes.ZcashBalanceResult,
  RootTypes.Balance,
  RootTypes.FundingSource,
  RootTypes.SendTransactionParams,
  RootTypes.FeeTier,
  RootTypes.MaxTransferParams,
  RootTypes.MaxTransferEstimate,
  RootTypes.TransactionReceipt,
  RootTypes.SignMessageOptions,
  RootTypes.SignMessageResult,
  RootTypes.SigningMode,
  RootTypes.LendingMcaStatus,
  RootTypes.LendingSigningMode,
  RootTypes.Network,
  RootTypes.VerifyMessageParams,
  RootTypes.VerifyMessageResult
]

type ZcashContracts = [
  ZcashTypes.ZcashProvider,
  ZcashTypes.RequestArguments,
  ZcashTypes.ZcashAddress,
  ZcashTypes.ZcashAccount,
  ZcashTypes.ZcashAccountBalance,
  ZcashTypes.ZcashConnectResult,
  ZcashTypes.ZcashBalanceResult,
  ZcashTypes.Balance,
  ZcashTypes.FundingSource,
  ZcashTypes.SendTransactionParams,
  ZcashTypes.FeeTier,
  ZcashTypes.MaxTransferParams,
  ZcashTypes.MaxTransferEstimate,
  ZcashTypes.TransactionReceipt,
  ZcashTypes.SignMessageOptions,
  ZcashTypes.SignMessageResult,
  ZcashTypes.SigningMode,
  ZcashTypes.LendingMcaStatus,
  ZcashTypes.LendingSigningMode,
  ZcashTypes.Network,
  ZcashTypes.VerifyMessageParams,
  ZcashTypes.VerifyMessageResult
]

declare const provider: ZcashTypes.ZcashProvider
const api: ZcashAPI = new ZcashAPI(provider)
api.on('accountsChanged', account => void account)
api.removeListener('accountsChanged', account => void account)
const connect: Promise<RootTypes.ZcashConnectResult> = api.connect()
const accounts: Promise<RootTypes.ZcashConnectResult | null> = api.getAccounts()
const publicAssets: Promise<RootTypes.PublicAssets> = api.getPublicAssets()
const publicSigningMode: Promise<RootTypes.PublicAccount['signingMode']> = publicAssets.then(
  ({ account }) => account.signingMode
)
const disconnect: Promise<void> = api.disconnect()
const balance: Promise<ZcashTypes.ZcashBalanceResult> = api.getBalance()
const send: Promise<string> = api.sendTransaction({
  to: 't-address',
  amount: '1'
} satisfies ZcashTypes.SendTransactionParams)
const wallet: RootTypes.NoirWalletProvider | null = getNoirWallet()
const installed: boolean = isNoirWalletInstalled()
const rawProvider: ZcashTypes.ZcashProvider | null = getZcashProvider()
const detected: Promise<ZcashTypes.ZcashProvider> = detectProvider()
const address: string = publicKeyToAddress('02' + '00'.repeat(32))
const valid: boolean = verifyMessageSignature({ message: 'x', signature: 'y' }).valid
declare const publicTypes: [RootContracts, ZcashContracts]
void [
  connect,
  accounts,
  publicAssets,
  publicSigningMode,
  disconnect,
  balance,
  send,
  wallet,
  installed,
  rawProvider,
  detected,
  address,
  valid
]
void publicTypes
