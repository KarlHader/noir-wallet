import { MultichainCommandClient } from '@/infrastructure/keyring/multichain/command-client'
import { getNearNetworkConfig, getSolanaNetworkConfig } from '@/config/networks'
import {
  nearImplicitAccountIdFromPublicKey,
  parseNearAccountId,
  parseNearPublicKey
} from '@/core/chains/near'
import { parseSolanaPublicKey } from '@/core/chains/solana'
import type { Network } from '@/types'
import type { DerivedEd25519NetworkAccount } from '@/infrastructure/keyring/network-account-metadata-coordinator'
import { createConfiguredNearRpcClient, discoverNearAccounts } from '@/infrastructure/chains/near'
import { BackgroundMultichainTransport } from '@/infrastructure/keyring/multichain/background-transport'
import { formatWalletLogPrefix } from '@/lib/log-format'
import {
  assertExactKeys,
  readLiteral,
  readRecord,
  readString
} from '@/infrastructure/keyring/multichain/raw-wallet-engine'
import type { KeyringCommandPayload } from '@/core/keyring/ports'
import { credentialSession } from './credential-session'

export interface SoftwareEd25519NetworkMetadata {
  readonly solana?: DerivedEd25519NetworkAccount
  readonly near?: DerivedEd25519NetworkAccount
}

export interface DeriveSoftwareEd25519MetadataInput {
  readonly keyDomainId: string
  readonly accountIndex: number
  readonly network: Network
  readonly solanaEnabled: boolean
  readonly nearEnabled: boolean
}

function toMetadata(
  chainId: string,
  raw: Readonly<{ address: string; publicKey: string; derivationPath: string }>
): DerivedEd25519NetworkAccount {
  return Object.freeze({
    chainId,
    address: raw.address,
    publicKey: raw.publicKey,
    derivationPath: raw.derivationPath
  })
}

function parseDerivedEd25519PublicAccount(
  value: unknown,
  family: 'solana' | 'near',
  chainId: string,
  accountIndex: number
): DerivedEd25519NetworkAccount {
  const label = family === 'solana' ? 'Solana public account' : 'NEAR public account'
  const record = readRecord(value, label)
  assertExactKeys(
    record,
    ['chainId', 'derivation', 'identity', 'addresses', 'publicKey'],
    [],
    label
  )
  if (
    record.chainId !== chainId ||
    !Array.isArray(record.addresses) ||
    record.addresses.length !== 1
  ) {
    throw new Error(`${label} does not match its request`)
  }

  const derivation = readRecord(record.derivation, `${label} derivation`)
  const identity = readRecord(record.identity, `${label} identity`)
  const address = readRecord(record.addresses[0], `${label} address`)
  const addressDerivation = readRecord(address.derivation, `${label} address derivation`)
  assertExactKeys(derivation, ['scheme', 'path'], [], `${label} derivation`)
  assertExactKeys(identity, ['kind', 'value'], [], `${label} identity`)
  assertExactKeys(address, ['value', 'scheme', 'purpose', 'derivation'], [], `${label} address`)
  assertExactKeys(addressDerivation, ['scheme', 'path'], [], `${label} address derivation`)

  readLiteral(derivation.scheme, ['slip10'], `${label} derivation scheme`)
  readLiteral(addressDerivation.scheme, ['slip10'], `${label} address derivation scheme`)
  readLiteral(identity.kind, ['account-identifier'], `${label} identity kind`)
  readLiteral(address.scheme, [family], `${label} address scheme`)
  readLiteral(address.purpose, ['identity'], `${label} address purpose`)
  const derivationPath =
    family === 'solana' ? `m/44'/501'/${accountIndex}'/0'` : `m/44'/397'/${accountIndex}'`
  if (derivation.path !== derivationPath || addressDerivation.path !== derivationPath) {
    throw new Error(`${label} derivation path does not match its request`)
  }

  const addressValue = readString(address.value, `${label} address`, 128)
  if (identity.value !== addressValue)
    throw new Error(`${label} identity does not match its address`)
  const publicKey = readString(record.publicKey, `${label} public key`, 128)
  if (family === 'solana') {
    if (
      parseSolanaPublicKey(addressValue) !== parseSolanaPublicKey(publicKey) ||
      addressValue !== publicKey
    ) {
      throw new Error('Solana public account identity is invalid')
    }
  } else {
    const nearAddress = parseNearAccountId(addressValue)
    const nearPublicKey = parseNearPublicKey(publicKey)
    if (nearAddress !== nearImplicitAccountIdFromPublicKey(nearPublicKey)) {
      throw new Error('NEAR public account identity is invalid')
    }
  }
  return toMetadata(chainId, { address: addressValue, publicKey, derivationPath })
}

export async function deriveSoftwareEd25519NetworkMetadata(
  input: DeriveSoftwareEd25519MetadataInput
): Promise<SoftwareEd25519NetworkMetadata> {
  if (!input.solanaEnabled && !input.nearEnabled) return Object.freeze({})
  if (
    !Number.isSafeInteger(input.accountIndex) ||
    input.accountIndex < 0 ||
    input.accountIndex >= 2 ** 31
  ) {
    throw new Error('Invalid Ed25519 Account index')
  }
  const binding = await credentialSession.getCredentialBinding(input.keyDomainId)
  const commandClient = new MultichainCommandClient(new BackgroundMultichainTransport(), {
    defaultTimeoutMs: 60_000,
    maxTimeoutMs: 60_000
  })
  let solana: DerivedEd25519NetworkAccount | undefined
  let near: DerivedEd25519NetworkAccount | undefined
  try {
    const solanaChainId = getSolanaNetworkConfig(
      input.network === 'mainnet' ? 'mainnet' : 'devnet'
    ).chainId
    const nearChainId = getNearNetworkConfig(input.network).chainId
    ;[solana, near] = await Promise.all([
      input.solanaEnabled
        ? commandClient.execute(
            {
              operation: 'account.derive-public',
              binding,
              payload: {
                family: 'solana',
                chainId: solanaChainId,
                accountIndex: input.accountIndex
              } as KeyringCommandPayload
            },
            value => {
              return parseDerivedEd25519PublicAccount(
                value,
                'solana',
                solanaChainId,
                input.accountIndex
              )
            }
          )
        : undefined,
      input.nearEnabled
        ? commandClient.execute(
            {
              operation: 'account.derive-public',
              binding,
              payload: {
                family: 'near',
                chainId: nearChainId,
                accountIndex: input.accountIndex
              } as KeyringCommandPayload
            },
            value => {
              return parseDerivedEd25519PublicAccount(
                value,
                'near',
                nearChainId,
                input.accountIndex
              )
            }
          )
        : undefined
    ])
  } finally {
    await commandClient.destroy()
  }
  if (near) {
    try {
      const discovered = await discoverNearAccounts({
        network: input.network,
        publicKey: near.publicKey,
        rpc: createConfiguredNearRpcClient({
          chainId: near.chainId,
          rpcUrl: getNearNetworkConfig(input.network).rpcUrl
        })
      })
      near = Object.freeze({
        ...near,
        address: discovered.primaryAccountId,
        implicitAddress: discovered.implicitAccountId,
        accountIds: discovered.accountIds
      })
    } catch (error) {
      console.warn(
        `${formatWalletLogPrefix('Wallet', input.keyDomainId)} NEAR named account discovery failed; using the implicit account`,
        error
      )
    }
  }
  return Object.freeze({
    ...(solana === undefined ? {} : { solana }),
    ...(near === undefined ? {} : { near })
  })
}
