import { resolveKeyDomain } from '@/core/accounts/application'
import type { Account } from '@/core/accounts/domain'
import type { ChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import { findChainEndpointOverride } from '@/core/chains/chain-endpoint-settings'
import { getStarknetNetworkConfig } from '@/core/chains/starknet/network-config'
import { normalizeStarknetFelt } from '@/core/chains/starknet/identifiers'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions,
  type AssetDefinitionInput
} from '@/core/chains/registry'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import {
  ChromeSessionStarknetPendingTransferStore,
  createStarknetRpcClient,
  StarknetTransferOrchestrator,
  type StarknetTransferAccount,
  type StarknetTransferSigner
} from '@/infrastructure/chains/starknet'
import type { KeyringCommandPayload } from '@/core/keyring/ports'
import { StarknetMultichainSigningClient } from '@/infrastructure/keyring/multichain/starknet-signing-client'
import {
  IndexedDbCredentialRepository,
  IndexedDbStorageV2Repository,
  IndexedDbTransactionRepository
} from '@/infrastructure/persistence/repositories'
import { readActiveLedgerHardwareCredential } from '@/infrastructure/keyring/active-hardware-credential-inventory'
import { requestLedgerSignature } from './ledger-signing-coordinator'
import {
  normalizeLedgerStarknetCalls,
  readLedgerStarknetTransactionNonce
} from '@/lib/ledger/starknet-calls'
import {
  parseStarknetExternalPreparation,
  readAssembledStarknetTransaction,
  starknetDeployExternalRequest,
  starknetExternalAssembleRequest,
  starknetExternalImplementation,
  starknetInvokeExternalRequest
} from '@/infrastructure/chains/starknet/starknet-external-transaction'
import {
  STARKNET_ARGENT_V04_CLASS_HASH,
  STARKNET_ARGENT_V05_CLASS_HASH
} from '@/infrastructure/chains/starknet/starknet-primitives'
import {
  rememberSoftwareStarknetAccount,
  readSoftwareStarknetAccount
} from './starknet-account-projection'
import { starknetDappAccountFromContext } from './starknet-dapp-account'
import type { StorageV2ReadRepository } from '@/ports/repositories'
import type { SigningResult } from '@/core/keyring/ports'
import { assertStarknetExecutionTransaction } from '@/infrastructure/chains/starknet'
import {
  broadcastConfirmedStarknetInvoke,
  normalizeStarknetSessionPreparePayload
} from '@/infrastructure/chains/starknet/starknet-session-broadcast'
import { parseKeyDomainId, parseSigningSummary } from '@/core/keyring/domain'
import type { StarknetLedgerSigner, StarknetSessionSigner } from './starknet-dapp-handler'
import { readStarknetAccountDeployment } from '@/infrastructure/chains/starknet'

import { credentialSession } from './credential-session'
import { STARKNET_TRANSACTION_MONITOR_ALARM } from './starknet-transaction-monitor'
import {
  BackgroundStarknetTransferController,
  type ActiveStarknetTransferContext
} from './starknet-transfer-controller'

type StarknetTransferStorageRepository = Pick<
  StorageV2ReadRepository,
  'getActivePointer' | 'getSnapshot'
>

export function starknetRpcUrl(settings?: ChainEndpointSettings): string {
  const config = getStarknetNetworkConfig(DEFAULT_NETWORK)
  const override = settings ? findChainEndpointOverride(settings, config.chainId)?.rpc : undefined
  return override?.protocol === 'starknet-json-rpc' ? override.url : config.rpcUrl
}

export async function loadStarknetDappAccount(): Promise<
  ReturnType<typeof starknetDappAccountFromContext>
