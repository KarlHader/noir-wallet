import assert from 'node:assert/strict'
import { it } from 'node:test'
import { openAndVerifyLedgerApp } from '../../../src/lib/ledger/app-session.ts'
import { assertLedgerZcashAppVersion } from '../../../src/lib/zcash-hardware-compatibility.ts'

it('requires NU7-compatible Zcash firmware before signing without blocking older branches', () => {
  const nu7 = 0x77190ad9
  assert.doesNotThrow(() => assertLedgerZcashAppVersion('3.9.4', 0x37a5165b))
  assert.throws(() => assertLedgerZcashAppVersion('3.9.4', nu7), /Update.*3\.10\.0/)
  assert.doesNotThrow(() => assertLedgerZcashAppVersion('3.10.0', nu7))
  assert.doesNotThrow(() => assertLedgerZcashAppVersion('3.11.0', nu7))
  assert.throws(() => assertLedgerZcashAppVersion('3.9.1'), /Update.*3\.9\.2/)
})

function deviceWithApp(initialApp, options = {}) {
  let currentApp = initialApp
  const calls = []
  return {
    calls,
    async open(name) {
      calls.push(['open', name])
      if (options.openError) throw options.openError
      currentApp = name
    },
    async read() {
      calls.push(['version', currentApp])
      return { name: options.reportedApp ?? currentApp, version: '2.1.3' }
    }
  }
}

it('opens the selected Ledger app and returns its verified version', async () => {
  for (const appName of ['Bitcoin', 'Bitcoin Test', 'NEAR']) {
    const device = deviceWithApp('BOLOS')
    assert.equal(await openAndVerifyLedgerApp(appName, device.open, device.read), '2.1.3')
    assert.deepEqual(device.calls, [
      ['open', appName],
      ['version', appName]
    ])
  }
})

it('does not accept a different app or a rejected app switch', async () => {
  const wrongApp = deviceWithApp('BOLOS', { reportedApp: 'Bitcoin' })
  await assert.rejects(
    openAndVerifyLedgerApp('Bitcoin Test', wrongApp.open, wrongApp.read),
    /verify.*Bitcoin Test/
  )

  const rejected = deviceWithApp('BOLOS', { openError: new Error('Request rejected') })
  await assert.rejects(
    openAndVerifyLedgerApp('NEAR', rejected.open, rejected.read),
    /Request rejected/
  )
  assert.deepEqual(rejected.calls, [['open', 'NEAR']])
})

it('does not open an app after cancellation', async () => {
  const device = deviceWithApp('BOLOS')
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    openAndVerifyLedgerApp('NEAR', device.open, device.read, controller.signal),
    { name: 'AbortError' }
  )
  assert.deepEqual(device.calls, [])
})

it('stops after an in-flight app switch is cancelled', async () => {
  const device = deviceWithApp('BOLOS')
  const controller = new AbortController()
  await assert.rejects(
    openAndVerifyLedgerApp(
      'NEAR',
      async name => {
        await device.open(name)
        controller.abort()
      },
      device.read,
      controller.signal
    ),
    { name: 'AbortError' }
  )
  assert.deepEqual(device.calls, [['open', 'NEAR']])
})
