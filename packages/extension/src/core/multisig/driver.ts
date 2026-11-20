import type { CreateSessionEffect, CreateSessionEvent } from './create-session'
import type { MultisigTransportKind } from './types'

/**
 * Carries out the session reducer's effects over one transport and reports what happens back as
 * events. Bluetooth sends and receives messages directly; QR turns sends into codes to display and
 * waits into scans. Pages never talk to a driver, so a real transport can replace a mock one
 * without touching them.
 */
export interface SessionDriver {
  readonly kind: MultisigTransportKind
  execute(effect: CreateSessionEffect, dispatch: (event: CreateSessionEvent) => void): void
  dispose(): void
}