> {
  const repository = new IndexedDbStorageV2Repository()
  const cached = await readCachedActiveStarknetDappAccount(repository)
  if (cached) return cached
  try {
    const context = await loadActiveStarknetTransferContext(repository)
    if (!context || context.chainAccount.identity.kind !== 'account-identifier') return null
    return starknetDappAccountFromContext(
      context,
      readSoftwareStarknetAccount(
        context.chainAccount.scope.keyDomainId,
        context.chainAccount.scope.accountId
      )
    )
  } catch (error) {
    if (error instanceof Error && error.message === 'Wallet is locked') return null
    throw error
  }
}

async function readCachedActiveStarknetDappAccount(
  repository: StarknetTransferStorageRepository
): Promise<ReturnType<typeof starknetDappAccountFromContext>> {
  const config = getStarknetNetworkConfig(DEFAULT_NETWORK)
  const pointer = await repository.getActivePointer()
  if (!pointer) return null
  const snapshot = await repository.getSnapshot(pointer.generationId)
  const active = snapshot?.manifest.activeAccount
  if (!snapshot || !active) return null
  const chainAccount = snapshot.chainAccounts.find(
    item =>
      item.scope.keyDomainId === active.keyDomainId &&
      item.scope.accountId === active.accountId &&
      item.scope.chainId === config.chainId
  )
  if (!chainAccount || chainAccount.identity.kind !== 'account-identifier') return null
  const cached = readSoftwareStarknetAccount(active.keyDomainId, active.accountId)
  if (
    !cached ||
    normalizeStarknetFelt(cached.address) !== normalizeStarknetFelt(chainAccount.identity.value)
  ) {
    return null
  }
  return cached
}

export async function loadActiveStarknetTransferContext(
  repository: StarknetTransferStorageRepository
): Promise<ActiveStarknetTransferContext | null> {
  const config = getStarknetNetworkConfig(DEFAULT_NETWORK)
  const pointer = await repository.getActivePointer()
  if (!pointer) return null
  const snapshot = await repository.getSnapshot(pointer.generationId)
  if (!snapshot) throw new Error('Active Storage V2 generation is missing')
  const active = snapshot.manifest.activeAccount
  if (!active) return null
  const account = snapshot.accounts.find(
    item => item.keyDomainId === active.keyDomainId && item.id === active.accountId
  )
  if (!account) return null
  const chainAccount = snapshot.chainAccounts.find(
    item =>
      item.scope.keyDomainId === active.keyDomainId &&
      item.scope.accountId === active.accountId &&
      item.scope.chainId === config.chainId
  )
  if (!chainAccount || chainAccount.identity.kind !== 'account-identifier') return null
  const keyDomain = resolveKeyDomain(snapshot.keyDomains, active.keyDomainId)
  if (keyDomain.source.kind === 'hardware' && keyDomain.source.vendor === 'ledger') {
    return loadLedgerStarknetContext(snapshot, active.keyDomainId, account, chainAccount)
  }
  const path = /^m\/44'\/9004'\/(\d+)'\/0\/(\d+)$/.exec(chainAccount.derivation.path)
  if (!path) return null
  if (keyDomain.source.kind !== 'software') return null
  const signer = new StarknetMultichainSigningClient({ credentials: credentialSession })
  const derived = await signer.deriveAccount(active.keyDomainId, {
    chainId: config.chainId,
    accountIndex: account.accountIndex,
    addressIndex: Number(path[2]),
    classHash: '0x05b4b537eaa2399e3aa99c4e2e0208ebd6c71bc1467938cd52c798c601e43564'
  })
  const record = readRecord(derived)
  const address = readFelt(record, 'addresses')
  if (normalizeStarknetFelt(address) !== normalizeStarknetFelt(chainAccount.identity.value)) {
    throw new Error('Starknet account does not match the stored address')
  }
  return Object.freeze({
    chainAccount,
    accountIndex: account.accountIndex,
    addressIndex: Number(path[2]),
    keyDomainSource: keyDomain.source,
    publicKey: readFelt(record, 'publicKey'),
    classHash: readFelt(record, 'classHash')
  })
}

