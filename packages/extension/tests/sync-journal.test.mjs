import assert from 'node:assert/strict'
import { test } from 'node:test'
import { replayJournalPages } from '../src/lib/sync-journal.ts'

const entry = seq => ({ seq, data: new Uint8Array([seq]) })

test('journal pages apply exactly once in sequence within the captured recovery window', async () => {
  const applied = []
  const reads = []
  let applying = false
  const count = await replayJournalPages({
    fromSeq: 3,
    toSeq: 8,
    readPage: async (from, to) => {
      assert.equal(applying, false)
      reads.push([from, to])
      return Array.from({ length: Math.min(2, to - from) }, (_, i) => entry(from + i))
    },
    applyPage: async entries => {
      applying = true
      await Promise.resolve()
      applied.push(...entries.map(bytes => bytes[0]))
      applying = false
    },
    ensureActive() {}
  })
  assert.equal(count, 5)
  assert.deepEqual(reads, [
    [3, 8],
    [5, 8],
    [7, 8]
  ])
  assert.deepEqual(applied, [3, 4, 5, 6, 7])
})

test('missing, duplicate and out-of-window journal entries cannot complete recovery', async () => {
  for (const page of [[], [entry(1)], [entry(0), entry(0)], [entry(0), entry(1), entry(2)]]) {
    let applied = false
    await assert.rejects(
      replayJournalPages({
        fromSeq: 0,
        toSeq: 2,
        readPage: async () => page,
        applyPage: async () => {
          applied = true
        },
        ensureActive() {}
      }),
      /sync journal/i
    )
    assert.equal(applied, false)
  }
})

test('journal storage and worker failures propagate without reading another page', async () => {
  for (const stage of ['read', 'apply']) {
    const failure = new Error(`Synthetic ${stage} failure`)
    let reads = 0
    await assert.rejects(
      replayJournalPages({
        fromSeq: 0,
        toSeq: 3,
        readPage: async () => {
          reads++
          if (stage === 'read') throw failure
          return [entry(0)]
        },
        applyPage: async () => {
          throw failure
        },
        ensureActive() {}
      }),
      error => error === failure
    )
    assert.equal(reads, 1)
  }
})

test('an abort during a journal read prevents that page from reaching the worker', async () => {
  let aborted = false
  let applied = false
  await assert.rejects(
    replayJournalPages({
      fromSeq: 0,
      toSeq: 1,
      readPage: async () => {
        aborted = true
        return [entry(0)]
      },
      applyPage: async () => {
        applied = true
      },
      ensureActive() {
        if (aborted) throw new Error('Synthetic abort')
      }
    }),
    /Synthetic abort/
  )
  assert.equal(applied, false)
})

test('an abort after a page prevents loading further journal data', async () => {
  let aborted = false
  let reads = 0
  await assert.rejects(
    replayJournalPages({
      fromSeq: 0,
      toSeq: 2,
      readPage: async () => {
        reads++
        return [entry(0)]
      },
      applyPage: async () => {
        aborted = true
      },
      ensureActive() {
        if (aborted) throw new Error('Synthetic abort')
      }
    }),
    /Synthetic abort/
  )
  assert.equal(reads, 1)
})

test('an empty recovery window does not touch storage or the worker', async () => {
  assert.equal(
    await replayJournalPages({
      fromSeq: 4,
      toSeq: 4,
      readPage: async () => {
        throw new Error('Unexpected read')
      },
      applyPage: async () => {
        throw new Error('Unexpected apply')
      },
      ensureActive() {}
    }),
    0
  )
})
