import { getConfidentialFundingNetworkConfig } from '@/config/intents'
import { NEAR_CHAIN_FEATURE_FLAG } from '@/config/multichain-feature-flags'
import { readEnabledChainFeatureFlags } from '@/config/enabled-chain-feature-flags'
import { getAssetProtocolSourceMappings } from '@/core/prices/asset-market-mappings'
import type { ChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import type { EvmNetworkConfig } from '@/config/networks'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { buildAccountKey } from '@/core/wallet/account-scope'
import { resolveNearRuntimeNetworkConfig } from '@/core/chains/solana-near-runtime-config'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions,
  parseAssetDisplayMetadata,
  type AssetDefinitionInput
} from '@/core/chains/registry'
import { getCachedTokens, type SwapToken } from '@/core/services/intents-api'
import { resolveIntentsEvmAssets } from '@/core/services/intents-evm-assets'
import { loadActiveEvmPortfolioContext } from '@/infrastructure/chains/evm'
import {
  createConfiguredNearRpcClient,
  type PreparedNearIntentsDeposit
} from '@/infrastructure/chains/near'
import { EvmMultichainSigningClient } from '@/infrastructure/keyring/multichain/evm-signing-client'
import { NearMultichainSigningClient } from '@/infrastructure/keyring/multichain/near-signing-client'
import { parseChainId } from '@/core/chains/registry'
import { parseSigningCommandId } from '@/core/keyring/ports/signing'
import {
  IndexedDbStorageV2Repository,
  IndexedDbTransactionRepository
} from '@/infrastructure/persistence/repositories'
import { credentialSession } from './credential-session'
import { accountContextTransition } from './account-context-transition'
import { ConfidentialFundingApi } from './confidential-funding-api'
import {
  CONFIDENTIAL_FUNDING_MONITOR_ALARM,
  ConfidentialFundingCoordinator,
  type ConfidentialFundingCoordinatorOptions
} from './confidential-funding-coordinator'
import { ConfidentialFundingSigner } from './confidential-funding-signer'
import type { ConfidentialSigningIdentity } from './confidential-funding-signer'
import {
  NearConfidentialDepositAdapter,
  type NearConfidentialAccount,
  type NearConfidentialDepositSigning
} from './confidential-funding-adapters'
import {
  NEAR_CONFIDENTIAL_CHAIN_ASSET_ID,
  NEAR_CONFIDENTIAL_PROTOCOL_ASSET_ID
} from './confidential-near-quote'
import { loadActiveNearTransferContext } from './near-transfer'
import { ChromeConfidentialFundingStore } from './confidential-funding-store'

