import { assertRawEvmAccountMatches, parseRawEvmAccount } from '../multichain/raw-wallet-engine'

interface EvmDerivationEngine {
  deriveEvmAccount(sessionId: number, chainId: string, accountIndex: number): unknown
}

export function assertCredentialOnlyVaultMatchesMnemonic(
  engine: EvmDerivationEngine,
  targetSessionId: number,
  mnemonicSessionId: number,
  chainId: string
): void {
  const target = parseRawEvmAccount(engine.deriveEvmAccount(targetSessionId, chainId, 0))
  const mnemonic = parseRawEvmAccount(engine.deriveEvmAccount(mnemonicSessionId, chainId, 0))
  assertRawEvmAccountMatches(target, chainId, 0)
  assertRawEvmAccountMatches(mnemonic, chainId, 0)
  if (target.address !== mnemonic.address || target.publicKey !== mnemonic.publicKey) {
    throw new Error('Credential-only target vault does not match retained mnemonic')
  }
}
