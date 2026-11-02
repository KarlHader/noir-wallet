import { inflateRawSync } from 'node:zlib'

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
const DESCRIPTOR = 0x08074b50
const MAX_MANIFEST_BYTES = 1024 * 1024

function checkedRange(bytes, offset, length, limit = bytes.length) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > limit
  ) {
    throw new Error('ZIP structure is out of bounds')
  }
}

function safeName(name, isDirectory) {
  if (
    !name ||
    name.includes('\\') ||
    name.includes('\0') ||
    name.startsWith('/') ||
    /^[A-Za-z]:/.test(name) ||
    name
      .split('/')
      .some(
        (part, index, parts) =>
          part === '.' ||
          part === '..' ||
          (part === '' && !(isDirectory && index === parts.length - 1))
      )
  ) {
    throw new Error('Unsafe ZIP entry path')
  }
}

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function findEocd(bytes) {
  const start = Math.max(0, bytes.length - 22 - 0xffff)
  let found = -1
  for (let offset = bytes.length - 22; offset >= start; offset--) {
    if (bytes.readUInt32LE(offset) !== EOCD) continue
    if (offset + 22 + bytes.readUInt16LE(offset + 20) !== bytes.length) continue
    if (found !== -1) throw new Error('Ambiguous ZIP end record')
    found = offset
  }
  if (found === -1) throw new Error('ZIP end record is missing')
  return found
}

function readDescriptor(bytes, offset, entry, limit) {
  checkedRange(bytes, offset, 12, limit)
  const hasSignature = bytes.readUInt32LE(offset) === DESCRIPTOR
  const length = hasSignature ? 16 : 12
  checkedRange(bytes, offset, length, limit)
  const fields = offset + (hasSignature ? 4 : 0)
  if (
    bytes.readUInt32LE(fields) !== entry.crc ||
    bytes.readUInt32LE(fields + 4) !== entry.compressedSize ||
    bytes.readUInt32LE(fields + 8) !== entry.size
  ) {
    throw new Error('ZIP data descriptor does not match central directory')
  }
  return offset + length
}