export function createBackgroundStarknetTransferController(
  assetDefinitions: readonly AssetDefinitionInput[],
  settings?: ChainEndpointSettings
) {
  const config = getStarknetNetworkConfig(DEFAULT_NETWORK)
  const repository = new IndexedDbStorageV2Repository()
  const signer = new StarknetMultichainSigningClient({ credentials: credentialSession })
  const orchestrator = new StarknetTransferOrchestrator({
    rpc: createStarknetRpcClient({ chainId: config.chainId, rpcUrl: starknetRpcUrl(settings) }),
    builder: {
      prepareInvoke: payload => starknetExternalClient(signer).prepareInvokeExternal(payload),
      prepareDeploy: payload => starknetExternalClient(signer).prepareDeployExternal(payload)
    },
    signer: {
      prepare: async (keyDomainId, payload) => {
        const prepared = await signer.prepare(keyDomainId as never, payload as never)
        return { commandId: prepared.commandId }
      },
      confirm: async (keyDomainId, signingCommandId) =>
        parseConfirmed(await signer.confirm(keyDomainId as never, signingCommandId)),
      signLedger: input => signStarknetLedgerTransaction(signer, input)
    },
    pending: new ChromeSessionStarknetPendingTransferStore(chrome.storage.session),
    repository: new IndexedDbTransactionRepository(),
    assets: createAssetRegistry(createInitialProductChainRegistry(DEFAULT_NETWORK), [
      ...getBundledInitialProductAssetDefinitions(DEFAULT_NETWORK),
      ...assetDefinitions
    ]),
    chainId: config.chainId,
    feeTokenReference: config.feeTokenReference
  })
  return new BackgroundStarknetTransferController({
    orchestrator,
    loadActiveContext: () => loadActiveStarknetTransferContext(repository),
    scheduleMonitor: () =>
      chrome.alarms.create(STARKNET_TRANSACTION_MONITOR_ALARM, { delayInMinutes: 0.1 })
  })
}

export type { StarknetTransferAccount }

function parseConfirmed(result: SigningResult): {
  readonly transactionHash: string
  readonly transaction: Readonly<Record<string, unknown>>
} {
  if (
    result.kind !== 'signed-payload' ||
    result.payload.encoding !== 'utf8' ||
    !result.transactionId
  ) {
    throw new Error('Starknet signing result is invalid')
  }
  const transaction = JSON.parse(result.payload.value) as unknown
  if (typeof transaction !== 'object' || transaction === null || Array.isArray(transaction)) {
    throw new Error('Starknet signing result is invalid')
  }
  const record = transaction as Record<string, unknown>
  assertStarknetExecutionTransaction(record)
  return { transactionHash: result.transactionId, transaction: record }
}

async function loadLedgerStarknetContext(
  snapshot: Parameters<typeof readActiveLedgerHardwareCredential>[1],
  keyDomainId: Parameters<typeof readActiveLedgerHardwareCredential>[2],
  account: Account,
  chainAccount: ActiveStarknetTransferContext['chainAccount']
): Promise<ActiveStarknetTransferContext | null> {
  const match = /^m\/2645'\/1195502025'\/1148870696'\/0'\/0'\/(\d+)$/.exec(
    chainAccount.derivation.path
  )
  if (!match || chainAccount.identity.kind !== 'account-identifier') return null
  const credential = await readActiveLedgerHardwareCredential(
    new IndexedDbCredentialRepository(),
    snapshot,
    keyDomainId,
    await credentialSession.getProvisioningPassword()
  )
  if (credential.accountExport.protocol !== 'ledger-accounts-v1') return null
  const exported = credential.accountExport.accounts.find(
    item =>
      item.family === 'starknet' &&
      normalizeStarknetFelt(item.address) === normalizeStarknetFelt(chainAccount.identity.value)
  )
  if (!exported || exported.family !== 'starknet') return null
  const classHash = normalizeStarknetFelt(exported.classHash)
  const implementation =
    classHash === normalizeStarknetFelt(STARKNET_ARGENT_V04_CLASS_HASH)
      ? 'argent_v0_4'
      : classHash === normalizeStarknetFelt(STARKNET_ARGENT_V05_CLASS_HASH)
        ? 'argent_v0_5'
        : null
  if (!implementation) throw new Error('Starknet hardware send is not enabled')
  rememberSoftwareStarknetAccount({
    address: normalizeStarknetFelt(exported.address),
    publicKey: normalizeStarknetFelt(exported.publicKey),
    classHash,
    implementation,
    accountIndex: account.accountIndex,
    addressIndex: Number(match[1]),
    keyDomainId,
    accountId: account.id,
    keySource: 'ledger'
  })
  return Object.freeze({
    chainAccount,
    accountIndex: account.accountIndex,
    addressIndex: Number(match[1]),
    keyDomainSource: resolveKeyDomain(snapshot.keyDomains, keyDomainId).source,
    publicKey: normalizeStarknetFelt(exported.publicKey),
    classHash
  })
}

