import { secp256k1 } from '@noble/curves/secp256k1'
import { hashMessage, keccak256, type Hex } from 'viem'
import { parseKeyDomainId } from '@/core/keyring/domain'
import { parseChainId } from '@/core/chains/registry'
import { EvmMultichainSigningClient } from '@/infrastructure/keyring/multichain/evm-signing-client'
import { credentialSession } from '../credential-session'
import { assertPublicContext, type NoirPublicRequestContext } from './public-context'

const signer = new EvmMultichainSigningClient({ credentials: credentialSession })

function signatureMatchesAddress(message: string, signature: string, address: string): boolean {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return false
  const v = Number.parseInt(signature.slice(-2), 16)
  const recoveryBit = v === 27 || v === 28 ? v - 27 : v
  if (recoveryBit !== 0 && recoveryBit !== 1) return false
  try {
    const publicKey = secp256k1.Signature.fromCompact(signature.slice(2, 130))
      .addRecoveryBit(recoveryBit)
      .recoverPublicKey(hashMessage(message).slice(2))
      .toHex(false)
    return `0x${keccak256(`0x${publicKey.slice(2)}` as Hex).slice(-40)}` === address
  } catch {
    return false
  }
}

export async function signPublicEvmMessage(
  context: NoirPublicRequestContext,
  message: string,
  approve?: (review: unknown) => Promise<{ approved: boolean }>
): Promise<string> {
  if (!context.chainId || !context.evmAddress || !context.evmExecutionMode)
    throw new Error('Public EVM signing context is unavailable')
  await assertPublicContext(context)
  const keyDomainId = parseKeyDomainId(context.walletId)
  const prepared = await signer.prepare(keyDomainId, {
    kind:
      context.evmExecutionMode === 'private' ? 'pea-evm-personal-message' : 'evm-personal-message',
    chainId: parseChainId(context.chainId).id,
    addressIndex: context.derivationIndex,
    message: new TextEncoder().encode(message)
  })
  let confirmed = false
  try {
    await assertPublicContext(context)
    if (approve && !(await approve(prepared)).approved)
      throw new Error('User rejected the signature request')
    await assertPublicContext(context)
    const result = await signer.confirm(keyDomainId, prepared.commandId)
    confirmed = true
    await assertPublicContext(context)
    if (
      result.kind !== 'signature' ||
      result.signature.encoding !== 'hex' ||
      typeof result.signature.value !== 'string' ||
      result.address?.toLowerCase() !== context.evmAddress ||
      !signatureMatchesAddress(message, result.signature.value, context.evmAddress)
    )
      throw new Error('Public EVM signature does not match the authorized account')
    return result.signature.value
  } finally {
    if (!confirmed) await signer.cancel(keyDomainId, prepared.commandId).catch(() => {})
  }
}
