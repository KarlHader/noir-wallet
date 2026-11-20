import { test } from 'node:test'
import { expect } from '@playwright/test'
import { UR, URDecoder } from '@ngraveio/bc-ur'
import { createEnvelopeFactory, parseEnvelope } from '../../../src/core/multisig/messages'
import {
  createEnvelopeUREncoder,
  decodeCborByteString,
  encodeEnvelopesUR,
  decodeEnvelopeUR,
  encodeCborByteString,
  encodeEnvelopeUR,
  MULTISIG_UR_TYPE
} from '../../../src/lib/multisig-ur'

const envelope = createEnvelopeFactory({
  groupId: 'group-1',
  sessionId: 'session-1',
  senderId: 'device-1'
})('DKG_R1', 'device-2', { commitment: 'a'.repeat(120), note: 'héllo ✓' })

test.describe('multisig ur', () => {
  test('encodes two envelopes as a JSON array and decodeEnvelopeUR rejects an array', () => {
    const ur = encodeEnvelopesUR([envelope, envelope])
    const bytes = decodeCborByteString(ur.cbor)
    expect(bytes).not.toBeNull()
    const parsed = JSON.parse(new TextDecoder().decode(bytes!)) as unknown[]
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(2)
    for (const item of parsed) expect(parseEnvelope(item)).not.toBeNull()
    expect(decodeEnvelopeUR(ur)).toBeNull()
  })

  test('decodeEnvelopeUR rejects an array', () => {
    const json = new TextEncoder().encode(JSON.stringify([envelope]))
    expect(decodeEnvelopeUR(new UR(encodeCborByteString(json), MULTISIG_UR_TYPE))).toBeNull()
  })

  test('refuses zero and nine envelopes', () => {
    expect(() => encodeEnvelopesUR([])).toThrow(RangeError)
    expect(() => encodeEnvelopesUR(Array(9).fill(envelope))).toThrow(RangeError)
    expect(() => encodeEnvelopesUR(Array(8).fill(envelope))).not.toThrow()
  })

  test('a single envelope still encodes as an object', () => {
    const bytes = decodeCborByteString(encodeEnvelopesUR([envelope]).cbor)
    expect(JSON.parse(new TextDecoder().decode(bytes!))).toEqual(envelope)
    expect(new TextDecoder().decode(bytes!)).toBe(JSON.stringify(envelope))
  })

  test('envelope survives UR encode → fragment → decode', () => {
    const encoder = createEnvelopeUREncoder(envelope, 50)
    // A single-frame result would let a broken fragment path pass unnoticed.
    expect(encoder.fragmentsLength).toBeGreaterThan(1)
    const decoder = new URDecoder()
    // Bounded so a decoder that never completes fails the test instead of hanging it.
    for (let i = 0; i < encoder.fragmentsLength * 3 && !decoder.isComplete(); i++) {
      decoder.receivePart(encoder.nextPart())
    }
    expect(decoder.isSuccess()).toBe(true)
    expect(decodeEnvelopeUR(decoder.resultUR())).toEqual(envelope)
  })

  test('encodeEnvelopeUR yields a ur:bytes UR that decodes back', () => {
    const ur = encodeEnvelopeUR(envelope)
    expect(ur.type).toBe(MULTISIG_UR_TYPE)
    expect(decodeEnvelopeUR(ur)).toEqual(envelope)
  })

  test('rejects non-bytes UR', () => {
    expect(decodeEnvelopeUR(new UR(Buffer.from([0x41, 0x00]), 'zcash-pczt'))).toBeNull()
  })

  test('rejects bytes that are not a valid envelope', () => {
    const notAnEnvelope = new UR(encodeCborByteString(Buffer.from('{"x":1}')), 'bytes')
    expect(decodeEnvelopeUR(notAnEnvelope)).toBeNull()
    const notJson = new UR(encodeCborByteString(Buffer.from('not json')), 'bytes')
    expect(decodeEnvelopeUR(notJson)).toBeNull()
    const notUtf8 = new UR(encodeCborByteString(Buffer.from([0xff, 0xfe, 0xfd])), 'bytes')
    expect(decodeEnvelopeUR(notUtf8)).toBeNull()
  })

  test('byte string headers follow RFC 8949 and reject other CBOR shapes', () => {
    const headers: Array<[number, number[]]> = [
      [0, [0x40]],
      [23, [0x57]],
      [24, [0x58, 24]],
      [255, [0x58, 0xff]],
      [256, [0x59, 0x01, 0x00]],
      [65535, [0x59, 0xff, 0xff]],
      [65536, [0x5a, 0x00, 0x01, 0x00, 0x00]]
    ]
    for (const [length, header] of headers) {
      const bytes = new Uint8Array(length).fill(7)
      const cbor = encodeCborByteString(bytes)
      expect([...cbor.subarray(0, header.length)]).toEqual(header)
      expect(cbor.length).toBe(header.length + length)
      expect(decodeCborByteString(cbor)).toEqual(bytes)
    }

    // Text string, map, truncated body, trailing bytes and empty input are not byte strings.
    expect(decodeCborByteString(Buffer.from([0x61, 0x61]))).toBeNull()
    expect(decodeCborByteString(Buffer.from([0xa1, 0x01, 0x41, 0x00]))).toBeNull()
    expect(decodeCborByteString(Buffer.from([0x42, 0x00]))).toBeNull()
    expect(decodeCborByteString(Buffer.from([0x41, 0x00, 0x00]))).toBeNull()
    expect(decodeCborByteString(Buffer.from([0x58]))).toBeNull()
    expect(decodeCborByteString(Buffer.alloc(0))).toBeNull()
  })
})
