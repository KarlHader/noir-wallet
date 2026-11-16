import { test } from 'node:test'
import { expect } from '@playwright/test'

import { findProhibitedRuntimeModules } from '../../../scripts/lib/runtime-module-policy.mjs'

test.describe('Runtime dependency module policy', () => {
  test('rejects direct and pnpm-installed bigint-buffer modules', () => {
    expect(
      findProhibitedRuntimeModules([
        '/workspace/node_modules/bigint-buffer/dist/index.js',
        '/workspace/node_modules/.pnpm/bigint-buffer@1.1.5/node_modules/bigint-buffer/dist/index.js'
      ])
    ).toEqual([
      '/workspace/node_modules/.pnpm/bigint-buffer@1.1.5/node_modules/bigint-buffer/dist/index.js',
      '/workspace/node_modules/bigint-buffer/dist/index.js'
    ])
  })

  test('allows metadata and similarly named modules that do not enter a runtime chunk', () => {
    expect(
      findProhibitedRuntimeModules([
        '/workspace/pnpm-lock.yaml',
        '/workspace/node_modules/bigint-buffer-safe/index.js',
        '/workspace/src/bigint-buffer-policy.ts'
      ])
    ).toEqual([])
  })
})
