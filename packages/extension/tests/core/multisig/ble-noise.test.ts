import { test } from 'node:test'
import { expect } from '@playwright/test'
import { NoiseInitiator, NoiseError } from '../../../src/core/multisig/ble/noise'
import { pairingSas } from '../../../src/core/multisig/ble/sas'
import { bytesToHex, hexToBytes } from '../../../src/lib/bytes'

// Contract-side fixed handshake vectors (the iOS noir-core test pins the same bytes). The
// extension is the initiator: static 0x11, ephemeral 0x33; the phone is static 0x22, ephemeral 0x44.
const PROLOGUE = new TextEncoder().encode('noir/pair/v1')
const hex = (s: string) => hexToBytes(s.replace(/\s+/g, ''))

const MSG1 = '7b0d47d93427f8311160781c7c733fd89f88970aef490d8aa0ee19a4cb8a1b14'
const CASES = [
  {
    name: 'empty payloads',
    responderPayload: '',
    initiatorPayload: '',
    msg2: 'ff2ee45601ec1b67310c7790404585ae697331eee1c1f8cf2419731c1fff3e6b e4b2ed560b9e34baa5e6b14cf3867fb15797dcfc422f9fd1cc48da4363ae2805 dc9eead879e14b5242925c8b9368db182ce37c186a61eefc94102e20486c0627',
    msg3: 'e96c1d31e3e3342fd97aaa674b61e3ecd778cfa8814c6b65dceca56e8b154edc 5669683dc77c683f2b42ccdaad41a30e8838d27c5d777f34849644b5a7d7e905',
    hash: '1cf33b992be421257ba9213c0b5a2d1015611f4203cea5355601c5ed1bc5a55a',
    sas: '21298236'
  },
  {
    name: '65-byte identity payloads',
    responderPayload:
      '0152525252525252525252525252525252525252525252525252525252525252 520faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20',
    initiatorPayload:
      '0151515151515151515151515151515151515151515151515151515151515151 517b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13',
    msg2: 'ff2ee45601ec1b67310c7790404585ae697331eee1c1f8cf2419731c1fff3e6b e4b2ed560b9e34baa5e6b14cf3867fb15797dcfc422f9fd1cc48da4363ae2805 dc9eead879e14b5242925c8b9368db18098c92d6f07567432d61cba339f42b3a 4ef9b449826e3e55a9b3b39204d00f6b434cb38d7c4f2be6b36b8f23780db9f3 88de6e17360590ecdab1791042ba70e474964f36d3223056f5885936de0c23a72a',
    msg3: 'e96c1d31e3e3342fd97aaa674b61e3ecd778cfa8814c6b65dceca56e8b154edc 74e86c79cf6c804b5a7716526fd8affcd6835378012d8fbe371ad32aa96f964f 49c2183f7f625ed84cee4b3f7d2796988d1867de46594d2e8d8265f688477d54 a79e3efbd91b273ad30d39310203655247a7ecdf1a99036b12da111d37e61843 9e',
    hash: 'bb3bf8bedc1a90ac0d5dfe2066e5e32f804de5ad6dd20f75f9754fc0faf8a9fe',
    sas: '31364134'
  }
]

function initiator(prologue = PROLOGUE) {
  return new NoiseInitiator({
    staticSecret: new Uint8Array(32).fill(0x11),
    ephemeralSecret: new Uint8Array(32).fill(0x33),
    prologue
  })
}

for (const c of CASES) {
  test(`noise initiator reproduces the contract-side vector: ${c.name}`, () => {
    const noise = initiator()
    expect(bytesToHex(noise.writeMessage1())).toBe(MSG1)
    expect(bytesToHex(noise.readMessage2(hex(c.msg2)))).toBe(bytesToHex(hex(c.responderPayload)))
    expect(bytesToHex(noise.writeMessage3(hex(c.initiatorPayload)))).toBe(bytesToHex(hex(c.msg3)))
    expect(bytesToHex(noise.getHandshakeHash())).toBe(c.hash)
    expect(bytesToHex(noise.getRemoteStatic())).toBe(
      '0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20'
    )
    // Transport ciphertext of the first message in each direction.
    expect(bytesToHex(noise.encrypt(new TextEncoder().encode('commitments')))).toBe(
      '858e215a985e12972c11b001a4a2b83299184e898a41898f375ab9'
    )
    expect(
      new TextDecoder().decode(noise.decrypt(hex('029c2c1690434fa1094cc3fac9cdd11fdbb2f30f27')))
    ).toBe('share')
    expect(pairingSas(noise.getHandshakeHash())).toBe(c.sas)
  })
}

test('a different prologue cannot read the phone message 2', () => {
  const noise = initiator(new TextEncoder().encode('noir/pair/v2'))
  noise.writeMessage1()
  expect(() => noise.readMessage2(hex(CASES[1].msg2))).toThrow(NoiseError)
})

test('a failed handshake step kills the channel', () => {
  const noise = initiator()
  noise.writeMessage1()
  const bad = hex(CASES[1].msg2)
  bad[40] ^= 1
  expect(() => noise.readMessage2(bad)).toThrow(NoiseError)
  expect(() => noise.writeMessage3(new Uint8Array(0))).toThrow(NoiseError)
})

test('handshake calls out of order are refused', () => {
  const noise = initiator()
  expect(() => noise.readMessage2(hex(CASES[0].msg2))).toThrow(NoiseError)
})
