import { MultichainCommandClient } from '@/infrastructure/keyring/multichain/command-client'
import {
  parseCredentialGenerationId,
  parseGlobalUnlockEpoch,
  parseSessionKeyDomainId,
  type KeyringTransport
} from '@/core/keyring/ports'
import type { MnemonicWordCount } from '@/config/wallet'
import { ChromeRuntimeMultichainTransport } from './chrome-runtime-transport'
import { parseRawCreatedWallet } from './raw-wallet-engine'

/** Generates the canonical recovery phrase inside the pinned Multichain WASM. */
export async function generateCanonicalMnemonic(
  wordCount: MnemonicWordCount,
  password: string,
  transport: KeyringTransport = new ChromeRuntimeMultichainTransport()
): Promise<string> {
  const operationId = crypto.randomUUID()
  const commandClient = new MultichainCommandClient(transport, {
    defaultTimeoutMs: 120_000,
    maxTimeoutMs: 120_000
  })
  try {
    const created = await commandClient.execute(
      {
        operation: 'credential.create',
        binding: {
          kind: 'credential',
          keyDomainId: parseSessionKeyDomainId(`key-domain:mnemonic-creation:${operationId}`),
          credentialGenerationId: parseCredentialGenerationId(
            `credential-generation:mnemonic-creation:${operationId}`
          ),
          globalUnlockEpoch: parseGlobalUnlockEpoch(
            `global-unlock:mnemonic-creation:${operationId}`
          )
        },
        payload: { wordCount, password }
      },
      parseRawCreatedWallet
    )
    if (created.mnemonic.split(' ').length !== wordCount) {
      throw new Error('Multichain WASM returned an unexpected recovery phrase length')
    }
    return created.mnemonic
  } finally {
    await commandClient.destroy()
  }
}
