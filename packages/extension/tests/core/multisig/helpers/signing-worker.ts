import { loadWalletWasm, TEST_MNEMONIC, type WalletWasmModule } from './vault-wasm'
import { bytesToBase64 } from '../../../../src/lib/bytes'
import { generateDeviceIdentity } from '../../../../src/core/multisig/identity'
import { buildRoster } from '../../../../src/core/multisig/roster'
import { createVaultDkgRpcHandler } from '../../../../src/core/multisig/dkg-rpc'
import { createEnvelopeSigner } from '../../../../src/core/multisig/envelope-signing'
import { callVaultDkg, runRounds, Phone } from './raw-phone'

/** A real authenticated vault fixture; it does not construct or approve a transaction PCZT. */
export async function realReviewFixture() {
  const wasm = await loadWalletWasm()
  const identities = await Promise.all([generateDeviceIdentity(), generateDeviceIdentity()])
  const scope = {
    walletId: 'wallet-1',
    accountId: 'account-1',
    network: 'testnet' as const,
    groupId: 'group-1',
    rosterVersion: 1
  }
  const roster = buildRoster({
    groupId: scope.groupId,
    threshold: 2,
    identities: new Map(identities.map((id, slot) => [slot, bytesToBase64(id.publicKey)]))
  })
  const dkg = createVaultDkgRpcHandler(wasm, () => TEST_MNEMONIC)
  const { sessionId } = await callVaultDkg(dkg, 'vault.dkg.open', {
    participants: 2,
    threshold: 2,
    mainnet: false,
    ownerWalletId: scope.walletId,
    groupId: scope.groupId,
    outerSessionId: 'outer-1',
    binding: { accountId: scope.accountId, birthdayHeight: 123, rosterVersion: 1, roster }
  })
  const phone = createEnvelopeSigner({
    groupId: scope.groupId,
    sessionId: 'outer-1',
    senderId: 'device-2',
    signingKey: identities[1].signingKeys.privateKey
  })
  const phones = [new Phone(wasm, { participants: 2, threshold: 2 }, 1, sessionId)]
  const r2 = await runRounds(
    wasm,
    dkg,
    { participants: 2, threshold: 2 },
    sessionId,
    phones,
    (_slot, type, payload) => phone.next(type, 'device-1', payload)
  )
  phones[0].finish(r2.inboxes['1'], r2.sealedQsk['1'], false)
  await callVaultDkg(dkg, 'vault.dkg.close', { sessionId })
  const request = {
    scope,
    source: {
      kind: 'frost-vault' as const,
      version: 1 as const,
      network: scope.network,
      groupId: scope.groupId
    },
    sealedRecord: r2.record,
    intent: {
      recipient: 'u-synthetic',
      amount: '1',
      memo: '',
      marginalFeeZats: 5000,
      feeQuoteId: 'quote-1'
    },
    selectedSlots: [0, 1],
    transport: 'qr' as const
  }
  const credential = {
    keyDomainId: scope.walletId,
    credentialGenerationId: 'credential-generation:1',
    globalUnlockEpoch: 'global-unlock:1',
    mnemonic: TEST_MNEMONIC
  }
  return { wasm, identities, request, credential, phones, fingerprint: r2.fingerprint }
}

/** TEST ONLY: exercises native FROST/session plumbing, not actual PCZT review or group binding.
 * The upstream immutable PCZT belongs to a different random group. Production never imports this.
 */
export function createProtocolOnlySigningWasm(wasm: WalletWasmModule): WalletWasmModule {
  return {
    ...wasm,
    PcztTools: {
      check() {},
      shielded_sighash: () => new Uint8Array(32).fill(7),
      action_alphas: () => new Uint8Array(32).fill(1),
      action_rks: () => new Uint8Array(32),
      signingSet: () => Uint8Array.of(0),
      check_action_bindings() {},
      strip_proofs: bytes => bytes.slice(),
      apply_signatures: bytes => bytes.slice()
    } as typeof wasm.PcztTools
  }
}
