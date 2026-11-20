import type { CreateSessionState } from '@/core/multisig/create-session'
import { buildQrCeremonySteps } from '@/core/multisig/qr-plan'
import type { VerifyStage } from '@/core/multisig/types'
import type { MultisigGroupScope } from '@/lib/multisig-group-storage'
import { MULTISIG_ROUTE_PREFIX, multisigTeamRoute } from '@/lib/multisig-tab'

const CREATE_ROUTE = `${MULTISIG_ROUTE_PREFIX}/create`
const CONNECT_ROUTE = `${CREATE_ROUTE}/connect`

export const CEREMONY_ROUTE = `${CREATE_ROUTE}/ceremony`

export function qrStepRoute(index: number | string): string {
  return `${CREATE_ROUTE}/qr/${index}`
}

export function verifyRoute(stage: VerifyStage): string {
  return `${CREATE_ROUTE}/verify?stage=${stage}`
}

/** Where an activated session goes: its account's team page, flagged as newly created. */
export function createdTeamRoute(scope: MultisigGroupScope): string {
  return `${multisigTeamRoute(scope)}&created=1`
}

/** The stages the verify page shows; the identity check is part of QR pairing instead. */
export type FingerprintStage = Exclude<VerifyStage, 'identity'>

/** A missing or unknown stage is the final check, the one every setup ends with. */
export function parseVerifyStage(value: string | null): FingerprintStage {
  return value === 'roster' || value === 'r1' ? value : 'final'
}

/**
 * The create-flow page that shows the session's current step once the roster is locked. The
 * ceremony, QR step and verify pages each compare it with their own route and move there when
 * they differ, so the session, never the URL, decides which step is on screen. Null for an
 * aborted session (the route guard owns that) and for a QR step index outside the plan.
 */
export function createFlowRoute(session: CreateSessionState): string | null {
  switch (session.phase) {
    case 'ABORTED':
      return null
    // QR pairing, the identity check included, stays on the connect page.
    case 'CREATED':
    case 'PAIRING':
    case 'ROSTER_LOCKED':
      return CONNECT_ROUTE
    // The verify page forwards an activated session to the team page.
    case 'ACTIVATED':
      return verifyRoute('final')
    case 'KEYSET_VERIFIED':
      // Over Bluetooth activation only happens on the verify page; over QR the shares and the
      // final confirmation still follow.
      return session.transportKind === 'ble' ? verifyRoute('final') : qrCeremonyRoute(session)
    case 'DKG_R1':
    case 'R1_VERIFIED':
    case 'DKG_R2':
    case 'FINALIZED':
      return session.transportKind === 'ble' ? CEREMONY_ROUTE : qrCeremonyRoute(session)
  }
}

// FINALIZED (the record is being saved) still sits on the round-2 scan step, so it routes there.
function qrCeremonyRoute(session: CreateSessionState): string | null {
  const index = session.qrCeremonyIndex
  const step = buildQrCeremonySteps(session.threshold)[index]
  if (!step) return null
  return step.kind === 'verify' ? verifyRoute(step.stage) : qrStepRoute(index)
}
