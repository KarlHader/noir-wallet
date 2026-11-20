import { chacha20poly1305 } from '@noble/ciphers/chacha'
import { x25519 } from '@noble/curves/ed25519'
import { blake2s } from '@noble/hashes/blake2s'
import { hmac } from '@noble/hashes/hmac'
import { randomBytes } from '@noble/hashes/utils'

/**
 * Noise_XX_25519_ChaChaPoly_BLAKE2s, written against the Noise specification (revision 34).
 * The extension is the initiator and the phone the responder. WebCrypto has no BLAKE2s, so the
 * primitives come from @noble. Byte-for-byte agreement with the phone's `snow` implementation is
 * pinned by the contract-side vectors in tests/core/multisig/ble-noise.test.ts.
 */

const PROTOCOL_NAME = 'Noise_XX_25519_ChaChaPoly_BLAKE2s'
const DH_LEN = 32
const TAG_LEN = 16
const MAX_NOISE_MESSAGE = 65535

export class NoiseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NoiseError'
  }
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const hash = (data: Uint8Array): Uint8Array => blake2s(data)

// HKDF from the Noise spec, built on HMAC-BLAKE2s. Two outputs are all the protocol uses.
function hkdf2(chainingKey: Uint8Array, input: Uint8Array): [Uint8Array, Uint8Array] {
  const tempKey = hmac(blake2s, chainingKey, input)
  const out1 = hmac(blake2s, tempKey, Uint8Array.of(1))
  const out2 = hmac(blake2s, tempKey, concat(out1, Uint8Array.of(2)))
  return [out1, out2]
}

// 4 zero bytes followed by the 64-bit little-endian counter.
function nonceFor(counter: bigint): Uint8Array {
  const nonce = new Uint8Array(12)
  new DataView(nonce.buffer).setBigUint64(4, counter, true)
  return nonce
}

class CipherState {
  private counter = 0n

  constructor(private key: Uint8Array | null = null) {}

  hasKey(): boolean {
    return this.key !== null
  }

  encrypt(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!this.key) return plaintext
    const sealed = chacha20poly1305(this.key, nonceFor(this.counter), ad).encrypt(plaintext)
    this.counter += 1n
    return sealed
  }

  decrypt(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!this.key) return ciphertext
    let plain: Uint8Array
    try {
      plain = chacha20poly1305(this.key, nonceFor(this.counter), ad).decrypt(ciphertext)
    } catch {
      throw new NoiseError('decryption failed')
    }
    this.counter += 1n
    return plain
  }
}

export interface NoiseKeyPair {
  secret: Uint8Array
  public: Uint8Array
}

export function generateNoiseStatic(): NoiseKeyPair {
  const secret = randomBytes(DH_LEN)
  return { secret, public: x25519.getPublicKey(secret) }
}

export interface NoiseInitiatorOptions {
  staticSecret: Uint8Array
  prologue: Uint8Array
  /** Tests only: fixes the ephemeral key so the whole handshake is a pure function of its inputs. */
  ephemeralSecret?: Uint8Array
}

type Stage = 'write1' | 'read2' | 'write3' | 'done' | 'dead'

/**
 * The initiator side of one handshake, then of the transport it yields. Calls must follow the
 * XX order: write, read, write. Any failure kills the channel for good.
 */
export class NoiseInitiator {
  private readonly staticKey: NoiseKeyPair
  private readonly ephemeral: NoiseKeyPair
  private chainingKey: Uint8Array
  private handshakeHash: Uint8Array
  private cipher = new CipherState()
  private remoteEphemeral: Uint8Array | null = null
  private remoteStaticKey: Uint8Array | null = null
  private stage: Stage = 'write1'
  private send: CipherState | null = null
  private receive: CipherState | null = null

  constructor(options: NoiseInitiatorOptions) {
    if (options.staticSecret.length !== DH_LEN)
      throw new NoiseError('static secret must be 32 bytes')
    this.staticKey = {
      secret: options.staticSecret,
      public: x25519.getPublicKey(options.staticSecret)
    }
    const ephemeralSecret = options.ephemeralSecret ?? randomBytes(DH_LEN)
    this.ephemeral = { secret: ephemeralSecret, public: x25519.getPublicKey(ephemeralSecret) }
    // The protocol name is longer than the hash, so it is hashed rather than padded.
    const name = new TextEncoder().encode(PROTOCOL_NAME)
    this.handshakeHash =
      name.length <= DH_LEN ? concat(name, new Uint8Array(DH_LEN - name.length)) : hash(name)
    this.chainingKey = this.handshakeHash
    this.mixHash(options.prologue)
  }

