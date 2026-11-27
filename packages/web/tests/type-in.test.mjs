import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TypeIn } from '../src/home/TypeIn.tsx'

const count = (text, part) => text.split(part).length - 1

// Search engines and screen readers read the heading's text; the typed characters add none
test('the typed hero headline has its text in the page once', () => {
  const text = 'The Privacy-first Multichain Wallet'
  const html = renderToStaticMarkup(createElement('h1', null, createElement(TypeIn, { text })))
  const pageText = html.replace(/<[^>]+>/g, '')
  assert.equal(pageText, text)
  assert.equal(count(html, 'data-ch='), [...text].length)
})
