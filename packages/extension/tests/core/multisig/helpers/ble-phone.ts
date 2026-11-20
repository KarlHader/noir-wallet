import { chacha20poly1305 } from '@noble/ciphers/chacha'
import { x25519 } from '@noble/curves/ed25519'
import { blake2s } from '@noble/hashes/blake2s'
import { hmac } from '@noble/hashes/hmac'
import { concatBytes } from '@noble/hashes/utils'
import { FrameReassembler, splitMessage } from '../../../../src/core/multisig/ble/frame'
import type { FrameLink, FrameLinkHandlers } from '../../../../src/core/multisig/ble/link'
import { bindingMessage, NOISE_PROLOGUE } from '../../../../src/core/multisig/ble/secure-channel'
import type { DeviceIdentity } from '../../../../src/core/multisig/identity'

// An independent responder written from the Noise specification, standing in for the phone.
const hash = (data: Uint8Array) => blake2s(data)
function hkdf2(ck: Uint8Array, input: Uint8Array): [Uint8Array, Uint8Array] {
  const temp = hmac(blake2s, ck, input)
  const out1 = hmac(blake2s, temp, Uint8Array.of(1))
  return [out1, hmac(blake2s, temp, concatBytes(out1, Uint8Array.of(2)))]
}
const nonce = (n: bigint) => {
  const out = new Uint8Array(12)
  new DataView(out.buffer).setBigUint64(4, n, true)
  return out
}

class Cipher {
  n = 0n
  constructor(public k: Uint8Array | null = null) {}
  seal(ad: Uint8Array, pt: Uint8Array) {
    if (!this.k) return pt
    return chacha20poly1305(this.k, nonce(this.n++), ad).encrypt(pt)
  }
  open(ad: Uint8Array, ct: Uint8Array) {
    if (!this.k) return ct
    return chacha20poly1305(this.k, nonce(this.n++), ad).decrypt(ct)
  }
}

export class TestResponder {
  h: Uint8Array
  ck: Uint8Array
  c = new Cipher()
  re!: Uint8Array
  rs!: Uint8Array
  send!: Cipher
  recv!: Cipher
  readonly handshakeHash: () => Uint8Array = () => this.h
  constructor(
    private s: { secret: Uint8Array; public: Uint8Array },
    private e: { secret: Uint8Array; public: Uint8Array },
    prologue: Uint8Array = NOISE_PROLOGUE
  ) {
    this.h = hash(new TextEncoder().encode('Noise_XX_25519_ChaChaPoly_BLAKE2s'))
    this.ck = this.h
    this.mixHash(prologue)
  }
  mixHash(d: Uint8Array) {
    this.h = hash(concatBytes(this.h, d))
  }
  mixKey(ikm: Uint8Array) {
    const [ck, k] = hkdf2(this.ck, ikm)
    this.ck = ck
    this.c = new Cipher(k)
  }
  readMessage1(msg: Uint8Array) {
    this.re = msg.slice(0, 32)
    this.mixHash(this.re)
    this.mixHash(msg.slice(32))
  }
  writeMessage2(payload: Uint8Array) {
    this.mixHash(this.e.public)
    this.mixKey(x25519.getSharedSecret(this.e.secret, this.re))
    const sealedS = this.c.seal(this.h, this.s.public)
    this.mixHash(sealedS)
    this.mixKey(x25519.getSharedSecret(this.s.secret, this.re))
    const sealedP = this.c.seal(this.h, payload)
    this.mixHash(sealedP)
    return concatBytes(this.e.public, sealedS, sealedP)
  }
  readMessage3(msg: Uint8Array) {
    const sealedS = msg.slice(0, 48)
    this.rs = this.c.open(this.h, sealedS)
    this.mixHash(sealedS)
    this.mixKey(x25519.getSharedSecret(this.e.secret, this.rs))
    const sealedP = msg.slice(48)
    const payload = this.c.open(this.h, sealedP)
    this.mixHash(sealedP)
    const [k1, k2] = hkdf2(this.ck, new Uint8Array(0))
    this.recv = new Cipher(k1)
    this.send = new Cipher(k2)
    return payload
  }
}

export interface FakePhoneOptions {
  identity: DeviceIdentity
  noiseStatic: { secret: Uint8Array; public: Uint8Array }
  ephemeral?: { secret: Uint8Array; public: Uint8Array }
  /** Sign the binding with a key that is not the identity's, to model an impostor. */
  bindingKey?: CryptoKey
  prologue?: Uint8Array
  /** Answers a decrypted application message; replies are sent back encrypted. */
  onMessage?: (message: Uint8Array) => Uint8Array[] | void
}

/** A phone on the other end of a frame link: speaks frames, Noise, and the identity binding. */
export function createFakePhone(options: FakePhoneOptions) {
  const ephemeralSecret =
    options.ephemeral?.secret ?? Uint8Array.from({ length: 32 }, (_, i) => 200 - i)
  const responder = new TestResponder(
    options.noiseStatic,
    { secret: ephemeralSecret, public: x25519.getPublicKey(ephemeralSecret) },
    options.prologue
  )
  const reassembler = new FrameReassembler()
  let handlers: FrameLinkHandlers | null = null
  let step = 0
  let outId = 0
  const received: Uint8Array[] = []
  const sentFrames: Uint8Array[] = []
  const state = { closed: false, bindingVerified: false, appMessages: [] as Uint8Array[] }

  const emit = (message: Uint8Array) => {
    for (const frame of splitMessage(message, outId++ & 0xffff, 100)) {
      sentFrames.push(frame)
      queueMicrotask(() => handlers?.onFrame(frame))
    }
  }

  async function onMessage(message: Uint8Array) {
    received.push(message)
    if (step === 0) {
      responder.readMessage1(message)
      emit(responder.writeMessage2(options.identity.publicKey))
    } else if (step === 1) {
      responder.readMessage3(message)
    } else if (step === 2) {
      const signature = responder.recv.open(new Uint8Array(0), message)
      const hashValue = responder.handshakeHash()
      const theirs = bindingMessage(hashValue, responder.rs, 1)
      state.bindingVerified = signature.length === 64 && theirs.length === 105
      const mine = bindingMessage(hashValue, options.noiseStatic.public, 0)
      const key = options.bindingKey ?? options.identity.signingKeys.privateKey
      const sig = new Uint8Array(
        await crypto.subtle.sign({ name: 'Ed25519' }, key, mine as BufferSource)
      )
      emit(responder.send.seal(new Uint8Array(0), sig))
    } else {
      const plain = responder.recv.open(new Uint8Array(0), message)
      state.appMessages.push(plain)
      for (const reply of options.onMessage?.(plain) ?? []) {
        emit(responder.send.seal(new Uint8Array(0), reply))
      }
    }
    step += 1
  }

  const link: FrameLink = {
    async send(frame) {
      const progress = reassembler.accept(frame)
      if (progress.kind === 'complete') await onMessage(progress.data)
    },
    close() {
      state.closed = true
      queueMicrotask(() => handlers?.onClosed())
    }
  }
  return {
    state,
    sentFrames,
    responder,
    /** Pushes a ciphertext to the extension as if the phone had sent an application message. */
    say(plain: Uint8Array) {
      emit(responder.send.seal(new Uint8Array(0), plain))
    },
    drop() {
      queueMicrotask(() => handlers?.onClosed())
    },
    open: async (h: FrameLinkHandlers): Promise<FrameLink> => {
      handlers = h
      return link
    }
  }
}
