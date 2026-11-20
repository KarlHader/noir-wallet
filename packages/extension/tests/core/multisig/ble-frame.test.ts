import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  FrameError,
  FrameReassembler,
  MAX_SENT_FRAME_SIZE,
  crc32,
  splitMessage
} from '../../../src/core/multisig/ble/frame'

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) & 0xff)

test('crc32 is the standard IEEE checksum', () => {
  expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
})

test('a short message is one frame with the documented layout', () => {
  const [frame] = splitMessage(Uint8Array.of(9, 8, 7), 0x0102)
  expect([...frame.subarray(0, 7)]).toEqual([1, 0x02, 0x01, 0, 0, 1, 0])
  expect([...frame.subarray(7, 10)]).toEqual([9, 8, 7])
  expect(frame.length).toBe(7 + 3 + 4)
})

test('frames never exceed the size cap and reassemble to the original message', () => {
  const message = bytes(1000)
  const frames = splitMessage(message, 5)
  expect(frames.every(frame => frame.length <= MAX_SENT_FRAME_SIZE)).toBe(true)
  expect(frames.length).toBe(Math.ceil(1000 / (MAX_SENT_FRAME_SIZE - 11)))
  const reassembler = new FrameReassembler()
  let result
  for (const frame of frames) result = reassembler.accept(frame)
  expect(result).toMatchObject({ kind: 'complete', messageId: 5 })
  expect([...(result as { data: Uint8Array }).data]).toEqual([...message])
})

test('out-of-order and repeated frames are accepted', () => {
  const message = bytes(500)
  const frames = splitMessage(message, 1)
  const reassembler = new FrameReassembler()
  const order = [...frames].reverse()
  expect(reassembler.accept(order[0]).kind).toBe('partial')
  expect(reassembler.accept(order[0]).kind).toBe('duplicate')
  let done
  for (const frame of order.slice(1)) done = reassembler.accept(frame)
  expect(done?.kind).toBe('complete')
  // A late repeat of a finished message neither completes it again nor takes a slot.
  expect(reassembler.accept(frames[0]).kind).toBe('duplicate')
  expect(reassembler.pendingCount).toBe(0)
})

test('a damaged frame is rejected', () => {
  const [frame] = splitMessage(bytes(20), 1)
  frame[9] ^= 1
  expect(() => new FrameReassembler().accept(frame)).toThrow(FrameError)
})

test('a frame of the wrong version or too short is malformed', () => {
  const [frame] = splitMessage(bytes(20), 1)
  const wrongVersion = frame.slice()
  wrongVersion[0] = 2
  expect(() => new FrameReassembler().accept(wrongVersion)).toThrow(FrameError)
  expect(() => new FrameReassembler().accept(frame.subarray(0, 8))).toThrow(FrameError)
})

test('a message whose total changes midway is inconsistent', () => {
  const a = splitMessage(bytes(400), 1)
  const b = splitMessage(bytes(800), 1)
  const reassembler = new FrameReassembler()
  reassembler.accept(a[0])
  expect(() => reassembler.accept(b[1])).toThrow(FrameError)
})

test('at most four messages are reassembled at once', () => {
  const reassembler = new FrameReassembler()
  for (let id = 1; id <= 4; id++) reassembler.accept(splitMessage(bytes(400), id)[0])
  expect(() => reassembler.accept(splitMessage(bytes(400), 5)[0])).toThrow(FrameError)
})

test('an oversize message cannot be sent', () => {
  expect(() => splitMessage(new Uint8Array(70_001), 1)).toThrow(FrameError)
  expect(() => splitMessage(bytes(5), 1, 11)).toThrow(FrameError)
})
