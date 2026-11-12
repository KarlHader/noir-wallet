import { hexToBytes } from '@/lib/bytes'

/**
 * Minimal, bounded SCALE reader for runtime metadata. Every read is range
 * checked, so a truncated or unexpected payload throws instead of returning a
 * guessed structure.
 */
export class QuantusScaleReader {
  private offset = 0

  constructor(private readonly bytes: Uint8Array) {
    if (!(bytes instanceof Uint8Array)) throw new Error('Quantus SCALE input must be bytes')
  }

  get position(): number {
    return this.offset
  }

  get remaining(): number {
    return this.bytes.byteLength - this.offset
  }

  u8(): number {
    this.require(1)
    return this.bytes[this.offset++]
  }

  u16(): number {
    this.require(2)
    const value = this.bytes[this.offset] | (this.bytes[this.offset + 1] << 8)
    this.offset += 2
    return value
  }

  u32(): number {
    this.require(4)
    const value =
      (this.bytes[this.offset] |
        (this.bytes[this.offset + 1] << 8) |
        (this.bytes[this.offset + 2] << 16) |
        (this.bytes[this.offset + 3] << 24)) >>>
      0
    this.offset += 4
    return value
  }

  bigUint(byteLength: number, label: string): bigint {
    this.require(byteLength)
    let value = 0n
    for (let index = byteLength - 1; index >= 0; index -= 1) {
      value = (value << 8n) | BigInt(this.bytes[this.offset + index])
    }
    this.offset += byteLength
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`Quantus SCALE ${label} exceeds the supported range`)
    }
    return value
  }

  compact(): number {
    const first = this.u8()
    const mode = first & 0b11
    if (mode === 0b00) return first >>> 2
    if (mode === 0b01) {
      const second = this.u8()
      return ((first >>> 2) | (second << 6)) >>> 0
    }
    if (mode === 0b10) {
      this.require(3)
      const value =
        (first >>> 2) |
        (this.bytes[this.offset] << 6) |
        (this.bytes[this.offset + 1] << 14) |
        (this.bytes[this.offset + 2] << 22)
      this.offset += 3
      return value >>> 0
    }
    const byteLength = (first >>> 2) + 4
    const value = this.bigUint(byteLength, 'compact value')
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('Quantus SCALE compact value exceeds the supported range')
    }
    return Number(value)
  }

  bytesOf(length: number): Uint8Array {
    this.require(length)
    const slice = this.bytes.subarray(this.offset, this.offset + length)
    this.offset += length
    return slice
  }

  string(maximumBytes = 4_096): string {
    const length = this.compact()
    if (length > maximumBytes) throw new Error('Quantus SCALE string is too long')
    const bytes = this.bytesOf(length)
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }

  private require(length: number): void {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      this.offset + length > this.bytes.byteLength
    ) {
      throw new Error('Quantus SCALE input is truncated')
    }
  }
}

const MAXIMUM_TYPES = 100_000
const MAXIMUM_PALLETS = 512
const MAXIMUM_VARIANTS = 1_024
const MAXIMUM_FIELDS = 1_024
const MAXIMUM_DOCS = 1_024

export interface QuantusScaleField {
  readonly name: string | null
  readonly type: number
}

export interface QuantusScaleVariant {
  readonly name: string
  readonly index: number
  readonly fields: readonly QuantusScaleField[]
}

export type QuantusScaleType =
  | Readonly<{ kind: 'composite'; fields: readonly QuantusScaleField[] }>
  | Readonly<{ kind: 'variant'; variants: readonly QuantusScaleVariant[] }>
  | Readonly<{ kind: 'sequence'; type: number }>
  | Readonly<{ kind: 'array'; length: number; type: number }>
  | Readonly<{ kind: 'tuple'; types: readonly number[] }>
  | Readonly<{ kind: 'primitive'; primitive: number }>
  | Readonly<{ kind: 'compact'; type: number }>
  | Readonly<{ kind: 'bitsequence'; bitStoreType: number; bitOrderType: number }>

export interface QuantusRuntimeMetadata {
  readonly version: number
  readonly types: ReadonlyMap<number, QuantusScaleType>
  readonly pallets: readonly Readonly<{ name: string; index: number; eventType: number | null }>[]
  /** Portable type of `EventRecord<RuntimeEvent, Hash>` used by `System.Events`. */
  readonly eventRecordType: number
  readonly systemPalletIndex: number
  readonly systemEventsType: number
}

