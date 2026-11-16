/**
 * Phones driven through the raw WASM API, and the JSON-shaped calls that carry their envelopes to
 * a Worker vault handler. Shared by the Worker handler tests and the Background integration test.
 */
import type {
  VaultDkgMethod,
  VaultDkgRpcHandler,
  VaultDkgSchema
} from '../../../../src/core/multisig/dkg-rpc'
import { round1Hash, type VaultWasm } from '../../../../src/core/multisig/dkg-protocol'
import { base64ToBytes, bytesToBase64, bytesToHex } from '../../../../src/lib/bytes'

export type Shape = { participants: 2 | 3; threshold: 2 | 3 }
type Dkg = InstanceType<VaultWasm['Dkg']>

export type Round2Complete = Extract<
  VaultDkgSchema['vault.dkg.acceptRound2']['response'],
  { complete: true }
>

// Every request and response crosses a JSON boundary, as chrome.runtime messages do.
export async function callVaultDkg<M extends VaultDkgMethod>(
  handler: VaultDkgRpcHandler,
  method: M,
  payload: unknown
): Promise<VaultDkgSchema[M]['response']> {
  const result = await handler.handle(method, JSON.parse(JSON.stringify(payload)))
  return JSON.parse(JSON.stringify(result))
}

/** A phone that only ever sees base64 strings, like the extension's transport shell. */
export class Phone {
  private readonly dkg: Dkg
  private readonly sessionId: Uint8Array
  private dkg1: ReturnType<Dkg['part1']> | null = null
  private dkg2: ReturnType<Dkg['part2']> | null = null
  private broadcasts: InstanceType<VaultWasm['MessageSet']> | null = null

  constructor(
    private readonly wasm: VaultWasm,
    shape: Shape,
    readonly slot: number,
    sessionId: string
  ) {
    this.sessionId = base64ToBytes(sessionId)
    this.dkg = new wasm.Dkg(shape.participants, shape.threshold, slot)
  }

  round1(): string {
    this.dkg1 = this.dkg.part1()
    return bytesToBase64(this.dkg1.broadcast_envelope(this.sessionId, 1, this.slot))
  }

  echo(bundle: string): Promise<string> {
    const payload = this.wasm.EnvelopeCodec.decode(base64ToBytes(bundle))[6] as Uint8Array
    return round1Hash(this.wasm.MessageSet.from_bytes(payload).to_bytes())
  }

  round2(bundle: string): string {
    if (!this.dkg1) throw new Error('round1() first')
    const payload = this.wasm.EnvelopeCodec.decode(base64ToBytes(bundle))[6] as Uint8Array
    this.broadcasts = this.wasm.MessageSet.from_bytes(payload)
    this.dkg2 = this.dkg.part2(this.dkg1.secret(), this.broadcasts)
    return bytesToBase64(this.dkg2.outgoing_envelope(this.sessionId, 2, this.slot))
  }

  finish(inbox: string, sealedQsk: string, mainnet: boolean): string {
    if (!this.dkg2 || !this.broadcasts) throw new Error('round2() first')
    const payload = this.wasm.EnvelopeCodec.decode(base64ToBytes(inbox))[6] as Uint8Array
    const dkg3 = this.dkg.part3(
      this.dkg2.secret(),
      this.broadcasts,
      this.wasm.MessageSet.from_bytes(payload)
    )
    const statics = dkg3.statics()
    const coordinatorKey = statics.get(0)
    if (!coordinatorKey) throw new Error('no coordinator static key')
    const qsk = this.wasm.Sealed.open(
      dkg3.static_secret(),
      coordinatorKey,
      this.wasm.Sealed.prologue(statics),
      base64ToBytes(sealedQsk)
    )
    return bytesToHex(this.wasm.Keyset.derive(dkg3.group_verifying_key(), qsk, mainnet, 0)[4])
  }
}

/** Plays both rounds of an opened Worker session with fresh phones and returns the final answer. */
export async function runRounds(
  wasm: VaultWasm,
  handler: VaultDkgRpcHandler,
  shape: Shape,
  sessionId: string
): Promise<Round2Complete> {
  const phones: Phone[] = []
  for (let slot = 1; slot < shape.participants; slot += 1) {
    phones.push(new Phone(wasm, shape, slot, sessionId))
  }
  let r1: VaultDkgSchema['vault.dkg.acceptRound1']['response'] = { complete: false }
  for (const phone of phones) {
    r1 = await callVaultDkg(handler, 'vault.dkg.acceptRound1', {
      sessionId,
      senderSlot: phone.slot,
      envelope: phone.round1()
    })
  }
  if (!r1.complete) throw new Error('round 1 should be complete')
  let r2: VaultDkgSchema['vault.dkg.acceptRound2']['response'] = { complete: false }
  for (const phone of phones) {
    r2 = await callVaultDkg(handler, 'vault.dkg.acceptRound2', {
      sessionId,
      senderSlot: phone.slot,
      envelope: phone.round2(r1.bundles[String(phone.slot)])
    })
  }
  if (!r2.complete) throw new Error('round 2 should be complete')
  return r2
}