function createNearShieldDeposit(
  storage: IndexedDbStorageV2Repository,
  rpcUrl: string
): NonNullable<ConfidentialFundingCoordinatorOptions['nearDeposit']> {
  const rpc = createConfiguredNearRpcClient({ chainId: 'near:mainnet', rpcUrl })
  const signer = new NearMultichainSigningClient({ credentials: credentialSession })
  const resolveAccount = async (
    identity: ConfidentialSigningIdentity
  ): Promise<NearConfidentialAccount> => {
    const context = await loadActiveNearTransferContext(storage, 'near:mainnet')
    if (
      !context ||
      context.chainAccount.identity.kind !== 'account-identifier' ||
      context.keyDomainSource.kind !== 'software' ||
      context.chainAccount.scope.keyDomainId !== identity.context.chainAccount.scope.keyDomainId ||
      context.chainAccount.scope.accountId !== identity.context.chainAccount.scope.accountId
    ) {
      throw new Error('NEAR Shield deposit requires the active NEAR account')
    }
    let peaAccountId: string | null = null
    try {
      peaAccountId = (
        await signer.deriveNearPea(context.chainAccount.scope.keyDomainId, context.accountIndex)
      ).address
    } catch {
      peaAccountId = null
    }
    return {
      accountIndex: context.accountIndex,
      mainAccountId: context.chainAccount.identity.value,
      publicKey: context.publicKey,
      peaAccountId
    }
  }
  const signing: NearConfidentialDepositSigning = {
    async prepare(input: {
      readonly identity: ConfidentialSigningIdentity
      readonly kind: 'near-transaction' | 'pea-near-transaction'
      readonly prepared: PreparedNearIntentsDeposit
    }) {
      return accountContextTransition.runActiveOperation(async () => {
        const keyDomainId = input.identity.context.chainAccount.scope.keyDomainId
        const prepared = await signer.prepare(keyDomainId, {
          kind: input.kind,
          chainId: parseChainId(input.prepared.chainId).id,
          accountIndex: input.prepared.accountIndex,
          transaction: {
            chainId: input.prepared.transaction.chainId,
            accountIndex: input.prepared.transaction.accountIndex,
            signerId: input.prepared.transaction.signerId,
            receiverId: input.prepared.transaction.receiverId,
            nonce: input.prepared.transaction.nonce,
            blockHash: input.prepared.transaction.blockHash,
            actions: input.prepared.transaction.actions
          }
        })
        if (
          prepared.execution.kind !== 'internal' ||
          prepared.operation !== 'transaction' ||
          prepared.expiresAt <= Date.now()
        ) {
          await signer.cancel(keyDomainId, prepared.commandId).catch(() => undefined)
          throw new Error('NEAR Shield signing request cannot be approved')
        }
        return {
          commandId: prepared.commandId,
          payloadFingerprint: prepared.payloadFingerprint.digestHex,
          expiresAt: prepared.expiresAt
        }
      })
    },
    async confirm(input: {
      readonly identity: ConfidentialSigningIdentity
      readonly commandId: string
      readonly prepared: PreparedNearIntentsDeposit
    }) {
      return accountContextTransition.runActiveOperation(async () => {
        const signed = await signer.confirm(
          input.identity.context.chainAccount.scope.keyDomainId,
          parseSigningCommandId(input.commandId)
        )
        if (
          signed.kind !== 'signed-payload' ||
          signed.payload.encoding !== 'base64' ||
          signed.transactionId === undefined
        ) {
          throw new Error('Signed NEAR Shield deposit failed integrity validation')
        }
        return {
          rawTransaction: signed.payload.value,
          transactionHash: signed.transactionId
        }
      })
    },
    cancel(input: { readonly identity: ConfidentialSigningIdentity; readonly commandId: string }) {
      return accountContextTransition.runActiveOperation(() =>
        signer.cancel(
          input.identity.context.chainAccount.scope.keyDomainId,
          parseSigningCommandId(input.commandId)
        )
      )
    }
  }
  return {
    resolveAccount,
    adapter: new NearConfidentialDepositAdapter({ resolve: resolveAccount }, signing, rpc),
    broadcastSignedTransaction: rawTransaction => rpc.broadcastSignedTransaction(rawTransaction),
    getTransactionStatus: (transactionHash, signerId) =>
      rpc.getTransactionStatus(transactionHash, signerId)
  }
}

