import { concatBytes } from '@noble/hashes/utils'
import { parseIdentityPublicKey } from '../identity'
import type { DeviceIdentity } from '../identity'
import { FrameError, FrameReassembler, MAX_SENT_FRAME_SIZE, splitMessage } from './frame'
import type { FrameLink, FrameLinkHandlers } from './link'
import { NoiseError, NoiseInitiator } from './noise'
import type { NoiseKeyPair } from './noise'
import { pairingSas } from './sas'

/** The prologue both sides feed into the handshake; any difference makes it fail. */
export const NOISE_PROLOGUE = new TextEncoder().encode('noir/pair/v1')
/** Recovery handshakes cannot be confused with pairing handshakes. */
export const RECOVER_NOISE_PROLOGUE = new TextEncoder().encode('noir/recover/v1')
const BIND_CONTEXT = new TextEncoder().encode('NoirDeviceSig v1|noir.transport.bind.v1|')
const ROLE_INITIATOR = 1
const ROLE_RESPONDER = 0

export type ChannelFailure =
  | 'closed'
  | 'timeout'
  | 'handshake'
  | 'identity_binding'
  | 'frame'
  | 'decrypt'

export class ChannelError extends Error {
  constructor(readonly reason: ChannelFailure) {
    super(`secure channel: ${reason}`)
    this.name = 'ChannelError'
  }
}

export interface SecureChannel {
  /** The 8-digit code both screens show; the user compares them. */
  readonly sas: string
  /** The phone's 65-byte identity public key, as it showed it in the handshake. */
  readonly peerIdentity: Uint8Array
  /** The phone's X25519 static key from the handshake. */
  readonly remoteStatic: Uint8Array
  send(message: Uint8Array): Promise<void>
  /** Resolves with the next decrypted message; rejects when the channel ends. */
  receive(): Promise<Uint8Array>
  close(): void
}

export interface ChannelOptions {
  identity: DeviceIdentity
  noiseStatic: NoiseKeyPair
  /** Defaults to the pairing prologue. */
  prologue?: Uint8Array
  /** Tests only. */
  ephemeralSecret?: Uint8Array
  handshakeTimeoutMs?: number
  subtle?: SubtleCrypto
  signal?: AbortSignal
}

/** The bytes both identity signatures cover: the context, the handshake, the signer's static key. */
export function bindingMessage(
  handshakeHash: Uint8Array,
  signerNoiseStatic: Uint8Array,
  role: typeof ROLE_INITIATOR | typeof ROLE_RESPONDER
): Uint8Array {
  return concatBytes(BIND_CONTEXT, handshakeHash, signerNoiseStatic, Uint8Array.of(role))
}

/** A byte stream that hands frames to whoever is waiting, in arrival order. */
class Inbox<T> {
  private readonly items: T[] = []
  private waiter: { resolve: (item: T) => void; reject: (error: Error) => void } | null = null
  private failure: Error | null = null

  push(item: T): void {
    if (this.failure) return
    if (this.waiter) {
      const { resolve } = this.waiter
      this.waiter = null
      resolve(item)
    } else {
      this.items.push(item)
    }
  }

  fail(error: Error): void {
    this.failure ??= error
    this.items.length = 0
    if (this.waiter) {
      const { reject } = this.waiter
      this.waiter = null
      reject(this.failure)
    }
  }

  next(): Promise<T> {
    const item = this.items.shift()
    if (item !== undefined) return Promise.resolve(item)
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject }
    })
  }
}

/**
 * Opens the link, runs the initiator side of the pairing handshake and the identity binding, and
 * returns the encrypted channel. `openLink` receives the handlers that must be wired to the
 * link's frames and closing; frames that arrive during the handshake are queued, not lost.
 */
export async function connectSecureChannel(
  openLink: (handlers: FrameLinkHandlers) => Promise<FrameLink>,
  options: ChannelOptions
): Promise<SecureChannel> {
  const controller = new AbortController()
  let rejectAbort: (error: ChannelError) => void = () => {}
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  const onAbort = () => {
    controller.abort()
    rejectAbort(new ChannelError('closed'))
  }
  const detachAbort = () => options.signal?.removeEventListener('abort', onAbort)
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted) onAbort()
  const timer = setTimeout(() => {
    rejectAbort(new ChannelError('timeout'))
    controller.abort()
  }, options.handshakeTimeoutMs ?? 20_000)
  try {
    return await Promise.race([
      openSecureChannel(openLink, { ...options, signal: controller.signal }, detachAbort),
      cancelled
    ])
  } catch (error) {
    detachAbort()
    throw error
  } finally {
    // Acquisition has ended; the caller still owns the established channel until it closes.
    clearTimeout(timer)
  }
}

