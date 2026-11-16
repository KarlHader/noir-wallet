import assert from 'node:assert/strict'
import { test } from 'node:test'
import { replayJournalPages } from '../../../src/lib/sync-journal.ts'

test('replays a fixed journal window in bounded pages', async () => {
  const applied = []
  const reads = []
  const count = await replayJournalPages({
    fromSeq: 2,
    toSeq: 7,
    readPage: async start => {
      reads.push(start)
      return Array.from({ length: Math.min(2, 7 - start) }, (_, index) => ({
        seq: start + index,
        data: Uint8Array.of(start + index)
      }))
    },
    applyPage: async entries => applied.push(entries.map(entry => entry[0])),
    ensureActive: () => {}
  })

  assert.equal(count, 5)
  assert.deepEqual(reads, [2, 4, 6])
  assert.deepEqual(applied, [[2, 3], [4, 5], [6]])
})

test('rejects a missing journal sequence before applying the affected page', async () => {
  const applied = []
  await assert.rejects(
    replayJournalPages({
      fromSeq: 0,
      toSeq: 3,
      readPage: async start =>
        start === 0 ? [{ seq: 0, data: Uint8Array.of(0) }] : [{ seq: 2, data: Uint8Array.of(2) }],
      applyPage: async entries => applied.push(entries.map(entry => entry[0])),
      ensureActive: () => {}
    }),
    /expected 1/
  )
  assert.deepEqual(applied, [[0]])
})
