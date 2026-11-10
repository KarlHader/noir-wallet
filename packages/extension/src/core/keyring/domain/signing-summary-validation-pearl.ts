import type { PearlBip322MessageSummary, PearlPsbtSummary, SigningSummary } from './signing-summary'
import { parseBitcoinSummary } from './signing-summary-validation-bitcoin'
import type { ParsedSigningSummaryEnvelope } from './signing-summary-validation'

export function parsePearlSummary(envelope: ParsedSigningSummaryEnvelope): SigningSummary {
  if (envelope.schema === 'pearl.psbt.v1') {
    const bitcoin = parseBitcoinSummary({
      ...envelope,
      schema: 'bitcoin.psbt.v1'
    })
    return Object.freeze({
      ...bitcoin,
      schema: 'pearl.psbt.v1'
    }) as PearlPsbtSummary
  }
  if (envelope.schema === 'pearl.bip322-message.v1') {
    const bitcoin = parseBitcoinSummary({
      ...envelope,
      schema: 'bitcoin.bip322-message.v1'
    })
    return Object.freeze({
      ...bitcoin,
      schema: 'pearl.bip322-message.v1'
    }) as PearlBip322MessageSummary
  }
  throw new Error('Signing summary schema is not valid for Pearl')
}
