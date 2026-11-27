import assert from 'node:assert/strict'
import { test } from 'node:test'
import { docsUrlFor } from '../src/home/walletStore.ts'

test('the live site links to the live docs', () => {
  assert.equal(docsUrlFor('www.zknoir.com'), 'https://docs.zknoir.com/')
  assert.equal(docsUrlFor('zknoir.com'), 'https://docs.zknoir.com/')
})

test('previews and local builds link to the docs preview home page', () => {
  for (const host of [
    'feat-web-redesign.noir-wallet.pages.dev',
    'ea2928d.noir-wallet.pages.dev',
    'localhost'
  ]) {
    assert.equal(docsUrlFor(host), 'https://feat-web-redesign.noir-wallet-docs.pages.dev/')
  }
})
