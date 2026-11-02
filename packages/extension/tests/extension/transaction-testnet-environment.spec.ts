import path from 'node:path'
import {
  e2eBuildProfile,
  e2eNetworkMode,
  expect,
  extensionDir,
  test
} from '../helpers/extension-fixtures'

const ZCASH_TESTNET_GRPC_WEB_URL = 'https://zcash-testnet.chainsafe.dev'

function readVarint(bytes: Uint8Array, start: number): { value: number; next: number } {
  let value = 0
  let shift = 0
  for (let index = start; index < bytes.length && shift <= 28; index += 1) {
    const byte = bytes[index]
    value |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value: value >>> 0, next: index + 1 }
    shift += 7
  }
  throw new Error('Invalid protobuf varint')
}

function readLengthDelimitedField(message: Uint8Array, expectedField: number): string {
  let offset = 0
  while (offset < message.length) {
    const tag = readVarint(message, offset)
    offset = tag.next
    const field = tag.value >>> 3
    const wireType = tag.value & 0x07

    if (wireType === 0) {
      offset = readVarint(message, offset).next
      continue
    }
    if (wireType === 1) {
      offset += 8
      continue
    }
    if (wireType === 5) {
      offset += 4
      continue
    }
    if (wireType !== 2) throw new Error(`Unsupported protobuf wire type ${wireType}`)

    const length = readVarint(message, offset)
    const end = length.next + length.value
    if (end > message.length) throw new Error('Truncated protobuf field')
    if (field === expectedField) {
      return new TextDecoder().decode(message.subarray(length.next, end))
    }
    offset = end
  }
  throw new Error(`Missing protobuf field ${expectedField}`)
}

function readGrpcWebMessage(body: Uint8Array): Uint8Array {
  if (body.length < 5 || body[0] !== 0) throw new Error('Missing gRPC-Web data frame')
  const length = new DataView(body.buffer, body.byteOffset + 1, 4).getUint32(0)
  if (length + 5 > body.length) throw new Error('Truncated gRPC-Web data frame')
  return body.subarray(5, 5 + length)
}

test('loads the isolated testnet transaction extension', async ({ popup }) => {
  expect(e2eNetworkMode).toBe('testnet')
  expect(e2eBuildProfile).toBe('testnet-transactions')
  expect(path.basename(extensionDir)).toBe('testnet-transactions')

  const manifest = await popup.evaluate(() => chrome.runtime.getManifest())
  expect(manifest.name).toBe('[Testnet] Noir Wallet')
})

test('binds the fixed Zcash endpoint to a gRPC-Web test chain', async () => {
  const response = await fetch(
    `${ZCASH_TESTNET_GRPC_WEB_URL}/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLightdInfo`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/grpc-web+proto',
        'x-grpc-web': '1'
      },
      body: new Uint8Array(5)
    }
  )
  expect(response.ok).toBe(true)
  expect(response.headers.get('content-type')).toMatch(/^application\/grpc-web/)

  const message = readGrpcWebMessage(new Uint8Array(await response.arrayBuffer()))
  expect(readLengthDelimitedField(message, 4)).toBe('test')
})