async function signStarknetLedgerTransaction(
  signer: StarknetMultichainSigningClient,
  input: Parameters<NonNullable<StarknetTransferSigner['signLedger']>>[0]
): Promise<Readonly<Record<string, unknown>>> {
  const scopeChainId = input.account.chainAccount.scope.chainId
  if (scopeChainId !== 'starknet:SN_MAIN' && scopeChainId !== 'starknet:SN_SEPOLIA') {
    throw new Error('Starknet network changed')
  }
  const chainId = scopeChainId === 'starknet:SN_MAIN' ? 'starknet:SN_MAIN' : 'starknet:SN_SEPOLIA'
  const address =
    input.account.chainAccount.identity.kind === 'account-identifier'
      ? input.account.chainAccount.identity.value
      : ''
  const reviewed = input.transaction
  const nonce = readLedgerStarknetTransactionNonce(reviewed)
  const invokeCalls =
    input.kind === 'starknet-invoke'
      ? normalizeLedgerStarknetCalls(summaryCallRecords(reviewed))
      : null
  const summary = parseSigningSummary(
    input.kind === 'starknet-deploy-account'
      ? {
          schema: 'starknet.deploy-account.v1',
          chainId,
          operation: 'transaction',
          review: { level: 'caution', issues: [{ code: 'contract-creation', subjectIndex: 0 }] },
          fields: {
            contractAddress: address,
            classHash: input.account.classHash,
            salt: summaryFelt(reviewed, 'salt'),
            constructorCalldata: summaryFeltList(
              reviewed.constructorCalldata,
              'constructor calldata'
            ),
            nonce,
            tip: summaryTip(reviewed),
            resourceBounds: input.resourceBounds,
            nonceDataAvailabilityMode: summaryMode(reviewed.nonceDataAvailabilityMode),
            feeDataAvailabilityMode: summaryMode(reviewed.feeDataAvailabilityMode)
          }
        }
      : {
          schema: 'starknet.invoke.v1',
          chainId,
          operation: 'transaction',
          review: {
            level: 'caution',
            issues: (invokeCalls ?? []).map((_, subjectIndex) => ({
              code: 'unrecognized-call' as const,
              subjectIndex
            }))
          },
          fields: {
            senderAddress: address,
            nonce,
            tip: summaryTip(reviewed),
            resourceBounds: input.resourceBounds,
            calls: invokeCalls ?? [],
            nonceDataAvailabilityMode: summaryMode(reviewed.nonceDataAvailabilityMode),
            feeDataAvailabilityMode: summaryMode(reviewed.feeDataAvailabilityMode)
          }
        },
    { family: 'starknet', chainId: scopeChainId, operation: 'transaction' }
  )
  const response = await requestLedgerSignature(
    {
      kind: input.kind,
      chainId,
      derivationPath: input.account.chainAccount.derivation.path,
      publicKey: input.account.publicKey,
      address,
      classHash: input.account.classHash,
      blindSigning: false,
      transactionHash: input.transactionHash,
      transaction: reviewed
    },
    {
      scope: {
        keyDomainId: input.account.chainAccount.scope.keyDomainId,
        accountId: input.account.chainAccount.scope.accountId,
        chainId
      },
      payloadFingerprint: {
        algorithm: 'sha256',
        digestHex: await sha256Hex(input.transactionHash)
      },
      expiresAt: Date.now() + 5 * 60_000,
      summary,
      signal: input.signal,
      validate: async () => {
        if (input.signal?.aborted) throw new Error('Starknet signing was cancelled')
      }
    }
  )
  if (response.kind !== input.kind)
    throw new Error('Starknet Ledger signature does not match the review')
  const external = starknetExternalClient(signer)
  const assembledRequest = starknetExternalAssembleRequest(input.request, response.signature)
  const assembled =
    input.kind === 'starknet-deploy-account'
      ? await external.assembleDeployExternal(assembledRequest)
      : await external.assembleInvokeExternal(assembledRequest)
  return readAssembledStarknetTransaction(
    assembled,
    input.kind === 'starknet-deploy-account' ? 'deploy' : 'invoke',
    input.transactionHash
  )
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error('Starknet account is invalid')
  const record = value as Record<string, unknown>
  const addresses = record.addresses
  if (!Array.isArray(addresses) || addresses.length === 0)
    throw new Error('Starknet account is invalid')
  const address = addresses[0]
  if (typeof address !== 'object' || address === null)
    throw new Error('Starknet account is invalid')
  return { ...record, address: (address as { value?: unknown }).value }
}

