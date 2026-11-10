import * as secp256k1 from '@bitcoinerlab/secp256k1'
import type { DerivedPearlAddress } from '@/core/chains/pearl'
import { address, initEccLib, Psbt } from 'bitcoinjs-lib'
import { Buffer } from 'buffer'
import { pearlBitcoinJsNetwork } from './pearl-network'
import { parsePearlChain, type PreparedPearlPsbt } from './pearl-transaction-model'

let eccInitialized = false

function ensurePearlEcc(): void {
  if (eccInitialized) return
  initEccLib(secp256k1)
  eccInitialized = true
}

function xOnlyPublicKey(publicKey: string): Buffer {
  const hex = publicKey.startsWith('0x') ? publicKey.slice(2) : publicKey
  return Buffer.from(hex, 'hex').subarray(1, 33)
}

function scriptFromDerived(
  derived: DerivedPearlAddress,
  network: ReturnType<typeof pearlBitcoinJsNetwork>
) {
  if (/^0x5120[0-9a-f]{64}$/i.test(derived.scriptPubKey)) {
    return Buffer.from(derived.scriptPubKey.slice(2), 'hex')
  }
  return address.toOutputScript(derived.address, network)
}

function tapKeyOrigin(internalPubkey: Buffer, derivationPath: string, masterFingerprint: Buffer) {
  return {
    tapInternalKey: internalPubkey,
    tapBip32Derivation: [
      {
        masterFingerprint,
        pubkey: internalPubkey,
        path: derivationPath,
        leafHashes: [] as Buffer[]
      }
    ]
  }
}

function hasMatchingOrigin(
  entries:
    | ReadonlyArray<{
        readonly masterFingerprint: Buffer
        readonly pubkey: Buffer
        readonly path: string
      }>
    | undefined,
  path: string,
  internalPubkey: Buffer,
  masterFingerprint: Buffer
): boolean {
  return (
    entries?.some(
      entry =>
        entry.path === path &&
        Buffer.from(entry.pubkey).equals(internalPubkey) &&
        Buffer.from(entry.masterFingerprint).equals(masterFingerprint)
    ) ?? false
  )
}

/**
 * dApp PSBTs often omit BIP-32 key origins. Attach them for inputs and outputs
 * that use the active Pearl receive script so Worker/WASM ownership checks pass.
 * Wallet-owned change outputs without BIP-86 origins are rejected as invalid Pearl PSBTs.
 */
export function attachPearlOwnedInputOrigins(
  psbtHex: string,
  derived: DerivedPearlAddress,
  chainIdValue: PreparedPearlPsbt['chainId'] | string
): string {
  ensurePearlEcc()
  const chainId = parsePearlChain(chainIdValue)
  const network = pearlBitcoinJsNetwork(chainId)
  const psbt = Psbt.fromHex(psbtHex, { network })
  const expectedScript = scriptFromDerived(derived, network)
  const internalPubkey = xOnlyPublicKey(derived.publicKey)
  const masterFingerprint = Buffer.from(derived.masterFingerprint.slice(2), 'hex')
  const path = derived.derivationPath
  const origin = tapKeyOrigin(internalPubkey, path, masterFingerprint)

  psbt.data.inputs.forEach((input, index) => {
    const script = input.witnessUtxo?.script
    if (!script || !Buffer.from(script).equals(expectedScript)) return
    const updates: {
      tapInternalKey?: Buffer
      tapBip32Derivation?: typeof origin.tapBip32Derivation
    } = {}
    if (!input.tapInternalKey || !Buffer.from(input.tapInternalKey).equals(internalPubkey)) {
      updates.tapInternalKey = origin.tapInternalKey
    }
    if (!hasMatchingOrigin(input.tapBip32Derivation, path, internalPubkey, masterFingerprint)) {
      updates.tapBip32Derivation = [
        ...(input.tapBip32Derivation ?? []).map(entry => ({
          masterFingerprint: Buffer.from(entry.masterFingerprint),
          pubkey: Buffer.from(entry.pubkey),
          path: entry.path,
          leafHashes: entry.leafHashes.map(hash => Buffer.from(hash))
        })),
        ...origin.tapBip32Derivation
      ]
    }
    if (Object.keys(updates).length > 0) psbt.updateInput(index, updates)
  })

  psbt.data.outputs.forEach((output, index) => {
    const script = psbt.txOutputs[index]?.script
    if (!script || !Buffer.from(script).equals(expectedScript)) return
    const updates: {
      tapInternalKey?: Buffer
      tapBip32Derivation?: typeof origin.tapBip32Derivation
    } = {}
    if (!output.tapInternalKey || !Buffer.from(output.tapInternalKey).equals(internalPubkey)) {
      updates.tapInternalKey = origin.tapInternalKey
    }
    if (!hasMatchingOrigin(output.tapBip32Derivation, path, internalPubkey, masterFingerprint)) {
      updates.tapBip32Derivation = [
        ...(output.tapBip32Derivation ?? []).map(entry => ({
          masterFingerprint: Buffer.from(entry.masterFingerprint),
          pubkey: Buffer.from(entry.pubkey),
          path: entry.path,
          leafHashes: entry.leafHashes.map(hash => Buffer.from(hash))
        })),
        ...origin.tapBip32Derivation
      ]
    }
    if (Object.keys(updates).length > 0) psbt.updateOutput(index, updates)
  })

  return psbt.toHex()
}