function readDocs(reader: QuantusScaleReader): void {
  const count = reader.compact()
  if (count > MAXIMUM_DOCS) throw new Error('Quantus metadata docs list is too long')
  for (let index = 0; index < count; index += 1) reader.string()
}

function readFields(reader: QuantusScaleReader): readonly QuantusScaleField[] {
  const count = reader.compact()
  if (count > MAXIMUM_FIELDS) throw new Error('Quantus metadata field list is too long')
  const fields: QuantusScaleField[] = []
  for (let index = 0; index < count; index += 1) {
    const name = reader.u8() === 1 ? reader.string() : null
    const type = reader.compact()
    if (reader.u8() === 1) reader.string()
    readDocs(reader)
    fields.push(Object.freeze({ name, type }))
  }
  return Object.freeze(fields)
}

function readType(reader: QuantusScaleReader): QuantusScaleType {
  const segments = reader.compact()
  if (segments > MAXIMUM_FIELDS) throw new Error('Quantus metadata path is too long')
  for (let index = 0; index < segments; index += 1) reader.string()
  const parameters = reader.compact()
  if (parameters > MAXIMUM_FIELDS) throw new Error('Quantus metadata type parameters are too long')
  for (let index = 0; index < parameters; index += 1) {
    reader.string()
    if (reader.u8() === 1) reader.compact()
  }
  const tag = reader.u8()
  let type: QuantusScaleType
  switch (tag) {
    case 0:
      type = Object.freeze({ kind: 'composite' as const, fields: readFields(reader) })
      break
    case 1: {
      const count = reader.compact()
      if (count > MAXIMUM_VARIANTS) throw new Error('Quantus metadata variant list is too long')
      const variants: QuantusScaleVariant[] = []
      for (let index = 0; index < count; index += 1) {
        const name = reader.string()
        const fields = readFields(reader)
        const variantIndex = reader.u8()
        readDocs(reader)
        variants.push(Object.freeze({ name, index: variantIndex, fields }))
      }
      type = Object.freeze({ kind: 'variant' as const, variants: Object.freeze(variants) })
      break
    }
    case 2:
      type = Object.freeze({ kind: 'sequence' as const, type: reader.compact() })
      break
    case 3: {
      const length = reader.u32()
      type = Object.freeze({ kind: 'array' as const, length, type: reader.compact() })
      break
    }
    case 4: {
      const count = reader.compact()
      if (count > MAXIMUM_FIELDS) throw new Error('Quantus metadata tuple is too long')
      const types: number[] = []
      for (let index = 0; index < count; index += 1) types.push(reader.compact())
      type = Object.freeze({ kind: 'tuple' as const, types: Object.freeze(types) })
      break
    }
    case 5: {
      const primitive = reader.u8()
      if (primitive > 14) throw new Error('Quantus metadata primitive is unsupported')
      type = Object.freeze({ kind: 'primitive' as const, primitive })
      break
    }
    case 6:
      type = Object.freeze({ kind: 'compact' as const, type: reader.compact() })
      break
    case 7:
      type = Object.freeze({
        kind: 'bitsequence' as const,
        bitStoreType: reader.compact(),
        bitOrderType: reader.compact()
      })
      break
    default:
      throw new Error('Quantus metadata type definition is unsupported')
  }
  readDocs(reader)
  return type
}

function skipStorageEntry(reader: QuantusScaleReader): void {
  reader.string()
  reader.u8()
  const tag = reader.u8()
  if (tag === 0) {
    reader.compact()
  } else if (tag === 1) {
    const hashers = reader.compact()
    if (hashers > 8) throw new Error('Quantus metadata hasher list is unsupported')
    reader.bytesOf(hashers)
    reader.compact()
    reader.compact()
  } else if (tag === 2) {
    const hashers = reader.compact()
    if (hashers > 8) throw new Error('Quantus metadata hasher list is unsupported')
    reader.bytesOf(hashers)
    reader.compact()
    reader.compact()
    reader.compact()
  } else if (tag === 3) {
    const keys = reader.compact()
    if (keys > 8) throw new Error('Quantus metadata key list is unsupported')
    for (let index = 0; index < keys; index += 1) reader.compact()
    const hashers = reader.compact()
    if (hashers > 8 || hashers !== keys) {
      throw new Error('Quantus metadata hasher list is unsupported')
    }
    reader.bytesOf(hashers)
    reader.compact()
  } else {
    throw new Error('Quantus metadata storage entry type is unsupported')
  }
  const defaultLength = reader.compact()
  if (defaultLength > 65_536) throw new Error('Quantus metadata storage default is too large')
  reader.bytesOf(defaultLength)
  readDocs(reader)
}

