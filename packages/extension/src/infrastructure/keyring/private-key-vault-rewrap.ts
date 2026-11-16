import { MultichainCommandClient } from '@/infrastructure/keyring/multichain/command-client'
import {
  parseCredentialGenerationId,
  parseGlobalUnlockEpoch,
  parseSessionKeyDomainId,
  type KeyringCommandPayload
} from '@/core/keyring/ports'
import type { PrivateKeyCredentialScope } from '@/core/keyring/domain'
import { parseRawEncryptedVault, type RawEncryptedVault } from './multichain/raw-wallet-engine'
import { BackgroundMultichainTransport } from './multichain/background-transport'

export async function rewrapPrivateKeyVault(
  input: Readonly<{
    readonly vault: RawEncryptedVault
    readonly currentPassword: string
    readonly newPassword: string
    readonly scope: PrivateKeyCredentialScope
  }>
): Promise<RawEncryptedVault> {
  const operationId = crypto.randomUUID()
  const binding = Object.freeze({
    kind: 'credential' as const,
    keyDomainId: parseSessionKeyDomainId(`wallet:private-key-rewrap:${operationId}`),
    credentialGenerationId: parseCredentialGenerationId(
      `credential-generation:private-key-rewrap:${operationId}`
    ),
    globalUnlockEpoch: parseGlobalUnlockEpoch(`global-unlock:${operationId}`)
  })
  const commandClient = new MultichainCommandClient(new BackgroundMultichainTransport(), {
    defaultTimeoutMs: 120_000,
    maxTimeoutMs: 120_000
  })
  try {
    return await commandClient.execute(
      {
        operation: 'credential.rewrap-private-key',
        binding,
        payload: {
          vault: input.vault,
          currentPassword: input.currentPassword,
          newPassword: input.newPassword,
          chainFamily: input.scope.chainFamily,
          ...(input.scope.chainFamily === 'bip122'
            ? { bitcoinNetwork: input.scope.bitcoinNetwork }
            : {})
        } as KeyringCommandPayload
      },
      parseRawEncryptedVault
    )
  } finally {
    await commandClient.destroy()
  }
}