async function openSecureChannel(
  openLink: (handlers: FrameLinkHandlers) => Promise<FrameLink>,
  options: ChannelOptions,
  onChannelClosed: () => void
): Promise<SecureChannel> {
  const subtle = options.subtle ?? crypto.subtle
  const inbox = new Inbox<Uint8Array>()
  const reassembler = new FrameReassembler()
  let closed = false
  let messageId = 0
  let link: FrameLink | null = null

  const fail = (reason: ChannelFailure) => {
    onChannelClosed()
    closed = true
    inbox.fail(new ChannelError(reason))
  }
  const onAbort = () => {
    fail('closed')
    link?.close()
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted) {
    options.signal.removeEventListener('abort', onAbort)
    throw new ChannelError('closed')
  }
  const handlers: FrameLinkHandlers = {
    signal: options.signal,
    onFrame(frame) {
      if (closed) return
      try {
        const progress = reassembler.accept(frame)
        if (progress.kind === 'complete') inbox.push(progress.data)
      } catch (error) {
        // A damaged or contradictory stream ends the session; it is not worth repairing.
        if (error instanceof FrameError) {
          fail('frame')
          link?.close()
        }
      }
    },
    onClosed() {
      options.signal?.removeEventListener('abort', onAbort)
      fail('closed')
    }
  }
  try {
    link = await openLink(handlers)
    if (closed) {
      link.close()
      throw new ChannelError('closed')
    }
  } catch {
    options.signal?.removeEventListener('abort', onAbort)
    fail('closed')
    throw new ChannelError('closed')
  }
  const opened = link

  const sendRaw = async (message: Uint8Array) => {
    if (closed) throw new ChannelError('closed')
    const id = messageId
    messageId = (messageId + 1) & 0xffff
    for (const frame of splitMessage(message, id, MAX_SENT_FRAME_SIZE)) await opened.send(frame)
  }

  const noise = new NoiseInitiator({
    staticSecret: options.noiseStatic.secret,
    prologue: options.prologue ?? NOISE_PROLOGUE,
    ephemeralSecret: options.ephemeralSecret
  })

  let peerIdentity: Uint8Array
  let remoteStatic: Uint8Array
  let sas: string
  try {
    await (async () => {
      await sendRaw(noise.writeMessage1())
      const payload = noise.readMessage2(await inbox.next())
      const parsed = parseIdentityPublicKey(payload)
      if (!parsed) throw new NoiseError('responder identity missing')
      peerIdentity = parsed.bytes
      await sendRaw(noise.writeMessage3(options.identity.publicKey))

      // Identity binding: each side proves it holds the key it showed in the handshake. The
      // initiator speaks first.
      const hash = noise.getHandshakeHash()
      const mine = bindingMessage(hash, noise.getLocalStatic(), ROLE_INITIATOR)
      const signature = new Uint8Array(
        await subtle.sign(
          { name: 'Ed25519' },
          options.identity.signingKeys.privateKey,
          mine as BufferSource
        )
      )
      await sendRaw(noise.encrypt(signature))
      const theirs = noise.decrypt(await inbox.next())
      const theirMessage = bindingMessage(hash, noise.getRemoteStatic(), ROLE_RESPONDER)
      const key = await subtle.importKey(
        'raw',
        parsed.ed25519 as BufferSource,
        { name: 'Ed25519' },
        true,
        ['verify']
      )
      if (
        !(await subtle.verify(
          { name: 'Ed25519' },
          key,
          theirs as BufferSource,
          theirMessage as BufferSource
        ))
      ) {
        throw new ChannelError('identity_binding')
      }
      remoteStatic = noise.getRemoteStatic()
      sas = pairingSas(hash)
    })()
  } catch (error) {
    options.signal?.removeEventListener('abort', onAbort)
    fail('handshake')
    opened.close()
    if (error instanceof ChannelError) throw error
    throw new ChannelError(error instanceof NoiseError ? 'handshake' : 'closed')
  }

  return {
    sas: sas!,
    peerIdentity: peerIdentity!,
    remoteStatic: remoteStatic!,
    async send(message) {
      await sendRaw(noise.encrypt(message))
    },
    async receive() {
      const sealed = await inbox.next()
      try {
        return noise.decrypt(sealed)
      } catch {
        fail('decrypt')
        opened.close()
        throw new ChannelError('decrypt')
      }
    },
    close() {
      options.signal?.removeEventListener('abort', onAbort)
      if (!closed) fail('closed')
      opened.close()
    }
  }
}