export function createBackgroundConfidentialFundingCoordinator(
  evmNetworks: readonly EvmNetworkConfig[],
  customEvmNetworks: readonly EvmNetworkConfig[],
  userEvmAssets: readonly AssetDefinitionInput[],
  protocolAssets: readonly AssetDefinitionInput[],
  protocolTokens: readonly SwapToken[],
  endpointSettings: ChainEndpointSettings,
  refreshPortfolio: NonNullable<ConfidentialFundingCoordinatorOptions['refreshPortfolio']>,
  store: ChromeConfidentialFundingStore = new ChromeConfidentialFundingStore(),
  getNativeZecActiveAccount?: ConfidentialFundingCoordinatorOptions['getNativeZecActiveAccount']
): ConfidentialFundingCoordinator | null {
  const config = getConfidentialFundingNetworkConfig(DEFAULT_NETWORK)
  if (!config) return null
  const chains = createInitialProductChainRegistry(DEFAULT_NETWORK, customEvmNetworks)
  const existingDefinitions = [
    ...getBundledInitialProductAssetDefinitions(DEFAULT_NETWORK, customEvmNetworks),
    ...userEvmAssets,
    ...protocolAssets
  ]
  const definitionId = (asset: AssetDefinitionInput): string =>
    `${asset.chainId}/${asset.namespace}:${asset.namespace === 'erc20' ? asset.reference.toLowerCase() : asset.reference}`
  const existingAssets = createAssetRegistry(chains, existingDefinitions)
  const confidentialEvmAssets = resolveIntentsEvmAssets(protocolTokens, evmNetworks)
  const confidentialEvmDefinitions = confidentialEvmAssets
    .filter(asset => {
      const existing = existingAssets.inspect(asset.assetId)
      // Auto-registered catalog assets remain unverified in the wallet registry.
      // A matching current protocol definition may supply this runtime's trust.
      return (
        !existing ||
        (existing.verification === 'unverified' && existing.metadata.decimals === asset.decimals)
      )
    })
    .flatMap(asset => {
      try {
        const metadata = parseAssetDisplayMetadata({
          name: asset.symbol,
          symbol: asset.symbol,
          decimals: asset.decimals,
          ...(asset.iconUrl ? { iconUrl: asset.iconUrl } : {})
        })
        return [
          Object.freeze({
            chainId: asset.chainId,
            namespace: 'erc20',
            reference: asset.contractAddress,
            kind: 'token' as const,
            metadata,
            source: 'protocol' as const,
            verification: 'trusted' as const
          })
        ]
      } catch {
        return []
      }
    })
  const protocolDefinitionIds = new Set(confidentialEvmDefinitions.map(definitionId))
  const assets = createAssetRegistry(chains, [
    ...existingDefinitions.filter(asset => !protocolDefinitionIds.has(definitionId(asset))),
    ...confidentialEvmDefinitions
  ])
  const storage = new IndexedDbStorageV2Repository()
  const signerClient = new EvmMultichainSigningClient({ credentials: credentialSession })
  const near = resolveNearRuntimeNetworkConfig(DEFAULT_NETWORK, endpointSettings)
  const mappings = new Map(
    [
      ...getAssetProtocolSourceMappings(DEFAULT_NETWORK, assets),
      ...confidentialEvmAssets.map(asset => ({
        assetId: asset.assetId,
        protocolAssetId: asset.protocolAssetId
      }))
    ].map(mapping => [mapping.assetId, Object.freeze(mapping)])
  )
  const nearShieldEnabled =
    DEFAULT_NETWORK === 'mainnet' &&
    readEnabledChainFeatureFlags().includes(NEAR_CHAIN_FEATURE_FLAG) &&
    near.chainId === 'near:mainnet' &&
    assets.get(NEAR_CONFIDENTIAL_CHAIN_ASSET_ID) !== undefined
  if (
    nearShieldEnabled &&
    ![...mappings.values()].some(
      mapping => mapping.protocolAssetId === NEAR_CONFIDENTIAL_PROTOCOL_ASSET_ID
    )
  ) {
    mappings.set(
      NEAR_CONFIDENTIAL_CHAIN_ASSET_ID,
      Object.freeze({
        assetId: NEAR_CONFIDENTIAL_CHAIN_ASSET_ID,
        protocolAssetId: NEAR_CONFIDENTIAL_PROTOCOL_ASSET_ID
      })
    )
  }
  return new ConfidentialFundingCoordinator({
    network: DEFAULT_NETWORK,
    api: new ConfidentialFundingApi(config, near.rpcUrl, __RHEA_SWAP_ACCESS_TOKEN__),
    store,
    signer: new ConfidentialFundingSigner(
      signerClient,
      chainId => loadActiveEvmPortfolioContext(storage, chainId),
      operation => accountContextTransition.runActiveOperation(operation)
    ),
    repository: new IndexedDbTransactionRepository(),
    assets,
    evmNetworks,
    protocolTokens,
    getProtocolTokens: () => {
      const cached = getCachedTokens()
      return cached.length > 0 ? cached : protocolTokens
    },
    getNativeZecActiveAccount,
    assetMappings: Object.freeze([...mappings.values()]),
    ...(nearShieldEnabled ? { nearDeposit: createNearShieldDeposit(storage, near.rpcUrl) } : {}),
    scheduleMonitoring: async (delayInMinutes = 0.1) => {
      const alarm = await chrome.alarms.get(CONFIDENTIAL_FUNDING_MONITOR_ALARM)
      if (
        alarm &&
        alarm.scheduledTime > Date.now() &&
        alarm.scheduledTime <= Date.now() + delayInMinutes * 60_000
      )
        return
      await chrome.alarms.create(CONFIDENTIAL_FUNDING_MONITOR_ALARM, { delayInMinutes })
    },
    onActivityChanged: async scope => {
      await chrome.runtime.sendMessage({
        type: 'TRANSACTION_UPDATED',
        accountKey: buildAccountKey(scope.network, scope.keyDomainId, scope.accountId)
      })
    },
    refreshPortfolio
  })
}

export {
  CONFIDENTIAL_FUNDING_MONITOR_ALARM,
  type PrepareConfidentialFundingInput
} from './confidential-funding-coordinator'