function readCentralDirectory(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new Error('ZIP must be a Buffer')
  if (bytes.length < 22) throw new Error('ZIP is too short')
  const eocd = findEocd(bytes)
  const disk = bytes.readUInt16LE(eocd + 4)
  const centralDisk = bytes.readUInt16LE(eocd + 6)
  const diskEntries = bytes.readUInt16LE(eocd + 8)
  const totalEntries = bytes.readUInt16LE(eocd + 10)
  const centralSize = bytes.readUInt32LE(eocd + 12)
  const centralOffset = bytes.readUInt32LE(eocd + 16)
  if (
    disk ||
    centralDisk ||
    diskEntries !== totalEntries ||
    totalEntries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new Error('ZIP64 and multi-disk ZIPs are unsupported')
  }
  checkedRange(bytes, centralOffset, centralSize, eocd)
  if (centralOffset + centralSize !== eocd) throw new Error('ZIP central directory is misplaced')

  const entries = new Map()
  const foldedNames = new Set()
  const ranges = []
  let offset = centralOffset
  for (let index = 0; index < totalEntries; index++) {
    checkedRange(bytes, offset, 46, eocd)
    if (bytes.readUInt32LE(offset) !== CENTRAL) throw new Error('Invalid ZIP central entry')
    const creator = bytes.readUInt16LE(offset + 4)
    const flags = bytes.readUInt16LE(offset + 8)
    const method = bytes.readUInt16LE(offset + 10)
    const crc = bytes.readUInt32LE(offset + 16)
    const compressedSize = bytes.readUInt32LE(offset + 20)
    const size = bytes.readUInt32LE(offset + 24)
    const nameLength = bytes.readUInt16LE(offset + 28)
    const extraLength = bytes.readUInt16LE(offset + 30)
    const commentLength = bytes.readUInt16LE(offset + 32)
    const startDisk = bytes.readUInt16LE(offset + 34)
    const attributes = bytes.readUInt32LE(offset + 38)
    const localOffset = bytes.readUInt32LE(offset + 42)
    const end = offset + 46 + nameLength + extraLength + commentLength
    checkedRange(bytes, offset, end - offset, eocd)
    if (
      startDisk ||
      compressedSize === 0xffffffff ||
      size === 0xffffffff ||
      localOffset === 0xffffffff ||
      flags & (1 | 0x40 | 0x2000) ||
      ![0, 8].includes(method)
    ) {
      throw new Error('Unsupported ZIP entry')
    }
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength)
    if (!(flags & 0x800) && nameBytes.some(byte => byte > 0x7f)) {
      throw new Error('Non-ASCII ZIP entry name without UTF-8 flag')
    }
    const name = nameBytes.toString('utf8')
    if (!Buffer.from(name, 'utf8').equals(nameBytes)) throw new Error('Invalid ZIP entry name')
    const isDirectory = name.endsWith('/')
    safeName(name, isDirectory)
    const folded = (isDirectory ? name.slice(0, -1) : name).toLowerCase()
    if (entries.has(name) || foldedNames.has(folded)) throw new Error('Duplicate ZIP entry path')
    foldedNames.add(folded)
    const unixType = creator >>> 8 === 3 ? (attributes >>> 16) & 0o170000 : 0
    if (unixType && unixType !== (isDirectory ? 0o040000 : 0o100000)) {
      throw new Error('ZIP links and special files are unsupported')
    }
    if (isDirectory && (size || crc || compressedSize > 4096)) {
      throw new Error('Invalid ZIP directory entry')
    }
    let extraOffset = offset + 46 + nameLength
    const extraEnd = extraOffset + extraLength
    while (extraOffset < extraEnd) {
      checkedRange(bytes, extraOffset, 4, extraEnd)
      const type = bytes.readUInt16LE(extraOffset)
      const length = bytes.readUInt16LE(extraOffset + 2)
      checkedRange(bytes, extraOffset + 4, length, extraEnd)
      if (type === 1) throw new Error('ZIP64 is unsupported')
      extraOffset += 4 + length
    }

    checkedRange(bytes, localOffset, 30, centralOffset)
    if (bytes.readUInt32LE(localOffset) !== LOCAL) throw new Error('Invalid ZIP local entry')
    const localFlags = bytes.readUInt16LE(localOffset + 6)
    const localMethod = bytes.readUInt16LE(localOffset + 8)
    const localNameLength = bytes.readUInt16LE(localOffset + 26)
    const localExtraLength = bytes.readUInt16LE(localOffset + 28)
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength
    checkedRange(bytes, localOffset, dataOffset - localOffset, centralOffset)
    let localExtraOffset = localOffset + 30 + localNameLength
    while (localExtraOffset < dataOffset) {
      checkedRange(bytes, localExtraOffset, 4, dataOffset)
      const type = bytes.readUInt16LE(localExtraOffset)
      const length = bytes.readUInt16LE(localExtraOffset + 2)
      checkedRange(bytes, localExtraOffset + 4, length, dataOffset)
      if (type === 1) throw new Error('ZIP64 is unsupported')
      localExtraOffset += 4 + length
    }
    if (
      localFlags !== flags ||
      localMethod !== method ||
      localNameLength !== nameLength ||
      !bytes.subarray(localOffset + 30, localOffset + 30 + nameLength).equals(nameBytes)
    ) {
      throw new Error('ZIP local entry does not match central directory')
    }
    if (!(flags & 8)) {
      if (
        bytes.readUInt32LE(localOffset + 14) !== crc ||
        bytes.readUInt32LE(localOffset + 18) !== compressedSize ||
        bytes.readUInt32LE(localOffset + 22) !== size
      ) {
        throw new Error('ZIP local sizes do not match central directory')
      }
    } else if (
      ![0, crc].includes(bytes.readUInt32LE(localOffset + 14)) ||
      ![0, compressedSize].includes(bytes.readUInt32LE(localOffset + 18)) ||
      ![0, size].includes(bytes.readUInt32LE(localOffset + 22))
    ) {
      throw new Error('ZIP local sizes do not match central directory')
    }
    const dataEnd = dataOffset + compressedSize
    checkedRange(bytes, dataOffset, compressedSize, centralOffset)
    if (isDirectory) {
      const content = bytes.subarray(dataOffset, dataEnd)
      try {
        if (
          (method === 0 && content.length !== 0) ||
          (method === 8 && inflateRawSync(content, { maxOutputLength: 1 }).length !== 0)
        ) {
          throw new Error('Invalid ZIP directory entry')
        }
      } catch {
        throw new Error('Invalid ZIP directory entry')
      }
    }
    const entry = { crc, compressedSize, size, method, dataOffset, isDirectory }
    const localEnd = flags & 8 ? readDescriptor(bytes, dataEnd, entry, centralOffset) : dataEnd
    ranges.push([localOffset, localEnd])
    entries.set(name, entry)
    offset = end
  }
  if (offset !== eocd) throw new Error('ZIP central directory has unexpected data')
  for (const name of entries.keys()) {
    for (let slash = name.indexOf('/'); slash !== -1; slash = name.indexOf('/', slash + 1)) {
      const parent = entries.get(name.slice(0, slash))
      if (parent && !parent.isDirectory) throw new Error('Ambiguous ZIP entry path')
    }
  }
  ranges.sort((a, b) => a[0] - b[0])
  if (ranges.length && ranges[0][0] !== 0) throw new Error('ZIP has an unexpected preamble')
  for (let index = 1; index < ranges.length; index++) {
    if (ranges[index][0] < ranges[index - 1][1]) throw new Error('Overlapping ZIP entries')
  }
  return entries
}

export function readZipEntry(zipBytes, entryName, { maxBytes } = {}) {
  if (typeof entryName !== 'string') throw new Error('Invalid ZIP entry name')
  safeName(entryName, false)
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid ZIP size limit')
  const entries = readCentralDirectory(zipBytes)
  const entry = entries.get(entryName)
  if (!entry || entry.isDirectory) throw new Error('ZIP entry is missing')
  if (entry.size > maxBytes) throw new Error('ZIP entry exceeds size limit')
  const compressed = zipBytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize)
  let content
  try {
    content =
      entry.method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: maxBytes })
  } catch {
    throw new Error('Invalid or oversized ZIP entry')
  }
  if (content.length !== entry.size || crc32(content) !== entry.crc) {
    throw new Error('ZIP entry checksum or size mismatch')
  }
  return content
}

export function readZipManifest(zipBytes) {
  let manifest
  try {
    manifest = JSON.parse(
      readZipEntry(zipBytes, 'manifest.json', { maxBytes: MAX_MANIFEST_BYTES }).toString('utf8')
    )
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Invalid ZIP manifest JSON')
    throw error
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Invalid ZIP manifest')
  }
  return manifest
}
