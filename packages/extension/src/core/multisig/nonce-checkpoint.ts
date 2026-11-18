import type { NoncePhase, SigningProgress, SigningStatus } from './signing-coordinator'

export interface NoncePersistenceRequest {
  ackId: string
  phase: NoncePhase
}
export interface NoncePersistenceAcknowledgement extends NoncePersistenceRequest {
  persisted: boolean
}
export interface SigningCheckpointProgress extends SigningProgress {
  persistence?: NoncePersistenceRequest
}

const UNAVAILABLE = 'Signing session is unavailable'
const phases: readonly NoncePhase[] = ['created', 'committed', 'consumed']
const copy = (progress: SigningCheckpointProgress): SigningCheckpointProgress => ({
  status: {
    ...progress.status,
    selectedSlots: [...progress.status.selectedSlots],
    committedSlots: [...progress.status.committedSlots],
    sharedSlots: [...progress.status.sharedSlots]
  },
  outbound: progress.outbound.map(envelope => ({ ...envelope })),
  ...(progress.persistence ? { persistence: { ...progress.persistence } } : {})
})

/** Suspends an engine callback while returning the exact durable checkpoint to Background. */
export class SigningNonceCheckpoint {
  private pending:
    | (NoncePersistenceRequest & { resolve: () => void; reject: (error: Error) => void })
    | null = null
  private activeKey: string | null = null
  private result: SigningProgress | null = null
  private closed = false
  private phaseIndex = -1
  private readonly acknowledgements = new Map<
    string,
    { phase: NoncePhase; result: Promise<SigningCheckpointProgress> }
  >()
  private readonly waiters = new Set<{
    resolve: (value: SigningCheckpointProgress) => void
    reject: (error: Error) => void
  }>()

  constructor(private readonly status: () => SigningStatus) {}

  persist(phase: NoncePhase): Promise<void> {
    if (this.closed || !this.activeKey || this.pending || phases[this.phaseIndex + 1] !== phase)
      return Promise.reject(new Error(UNAVAILABLE))
    this.phaseIndex++
    return new Promise<void>((resolve, reject) => {
      this.pending = { ackId: crypto.randomUUID(), phase, resolve, reject }
      this.publish()
    })
  }

  run(key: string, operation: () => Promise<SigningProgress>): Promise<SigningCheckpointProgress> {
    if (this.closed) return Promise.reject(new Error(UNAVAILABLE))
    if (this.activeKey) {
      if (this.activeKey !== key)
        return Promise.reject(new Error('Signing operation is awaiting persistence'))
      return this.wait()
    }
    this.activeKey = key
    this.result = null
    const waiting = this.wait()
    Promise.resolve()
      .then(operation)
      .then(
        result => {
          if (this.closed) return
          this.result = copy(result)
          this.activeKey = null
          this.publish()
        },
        () => this.cancel()
      )
    return waiting
  }

  advance(ack: NoncePersistenceAcknowledgement): Promise<SigningCheckpointProgress> {
    if (this.closed) return Promise.reject(new Error(UNAVAILABLE))
    const repeated = this.acknowledgements.get(ack.ackId)
    if (repeated) {
      // The ACK token alone never grants a different phase or changes a failed write to success.
      if (!ack.persisted || ack.phase !== repeated.phase) {
        this.cancel()
        return Promise.reject(new Error(UNAVAILABLE))
      }
      return repeated.result.then(copy)
    }
    const pending = this.pending
    if (!pending || ack.ackId !== pending.ackId || ack.phase !== pending.phase || !ack.persisted) {
      this.cancel()
      return Promise.reject(new Error(UNAVAILABLE))
    }
    this.pending = null
    const waiting = this.wait()
    this.acknowledgements.set(ack.ackId, { phase: ack.phase, result: waiting })
    pending.resolve()
    return waiting.then(copy)
  }

  progress(): SigningCheckpointProgress {
    if (this.closed) throw new Error(UNAVAILABLE)
    if (this.pending)
      return copy({ status: this.status(), outbound: [], persistence: this.pending })
    return copy(this.result ?? { status: this.status(), outbound: [] })
  }

  cancel(): void {
    if (this.closed) return
    this.closed = true
    const pending = this.pending
    this.pending = null
    pending?.reject(new Error(UNAVAILABLE))
    for (const waiter of this.waiters) waiter.reject(new Error(UNAVAILABLE))
    this.waiters.clear()
    this.result = null
    this.acknowledgements.clear()
  }

  private wait(): Promise<SigningCheckpointProgress> {
    if (this.closed) return Promise.reject(new Error(UNAVAILABLE))
    if (this.pending || (!this.activeKey && this.result)) return Promise.resolve(this.progress())
    return new Promise((resolve, reject) => this.waiters.add({ resolve, reject }))
  }

  private publish(): void {
    for (const waiter of this.waiters) waiter.resolve(this.progress())
    this.waiters.clear()
  }
}