  /** Message 1: `e`. XX carries no payload here. */
  writeMessage1(): Uint8Array {
    this.expect('write1')
    return this.guard(() => {
      this.mixHash(this.ephemeral.public)
      const message = concat(this.ephemeral.public, this.encryptAndHash(new Uint8Array(0)))
      this.stage = 'read2'
      return message
    })
  }

  /** Message 2: `e, ee, s, es`. Returns the responder's payload. */
  readMessage2(message: Uint8Array): Uint8Array {
    this.expect('read2')
    return this.guard(() => {
      if (message.length > MAX_NOISE_MESSAGE) throw new NoiseError('message too long')
      let offset = 0
      const re = take(message, offset, DH_LEN)
      offset += DH_LEN
      this.remoteEphemeral = re
      this.mixHash(re)
      this.mixKey(x25519.getSharedSecret(this.ephemeral.secret, re))
      const sealedStatic = take(message, offset, DH_LEN + TAG_LEN)
      offset += DH_LEN + TAG_LEN
      const rs = this.decryptAndHash(sealedStatic)
      this.remoteStaticKey = rs
      this.mixKey(x25519.getSharedSecret(this.ephemeral.secret, rs))
      const payload = this.decryptAndHash(message.subarray(offset))
      this.stage = 'write3'
      return payload
    })
  }

  /** Message 3: `s, se`, carrying `payload`. Finishes the handshake. */
  writeMessage3(payload: Uint8Array): Uint8Array {
    this.expect('write3')
    return this.guard(() => {
      const re = this.remoteEphemeral
      if (!re) throw new NoiseError('handshake out of order')
      const sealedStatic = this.encryptAndHash(this.staticKey.public)
      this.mixKey(x25519.getSharedSecret(this.staticKey.secret, re))
      const message = concat(sealedStatic, this.encryptAndHash(payload))
      if (message.length > MAX_NOISE_MESSAGE) throw new NoiseError('message too long')
      const [first, second] = hkdf2(this.chainingKey, new Uint8Array(0))
      this.send = new CipherState(first)
      this.receive = new CipherState(second)
      this.stage = 'done'
      return message
    })
  }

  /** The hash both sides agree on; the SAS and the identity binding are derived from it. */
  getHandshakeHash(): Uint8Array {
    this.expect('done')
    return this.handshakeHash
  }

  /** The responder's X25519 static public key, read from message 2. */
  getRemoteStatic(): Uint8Array {
    if (!this.remoteStaticKey) throw new NoiseError('handshake not finished')
    return this.remoteStaticKey
  }

  getLocalStatic(): Uint8Array {
    return this.staticKey.public
  }

  encrypt(plaintext: Uint8Array): Uint8Array {
    this.expect('done')
    return this.guard(() => {
      if (plaintext.length + TAG_LEN > MAX_NOISE_MESSAGE) throw new NoiseError('message too long')
      return this.send!.encrypt(new Uint8Array(0), plaintext)
    })
  }

  decrypt(ciphertext: Uint8Array): Uint8Array {
    this.expect('done')
    return this.guard(() => {
      if (ciphertext.length > MAX_NOISE_MESSAGE) throw new NoiseError('message too long')
      return this.receive!.decrypt(new Uint8Array(0), ciphertext)
    })
  }

  private expect(stage: Stage): void {
    if (this.stage !== stage) throw new NoiseError('handshake out of order')
  }

  private guard<T>(run: () => T): T {
    try {
      return run()
    } catch (error) {
      this.stage = 'dead'
      throw error instanceof NoiseError ? error : new NoiseError('handshake failed')
    }
  }

  private mixHash(data: Uint8Array): void {
    this.handshakeHash = hash(concat(this.handshakeHash, data))
  }

  private mixKey(input: Uint8Array): void {
    const [chainingKey, key] = hkdf2(this.chainingKey, input)
    this.chainingKey = chainingKey
    this.cipher = new CipherState(key)
  }

  private encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const sealed = this.cipher.encrypt(this.handshakeHash, plaintext)
    this.mixHash(sealed)
    return sealed
  }

  private decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plain = this.cipher.decrypt(this.handshakeHash, ciphertext)
    this.mixHash(ciphertext)
    return plain
  }
}

function take(data: Uint8Array, offset: number, length: number): Uint8Array {
  if (data.length < offset + length) throw new NoiseError('handshake message too short')
  return data.subarray(offset, offset + length)
}