function readPallet(
  reader: QuantusScaleReader
): Readonly<{ name: string; index: number; eventType: number | null }> {
  const name = reader.string()
  if (reader.u8() === 1) {
    reader.string()
    const entries = reader.compact()
    if (entries > MAXIMUM_FIELDS) throw new Error('Quantus metadata storage list is too long')
    for (let index = 0; index < entries; index += 1) skipStorageEntry(reader)
  }
  if (reader.u8() === 1) reader.compact()
  const eventType = reader.u8() === 1 ? reader.compact() : null
  const constants = reader.compact()
  if (constants > MAXIMUM_FIELDS) throw new Error('Quantus metadata constant list is too long')
  for (let index = 0; index < constants; index += 1) {
    reader.string()
    reader.compact()
    const length = reader.compact()
    if (length > 65_536) throw new Error('Quantus metadata constant value is too large')
    reader.bytesOf(length)
    readDocs(reader)
  }
  if (reader.u8() === 1) reader.compact()
  const index = reader.u8()
  return Object.freeze({ name, index, eventType })
}

/**
 * Parses the parts of runtime metadata needed to decode `System.Events`. The
 * layout follows frame-metadata V14; V15 keeps the same prefix and appends a
 * custom section, which is ignored.
 */
export function parseQuantusRuntimeMetadata(metadataHex: string): QuantusRuntimeMetadata {
  if (typeof metadataHex !== 'string' || !/^0x(?:[0-9a-f]{2})+$/.test(metadataHex)) {
    throw new Error('Quantus runtime metadata must be hex')
  }
  const reader = new QuantusScaleReader(hexToBytes(metadataHex))
  const magic = new TextDecoder('utf-8', { fatal: true }).decode(reader.bytesOf(4))
  if (magic !== 'meta') throw new Error('Quantus runtime metadata magic is invalid')
  const version = reader.u8()
  if (version !== 14 && version !== 15) {
    throw new Error('Quantus runtime metadata version is unsupported')
  }
  const typeCount = reader.compact()
  if (typeCount > MAXIMUM_TYPES) throw new Error('Quantus metadata type list is too long')
  const types = new Map<number, QuantusScaleType>()
  for (let index = 0; index < typeCount; index += 1) {
    // scale-info encodes portable type IDs with a compact prefix.
    const id = reader.compact()
    if (types.has(id)) throw new Error('Quantus metadata type IDs are not unique')
    types.set(id, readType(reader))
  }
  const palletCount = reader.compact()
  if (palletCount > MAXIMUM_PALLETS) throw new Error('Quantus metadata pallet list is too long')
  const pallets: Array<Readonly<{ name: string; index: number; eventType: number | null }>> = []
  for (let index = 0; index < palletCount; index += 1) pallets.push(readPallet(reader))
  reader.compact()
  reader.u8()
  const signedExtensions = reader.compact()
  if (signedExtensions > MAXIMUM_FIELDS) {
    throw new Error('Quantus metadata signed extension list is too long')
  }
  for (let index = 0; index < signedExtensions; index += 1) {
    reader.string()
    reader.compact()
    reader.compact()
  }
  if (reader.remaining >= 2) reader.compact()

  const system = pallets.find(pallet => pallet.name === 'System')
  if (!system || system.eventType === null) {
    throw new Error('Quantus runtime metadata has no System events')
  }
  const systemEvents = types.get(system.eventType)
  if (!systemEvents || systemEvents.kind !== 'sequence') {
    throw new Error('Quantus System events type is not a sequence')
  }
  return Object.freeze({
    version,
    types,
    pallets: Object.freeze(pallets),
    eventRecordType: systemEvents.type,
    systemPalletIndex: system.index,
    systemEventsType: system.eventType
  })
}

const PRIMITIVE_BYTE_LENGTHS: Readonly<Record<number, number>> = Object.freeze({
  0: 1, // bool
  1: 4, // char
  3: 1, // u8
  4: 2, // u16
  5: 4, // u32
  8: 1, // i8
  9: 2, // i16
  10: 4 // i32
})

const MAXIMUM_DEPTH = 32
const MAXIMUM_ELEMENTS = 65_536

export type QuantusScaleValue =
  | Readonly<{ kind: 'primitive'; value: bigint }>
  | Readonly<{ kind: 'sequence'; length: number }>
  | Readonly<{ kind: 'composite'; values: readonly QuantusScaleValue[] }>
  | Readonly<{ kind: 'variant'; index: number; name: string; values: readonly QuantusScaleValue[] }>
  | Readonly<{ kind: 'none' }>

