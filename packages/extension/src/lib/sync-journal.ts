export interface JournalReplayEntry {
  seq: number
  data: Uint8Array
}

interface JournalReplayOptions {
  fromSeq: number
  toSeq: number
  readPage: (fromSeq: number, toSeq: number) => Promise<JournalReplayEntry[]>
  applyPage: (entries: Uint8Array[]) => Promise<unknown>
  ensureActive: () => void
}

/** Replay a fixed journal window, releasing each page before reading the next. */
export async function replayJournalPages(options: JournalReplayOptions): Promise<number> {
  const { fromSeq, toSeq, readPage, applyPage, ensureActive } = options
  if (
    !Number.isSafeInteger(fromSeq) ||
    !Number.isSafeInteger(toSeq) ||
    fromSeq < 0 ||
    toSeq < fromSeq
  ) {
    throw new Error('Invalid sync journal sequence range')
  }

  let next = fromSeq
  while (next < toSeq) {
    ensureActive()
    const entries = await readPage(next, toSeq)
    if (entries.length === 0) {
      throw new Error(`Missing sync journal entry at sequence ${next}`)
    }
    for (let i = 0; i < entries.length; i++) {
      const expected = next + i
      if (entries[i].seq !== expected || expected >= toSeq) {
        throw new Error(`Invalid sync journal sequence; expected ${expected}`)
      }
    }
    ensureActive()
    await applyPage(entries.map(entry => entry.data))
    next += entries.length
  }
  return next - fromSeq
}