function readFelt(record: Record<string, unknown>, key: string): string {
  const value = key === 'addresses' ? record.address : record[key]
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) {
    throw new Error('Starknet account is invalid')
  }
  return value
}

export function createStarknetSessionSigner(
  getAccount: () => { readonly keyDomainId: string } | null,
  settings?: ChainEndpointSettings
): StarknetSessionSigner {
  const signer = new StarknetMultichainSigningClient({ credentials: credentialSession })
  const network = getStarknetNetworkConfig(DEFAULT_NETWORK)
  const override = settings ? findChainEndpointOverride(settings, network.chainId)?.rpc : undefined
  const rpc = createStarknetRpcClient({
    chainId: network.chainId,
    rpcUrl: override?.protocol === 'starknet-json-rpc' ? override.url : network.rpcUrl
  })
  const requireAccount = () => {
    const account = getAccount()
    if (!account) throw new Error('No Starknet account is selected')
    return account
  }
  return {
    prepare: async payload => {
      const account = requireAccount()
      const prepared = await signer.prepare(
        parseKeyDomainId(account.keyDomainId),
        normalizeStarknetSessionPreparePayload(payload) as never
      )
      return { signingCommandId: prepared.commandId }
    },
    confirmInvoke: async signingCommandId => {
      const account = requireAccount()
      const result = await signer.confirm(parseKeyDomainId(account.keyDomainId), signingCommandId)
      return broadcastConfirmedStarknetInvoke(result, rpc)
    },
    confirmTypedData: async signingCommandId => {
      const account = requireAccount()
      const result = await signer.confirm(parseKeyDomainId(account.keyDomainId), signingCommandId)
      if (result.kind !== 'signature' || result.signature.encoding !== 'utf8') {
        throw new Error('Starknet signature is invalid')
      }
      const signature = JSON.parse(result.signature.value) as unknown
      if (!Array.isArray(signature) || signature.length !== 2) {
        throw new Error('Starknet signature is invalid')
      }
      return { signature: [String(signature[0]), String(signature[1])] as const }
    }
  }
}

