import { hexToBytes } from '@/lib/bytes'
import {
  type QuantusRuntimeMetadata,
  type QuantusScaleValue,
  QuantusScaleReader,
  readQuantusScaleValue
} from './quantus-metadata'

export type QuantusExtrinsicOutcome = 'success' | 'failed' | 'unknown'

export interface DecodeQuantusExtrinsicOutcomeInput {
  readonly metadata: QuantusRuntimeMetadata
  /** Hex-encoded `System.Events` storage value for the inclusion block. */
  readonly eventsHex: string
  /** Zero-based index of the extrinsic inside the block body. */
  readonly extrinsicIndex: number
}

const MAXIMUM_EVENTS = 10_000

function readEventRecord(
  metadata: QuantusRuntimeMetadata,
  reader: QuantusScaleReader
): Readonly<{
  phase: QuantusScaleValue
  event: QuantusScaleValue
}> {
  const record = metadata.types.get(metadata.eventRecordType)
  if (!record || record.kind !== 'composite' || record.fields.length < 2) {
    throw new Error('Quantus EventRecord layout is unsupported')
  }
  const phase = readQuantusScaleValue(metadata, record.fields[0].type, reader)
  const event = readQuantusScaleValue(metadata, record.fields[1].type, reader)
  const values = record.fields.slice(2)
  for (const field of values) readQuantusScaleValue(metadata, field.type, reader)
  return Object.freeze({ phase, event })
}

function isApplyExtrinsic(phase: QuantusScaleValue): number | null {
  if (phase.kind !== 'variant' || phase.index !== 0 || phase.values.length !== 1) return null
  const value = phase.values[0]
  if (value.kind !== 'primitive') {
    const inner = value.kind === 'composite' ? value.values[0] : undefined
    if (!inner || inner.kind !== 'primitive') return null
    return Number(inner.value)
  }
  return Number(value.value)
}

function systemEventName(
  metadata: QuantusRuntimeMetadata,
  event: QuantusScaleValue
): string | null {
  if (event.kind !== 'variant' || event.index !== metadata.systemPalletIndex) return null
  const palletEvent = event.values[0]
  if (!palletEvent || palletEvent.kind !== 'variant') return null
  return palletEvent.name
}

/**
 * Reads `System.Events` for one extrinsic and reports whether it succeeded.
 * An unparsed, missing, or unrelated event stream returns `unknown`, which the
 * monitor treats as "not conclusive" instead of success.
 */
export function decodeQuantusExtrinsicOutcome(
  input: DecodeQuantusExtrinsicOutcomeInput
): QuantusExtrinsicOutcome {
  if (!Number.isSafeInteger(input.extrinsicIndex) || input.extrinsicIndex < 0) {
    throw new Error('Invalid Quantus extrinsic index')
  }
  if (typeof input.eventsHex !== 'string' || !/^0x(?:[0-9a-f]{2})*$/.test(input.eventsHex)) {
    throw new Error('Quantus events must be hex')
  }
  const reader = new QuantusScaleReader(hexToBytes(input.eventsHex))
  const count = reader.compact()
  if (count > MAXIMUM_EVENTS) throw new Error('Quantus event list is too long')
  let outcome: QuantusExtrinsicOutcome = 'unknown'
  for (let index = 0; index < count; index += 1) {
    const record = readEventRecord(input.metadata, reader)
    if (isApplyExtrinsic(record.phase) !== input.extrinsicIndex) continue
    const name = systemEventName(input.metadata, record.event)
    if (name === 'ExtrinsicSuccess') outcome = 'success'
    else if (name === 'ExtrinsicFailed') return 'failed'
  }
  return outcome
}
