import { test } from 'node:test'
import { expect } from '@playwright/test'
import { sha256 } from '@noble/hashes/sha2'
import {
  ENVELOPE_SIGNATURE_CONTEXT,
  canonicalEnvelopeBytes,
  createEnvelopeSigner,
  envelopePayloadHash,
  signEnvelope,
  verifyEnvelope
} from '../../../src/core/multisig/envelope-signing'
import { bytesToHex, hexToBytes } from '../../../src/lib/bytes'
import { SPEC_SEED, importEd25519Seed } from './helpers/identity'

const EXAMPLE_ED = '03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8'
const HEAD = {
  protocol_version: 1,
  message_type: 'PAIR_INVITE',
  group_id: '11111111-2222-4333-8444-555555555555',
  session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  sender_id: 'device-1',
  recipient_id: 'device-2',
  round: 0,
  sequence: 1,
  encrypted_payload: '{"identityPublicKey":"AA==","x":1}'
} as const
const PAYLOAD_HASH = '8a39be861ff813c371bd6b9626c64444c085998c6d814fe3d37c03ab5d2a98d4'
const CANONICAL_HEX =
  '6e6f69722f656e76656c6f70652f763100000001310000000b504149525f494e564954450000002431313131313131312d323232322d343333332d383434342d3535353535353535353535350000002461616161616161612d626262622d346363632d386464642d656565656565656565656565000000086465766963652d31000000086465766963652d32000000013000000001310000004038613339626538363166663831336333373162643662393632366336343434346330383539393863366438313466653364333763303361623564326139386434'
const SIGNED_SHA256 = 'e7949343092f950a412b06c3b65323eed0082bcb83f915e2fb85b2c3734a7d81'
const AUTH =
  'f8H1amJ/lozZnP14jcVPhSxfyYmo6CmoPeO5v2gr0G2UcGOFFdI74bo0z4Zv3L29JVKSeMX7uORUpnTvAQ2JCw=='

test.describe('multisig envelope signing', () => {
  test('payload hash and canonical bytes match the vector', () => {
    expect(envelopePayloadHash(HEAD.encrypted_payload)).toBe(PAYLOAD_HASH)
    expect(bytesToHex(canonicalEnvelopeBytes({ ...HEAD, payload_hash: PAYLOAD_HASH }))).toBe(
      CANONICAL_HEX
    )
  })

  test('signs exactly like the vector and verifies with the raw public key', async () => {
    const keys = await importEd25519Seed(SPEC_SEED)
    const envelope = await signEnvelope(keys.privateKey, HEAD)
    expect(envelope.payload_hash).toBe(PAYLOAD_HASH)
    expect(envelope.authentication_data).toBe(AUTH)
    const context = new TextEncoder().encode(ENVELOPE_SIGNATURE_CONTEXT)
    const canonical = canonicalEnvelopeBytes(envelope)
    const signed = new Uint8Array(context.length + canonical.length)
    signed.set(context)
    signed.set(canonical, context.length)
    expect(bytesToHex(sha256(signed))).toBe(SIGNED_SHA256)
    expect(await verifyEnvelope(envelope, hexToBytes(EXAMPLE_ED))).toBe(true)
  })

  test('any changed byte fails verification', async () => {
    const keys = await importEd25519Seed(SPEC_SEED)
    const envelope = await signEnvelope(keys.privateKey, HEAD)
    const publicKey = hexToBytes(EXAMPLE_ED)
    const tampered = [
      { ...envelope, recipient_id: 'device-3' },
      { ...envelope, sequence: 2 },
      { ...envelope, encrypted_payload: '{"identityPublicKey":"AA==","x":2}' },
      { ...envelope, payload_hash: `0${envelope.payload_hash.slice(1)}` },
      { ...envelope, authentication_data: 'not base64!' }
    ]
    for (const bad of tampered) {
      expect(await verifyEnvelope(bad, publicKey)).toBe(false)
    }
    expect(await verifyEnvelope(envelope, publicKey.subarray(1))).toBe(false)
  })

  test('the signer counts sequence across recipients', async () => {
    const keys = await importEd25519Seed(SPEC_SEED)
    const signer = createEnvelopeSigner({
      groupId: 'g',
      sessionId: 's',
      senderId: 'device-1',
      signingKey: keys.privateKey
    })
    const a = await signer.next('PAIR_INVITE', 'device-2')
    const b = await signer.next('PAIR_INVITE', 'device-3')
    expect([a.sequence, b.sequence]).toEqual([1, 2])
    expect(a.round).toBe(0)
    expect(a.encrypted_payload).toBe('{}')
    expect(await verifyEnvelope(b, hexToBytes(EXAMPLE_ED))).toBe(true)
  })
})
