import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ZENDESK_SNIPPET_SRC,
  ZENDESK_Z_INDEX,
  createZendeskSession,
  installZendeskSnippet
} from '../src/lib/zendesk.ts'

test('the website loads the same Zendesk snippet as the dashboard', () => {
  assert.equal(
    ZENDESK_SNIPPET_SRC,
    'https://static.zdassets.com/ekr/snippet.js?key=5531fb3e-bf22-4e06-87fe-14fa6b318c3f'
  )
})

test('the snippet settings are installed once', () => {
  const scripts = []
  const host = {
    document: {
      getElementById(id) {
        return scripts.find(script => script.id === id)
      },
      createElement() {
        return { id: '', async: false, src: '' }
      },
      body: {
        appendChild(node) {
          scripts.push(node)
        }
      }
    }
  }
  installZendeskSnippet(host)
  installZendeskSnippet(host)
  assert.equal(scripts.length, 1)
  assert.equal(scripts[0].id, 'ze-snippet')
  assert.equal(scripts[0].src, ZENDESK_SNIPPET_SRC)
  assert.equal(host.zESettings.webWidget.zIndex, ZENDESK_Z_INDEX)
  assert.equal(host.zESettings.webWidget.offset.mobile.vertical, '16px')
})

function harness(href, loaded = true) {
  const calls = []
  let current = href
  let apiLoaded = loaded
  const api = (...args) => {
    calls.push(args)
    return () => {}
  }
  const session = createZendeskSession({
    getApi: () => (apiLoaded ? api : undefined),
    getHref: () => current,
    onOpenChange() {}
  })
  session.connect()
  return {
    commands: () => calls.filter(args => args[0] === 'messenger').map(args => args[1]),
    navigate(next) {
      current = next
      session.navigate()
    },
    load() {
      apiLoaded = true
      session.connect()
    },
    dispose: () => session.dispose()
  }
}

test('Zendesk opens for an explicit link and ordinary visits remain collapsed', () => {
  const opened = harness('https://www.zknoir.com/shield-and-win?zendesk=1')
  assert.deepEqual(opened.commands(), ['open'])
  opened.dispose()

  const collapsed = harness('https://www.zknoir.com/?zendesk=0')
  assert.deepEqual(collapsed.commands(), ['close'])
  collapsed.navigate('https://www.zknoir.com/frost')
  assert.deepEqual(collapsed.commands(), ['close'])
  collapsed.dispose()
})

test('Zendesk waits for the vendor API before opening the requested chat', () => {
  const pending = harness('https://www.zknoir.com/lending?zendesk=1', false)
  assert.deepEqual(pending.commands(), [])
  pending.load()
  assert.deepEqual(pending.commands(), ['open'])
  pending.dispose()
})

test('a delayed load follows the latest navigation request', () => {
  const pending = harness('https://www.zknoir.com/?zendesk=1', false)
  pending.navigate('https://www.zknoir.com/')
  pending.load()
  assert.deepEqual(pending.commands(), ['close'])
  pending.dispose()
})

test('the same support link opens once and a later visit can open it again', () => {
  const page = harness('https://www.zknoir.com/')
  const support = 'https://www.zknoir.com/?zendesk=1'
  page.navigate(support)
  page.navigate(support)
  assert.deepEqual(page.commands(), ['close', 'open'])
  page.navigate('https://www.zknoir.com/')
  page.navigate(support)
  assert.deepEqual(page.commands(), ['close', 'open', 'open'])
  page.dispose()
})