export function createStarknetLedgerDappSigner(
  settings?: ChainEndpointSettings
): StarknetLedgerSigner {
  const signer = new StarknetMultichainSigningClient({ credentials: credentialSession })
  const config = getStarknetNetworkConfig(DEFAULT_NETWORK)
  const rpc = createStarknetRpcClient({ chainId: config.chainId, rpcUrl: starknetRpcUrl(settings) })
  return {
    submitInvoke: async input => {
      if (input.chainId !== config.chainId) throw new Error('Starknet network changed')
      const context = await loadActiveStarknetTransferContext(new IndexedDbStorageV2Repository())
      if (
        !context ||
        context.chainAccount.identity.kind !== 'account-identifier' ||
        normalizeStarknetFelt(context.publicKey) !== normalizeStarknetFelt(input.account.publicKey)
      ) {
        throw new Error('Starknet Ledger account is not selected')
      }
      const classHash = normalizeStarknetFelt(context.classHash)
      const external = starknetExternalClient(signer)
      if (input.quote.deploy) {
        const request = starknetDeployExternalRequest({
          chainId: input.chainId,
          publicKey: input.account.publicKey,
          accountAddress: input.account.address,
          classHash: input.account.classHash,
          nonce: input.quote.deploy.nonce,
          resourceBounds: input.quote.deploy.resourceBounds
        })
        const prepared = parseStarknetExternalPreparation(
          await external.prepareDeployExternal(request)
        )
        const signedDeploy = await signStarknetLedgerTransaction(signer, {
          account: context,
          kind: 'starknet-deploy-account',
          transactionHash: prepared.signingHash,
          transaction: prepared.summary,
          resourceBounds: input.quote.deploy.resourceBounds,
          request
        })
        const deployHash = await rpc.addDeployAccountTransaction(signedDeploy)
        if (deployHash !== prepared.signingHash) {
          throw new Error('Starknet deploy hash does not match the review')
        }
      } else if (classHash === normalizeStarknetFelt(STARKNET_ARGENT_V05_CLASS_HASH)) {
        const deployment = await readStarknetAccountDeployment(rpc, input.account.address)
        if (!deployment.deployed) throw new Error('Starknet hardware deploy is not enabled')
      }
      const request = starknetInvokeExternalRequest({
        chainId: input.chainId,
        publicKey: input.account.publicKey,
        accountAddress: input.account.address,
        classHash: input.account.classHash,
        calls: input.calls,
        nonce: input.quote.nonce,
        resourceBounds: input.quote.resourceBounds
      })
      const prepared = parseStarknetExternalPreparation(
        await external.prepareInvokeExternal(request)
      )
      const signed = await signStarknetLedgerTransaction(signer, {
        account: context,
        kind: 'starknet-invoke',
        transactionHash: prepared.signingHash,
        transaction: prepared.summary,
        resourceBounds: input.quote.resourceBounds,
        request
      })
      const transactionHash = await rpc.addInvokeTransaction(signed)
      if (transactionHash !== prepared.signingHash) {
        throw new Error('Starknet signature does not match the review')
      }
      return { transactionHash }
    },
    signTypedData: async input => {
      if (input.chainId !== config.chainId) throw new Error('Starknet network changed')
      const context = await loadActiveStarknetTransferContext(new IndexedDbStorageV2Repository())
      if (
        !context ||
        normalizeStarknetFelt(context.publicKey) !== normalizeStarknetFelt(input.account.publicKey)
      ) {
        throw new Error('Starknet Ledger account is not selected')
      }
      const typedData = JSON.stringify(input.typedData)
      const hashed = await signer.hashTypedData({
        chainId: input.chainId,
        accountAddress: input.account.address,
        publicKey: input.account.publicKey,
        classHash: input.account.classHash,
        implementation: starknetExternalImplementation(input.account.classHash),
        typedData
      })
      const messageHash = readTypedDataHash(hashed)
      const bytes = new TextEncoder().encode(typedData)
      const digest = await crypto.subtle.digest('SHA-256', bytes)
      const sha256 = [...new Uint8Array(digest)]
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('')
      const summary = parseSigningSummary(
        {
          schema: 'starknet.typed-data.v1',
          chainId: input.chainId,
          operation: 'message',
          review: { level: 'caution', issues: [{ code: 'opaque-message', subjectIndex: 0 }] },
          fields: {
            accountAddress: input.account.address,
            publicKey: input.account.publicKey,
            typedData: { encoding: 'utf8', value: typedData, byteLength: bytes.byteLength, sha256 }
          }
        },
        { family: 'starknet', chainId: context.chainAccount.scope.chainId, operation: 'message' }
      )
      const response = await requestLedgerSignature(
        {
          kind: 'starknet-typed-data',
          chainId: input.chainId,
          derivationPath: context.chainAccount.derivation.path,
          publicKey: input.account.publicKey,
          address: input.account.address,
          classHash: input.account.classHash,
          blindSigning: true,
          messageHash
        },
        {
          scope: {
            keyDomainId: context.chainAccount.scope.keyDomainId,
            accountId: context.chainAccount.scope.accountId,
            chainId: input.chainId
          },
          payloadFingerprint: { algorithm: 'sha256', digestHex: sha256 },
          expiresAt: Date.now() + 5 * 60_000,
          summary,
          validate: async () => undefined
        }
      )
      if (response.kind !== 'starknet-typed-data')
        throw new Error('Starknet Ledger signature does not match the review')
      return response.signature
    }
  }
}

