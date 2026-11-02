import { deflateRawSync } from 'node:zlib'

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function createTestZip(entries, { deflate = false, dataDescriptor = false } = {}) {
  const locals = []
  const central = []
  let offset = 0
  for (const [name, value] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, 'utf8')
    const content = Buffer.isBuffer(value) ? value : Buffer.from(value)
    const compressed = deflate ? deflateRawSync(content) : content
    const crc = crc32(content)
    const flags = 0x800 | (dataDescriptor ? 8 : 0)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(deflate ? 8 : 0, 8)
    if (!dataDescriptor) {
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(compressed.length, 18)
      local.writeUInt32LE(content.length, 22)
    }
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, compressed)
    const descriptor = Buffer.alloc(dataDescriptor ? 16 : 0)
    if (dataDescriptor) {
      descriptor.writeUInt32LE(0x08074b50, 0)
      descriptor.writeUInt32LE(crc, 4)
      descriptor.writeUInt32LE(compressed.length, 8)
      descriptor.writeUInt32LE(content.length, 12)
      locals.push(descriptor)
    }

    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE((3 << 8) | 20, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(flags, 8)
    record.writeUInt16LE(deflate ? 8 : 0, 10)
    record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(compressed.length, 20)
    record.writeUInt32LE(content.length, 24)
    record.writeUInt16LE(nameBytes.length, 28)
    record.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    record.writeUInt32LE(offset, 42)
    central.push(record, nameBytes)
    offset += local.length + nameBytes.length + compressed.length + descriptor.length
  }
  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(entries).length, 8)
  end.writeUInt16LE(Object.keys(entries).length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBytes, end])
}