/**
 * Decodes one value of `typeId` and discards everything except enum structure.
 * Unknown or unsupported layouts throw, so event decoding fails closed.
 */
export function readQuantusScaleValue(
  metadata: QuantusRuntimeMetadata,
  typeId: number,
  reader: QuantusScaleReader,
  depth = 0
): QuantusScaleValue {
  if (depth > MAXIMUM_DEPTH) throw new Error('Quantus SCALE value is nested too deeply')
  const type = metadata.types.get(typeId)
  if (!type) throw new Error('Quantus metadata type ID is missing')
  switch (type.kind) {
    case 'composite':
    case 'tuple': {
      const fieldTypes =
        type.kind === 'composite'
          ? type.fields.map(field => field.type)
          : (type.types as readonly number[])
      const values = fieldTypes.map(fieldType =>
        readQuantusScaleValue(metadata, fieldType, reader, depth + 1)
      )
      return Object.freeze({ kind: 'composite' as const, values: Object.freeze(values) })
    }
    case 'variant': {
      const index = reader.u8()
      const variant = type.variants.find(candidate => candidate.index === index)
      if (!variant) throw new Error('Quantus event variant is unknown')
      const values = variant.fields.map(field =>
        readQuantusScaleValue(metadata, field.type, reader, depth + 1)
      )
      return Object.freeze({
        kind: 'variant' as const,
        index,
        name: variant.name,
        values: Object.freeze(values)
      })
    }
    case 'sequence': {
      const length = reader.compact()
      if (length > MAXIMUM_ELEMENTS) throw new Error('Quantus SCALE sequence is too long')
      for (let index = 0; index < length; index += 1) {
        readQuantusScaleValue(metadata, type.type, reader, depth + 1)
      }
      return Object.freeze({ kind: 'sequence' as const, length })
    }
    case 'array': {
      if (type.length > MAXIMUM_ELEMENTS) throw new Error('Quantus SCALE array is too long')
      for (let index = 0; index < type.length; index += 1) {
        readQuantusScaleValue(metadata, type.type, reader, depth + 1)
      }
      return Object.freeze({ kind: 'sequence' as const, length: type.length })
    }
    case 'compact':
      return Object.freeze({ kind: 'primitive' as const, value: BigInt(reader.compact()) })
    case 'primitive': {
      if (type.primitive === 2) {
        const length = reader.compact()
        if (length > MAXIMUM_ELEMENTS) throw new Error('Quantus SCALE string is too long')
        reader.bytesOf(length)
        return Object.freeze({ kind: 'none' as const })
      }
      const byteLength = PRIMITIVE_BYTE_LENGTHS[type.primitive]
      if (byteLength !== undefined) {
        reader.bytesOf(byteLength)
        return Object.freeze({ kind: 'none' as const })
      }
      if (type.primitive === 6)
        return Object.freeze({ kind: 'primitive' as const, value: reader.bigUint(8, 'u64') })
      if (type.primitive === 7)
        return Object.freeze({ kind: 'primitive' as const, value: reader.bigUint(16, 'u128') })
      if (type.primitive === 11) {
        reader.bytesOf(8)
        return Object.freeze({ kind: 'none' as const })
      }
      if (type.primitive === 12) {
        reader.bytesOf(16)
        return Object.freeze({ kind: 'none' as const })
      }
      if (type.primitive === 14) {
        reader.bytesOf(32)
        return Object.freeze({ kind: 'none' as const })
      }
      if (type.primitive === 13) {
        reader.bytesOf(32)
        return Object.freeze({ kind: 'none' as const })
      }
      throw new Error('Quantus SCALE primitive is unsupported')
    }
    case 'bitsequence': {
      const bits = reader.compact()
      if (bits > MAXIMUM_ELEMENTS * 8) throw new Error('Quantus SCALE bit sequence is too long')
      const store = metadata.types.get(type.bitStoreType)
      if (!store || store.kind !== 'primitive') {
        throw new Error('Quantus SCALE bit store type is unsupported')
      }
      const bitsPerStore =
        store.primitive === 3
          ? 8
          : store.primitive === 4
            ? 16
            : store.primitive === 5
              ? 32
              : store.primitive === 6
                ? 64
                : 0
      if (bitsPerStore === 0) throw new Error('Quantus SCALE bit store type is unsupported')
      reader.bytesOf(Math.ceil(bits / bitsPerStore) * (bitsPerStore / 8))
      return Object.freeze({ kind: 'none' as const })
    }
    default:
      throw new Error('Quantus SCALE type is unsupported')
  }
}