function readTypedDataHash(value: unknown): string {
  if (typeof value !== 'object' || value === null)
    throw new Error('Starknet typed data hash is invalid')
  const hash = (value as { signingHash?: unknown }).signingHash
  if (typeof hash !== 'string') throw new Error('Starknet typed data hash is invalid')
  return hash
}

interface StarknetExternalSigningMethods {
  prepareInvokeExternal(payload: KeyringCommandPayload, signal?: AbortSignal): Promise<unknown>
  assembleInvokeExternal(payload: KeyringCommandPayload, signal?: AbortSignal): Promise<unknown>
  prepareDeployExternal(payload: KeyringCommandPayload, signal?: AbortSignal): Promise<unknown>
  assembleDeployExternal(payload: KeyringCommandPayload, signal?: AbortSignal): Promise<unknown>
}

function starknetExternalClient(
  signer: StarknetMultichainSigningClient
): StarknetMultichainSigningClient & StarknetExternalSigningMethods {
  return signer as StarknetMultichainSigningClient & StarknetExternalSigningMethods
}

function summaryCallRecords(
  summary: Readonly<Record<string, unknown>>
): readonly Readonly<Record<string, unknown>>[] {
  const calls = summary.calls
  if (!Array.isArray(calls)) throw new Error('Ledger Starknet transaction has no calls')
  return calls.map(item => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error('Ledger Starknet transaction has no calls')
    }
    return item as Readonly<Record<string, unknown>>
  })
}

function summaryFelt(summary: Readonly<Record<string, unknown>>, key: string): string {
  const value = summary[key]
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) {
    throw new Error(`Starknet ${key} is invalid`)
  }
  return value.toLowerCase()
}

function summaryFeltList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`Starknet ${label} is invalid`)
  return value.map(item => {
    if (typeof item !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(item)) {
      throw new Error(`Starknet ${label} is invalid`)
    }
    return item.toLowerCase()
  })
}

function summaryTip(summary: Readonly<Record<string, unknown>>): string {
  const tip = summary.tip ?? '0'
  if (typeof tip !== 'string' || !/^(0|[1-9][0-9]*)$/.test(tip)) {
    throw new Error('Starknet tip is invalid')
  }
  return tip
}

function summaryMode(value: unknown): 'l1' | 'l2' {
  if (value === 'l1' || value === 'L1') return 'l1'
  if (value === 'l2' || value === 'L2') return 'l2'
  throw new Error('Starknet data availability mode is invalid')
}
