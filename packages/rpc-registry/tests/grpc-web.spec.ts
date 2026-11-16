import { expect, test } from '@playwright/test'
import {
  decodeBlockHeight,
  encodeBlockRangeRequest,
  encodeGrpcWebRequest,
  encodeIronwoodSubtreeRootsRequest,
  parseGrpcWebResponse
} from '../src/grpc-web'

test('encodes the fixed protobuf requests and gRPC-Web envelope', () => {
  expect([...encodeBlockRangeRequest(100)]).toEqual([
    0x0a, 0x02, 0x08, 0x64, 0x12, 0x02, 0x08, 0x64
  ])
  expect([...encodeIronwoodSubtreeRootsRequest()]).toEqual([0x10, 0x02])
  expect([...encodeGrpcWebRequest(Uint8Array.from([1, 2, 3]))]).toEqual([0, 0, 0, 0, 3, 1, 2, 3])
})

test('decodes BlockID height while ignoring other protobuf fields', () => {
  expect(decodeBlockHeight(Uint8Array.from([0x12, 0x02, 0xaa, 0xbb, 0x08, 0xac, 0x02]))).toBe(300)
})

test('accepts both observed grpc-status trailer formats', () => {
  for (const trailer of ['grpc-status:0\r\n', 'grpc-status: 0\r\n']) {
    const response = concatFrames(dataFrame([0x08, 0x01]), trailerFrame(trailer))
    const parsed = parseGrpcWebResponse(response)
    expect(parsed.dataFrames).toHaveLength(1)
    expect(parsed.trailers['grpc-status']).toBe('0')
  }
})

test('accepts a successful trailer-only empty stream', () => {
  const parsed = parseGrpcWebResponse(trailerFrame('grpc-status: 0\r\n'))
  expect(parsed.dataFrames).toEqual([])
})

test('rejects non-zero gRPC status with the decoded message', () => {
  expect(() =>
    parseGrpcWebResponse(trailerFrame('grpc-status: 14\r\ngrpc-message: upstream%20down\r\n'))
  ).toThrow('gRPC status 14: upstream down')
})

test('rejects malformed, truncated, and compressed frames', () => {
  expect(() => parseGrpcWebResponse(Uint8Array.from([0, 0, 0]))).toThrow(
    'Truncated gRPC-Web frame header'
  )
  expect(() => parseGrpcWebResponse(Uint8Array.from([0, 0, 0, 0, 2, 1]))).toThrow(
    'Truncated gRPC-Web frame payload'
  )
  expect(() =>
    parseGrpcWebResponse(concatFrames(frame(0x01, [1]), trailerFrame('grpc-status: 0\r\n')))
  ).toThrow('Compressed gRPC-Web frames are not supported')
  expect(() => parseGrpcWebResponse(frame(0x02, []))).toThrow('Unsupported gRPC-Web frame flags')
})

function dataFrame(payload: number[]): Uint8Array {
  return frame(0x00, payload)
}

function trailerFrame(trailers: string): Uint8Array {
  return frame(0x80, new TextEncoder().encode(trailers))
}

function frame(flags: number, payload: number[] | Uint8Array): Uint8Array {
  const data = Uint8Array.from(payload)
  const result = new Uint8Array(5 + data.length)
  result[0] = flags
  new DataView(result.buffer).setUint32(1, data.length)
  result.set(data, 5)
  return result
}

function concatFrames(...frames: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(frames.reduce((total, item) => total + item.length, 0))
  let offset = 0
  for (const item of frames) {
    result.set(item, offset)
    offset += item.length
  }
  return result
}
