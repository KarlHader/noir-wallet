import assert from 'node:assert/strict'
import test from 'node:test'
import { logger } from '../../../src/lib/logger.ts'

async function loadTimingHelpers(enabled) {
  const previous = globalThis.__DEBUG_LOGS__
  globalThis.__DEBUG_LOGS__ = enabled
  try {
    return await import(`../../../src/lib/debug-performance.ts?debug=${enabled}`)
  } finally {
    if (previous === undefined) delete globalThis.__DEBUG_LOGS__
    else globalThis.__DEBUG_LOGS__ = previous
  }
}

function captureDiagnostics(t) {
  const persisted = []
  const output = []
  logger.configureDiagnostics(async entry => {
    persisted.push(entry)
  })
  t.after(() => logger.configureDiagnostics(null))
  for (const level of ['log', 'info', 'warn', 'error']) {
    t.mock.method(console, level, (...args) => output.push(args))
  }
  return { persisted, output }
}

test('disabled timing leaves operations untouched and emits no diagnostics', async t => {
  const { persisted, output } = captureDiagnostics(t)
  const { logDebugTiming, traceDebugStage } = await loadTimingHelpers(false)
  const value = { ready: true }
  const operation = Promise.resolve(value)

  logDebugTiming('request', 'prepare', 0)
  const result = traceDebugStage('request', 'prepare', () => operation)

  assert.equal(await result, value)
  assert.deepEqual(persisted, [])
  assert.deepEqual(output, [])
})

test('debug timing stays out of persisted diagnostics and preserves results and errors', async t => {
  const { persisted, output } = captureDiagnostics(t)
  const { logDebugTiming, traceDebugStage } = await loadTimingHelpers(true)
  const value = { ready: true }
  const failure = new Error('operation failed')

  logDebugTiming('request', 'prepare', performance.now())
  assert.equal(await traceDebugStage('request', 'prepare', async () => value), value)
  await assert.rejects(
    traceDebugStage('request', 'prepare', async () => {
      throw failure
    }),
    error => error === failure
  )

  assert.deepEqual(persisted, [])
  assert.equal(output.length, 3)
})
