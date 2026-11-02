import { test } from 'node:test'
import { expect } from '@playwright/test'

import { resolveHomeDefaultTab } from '../../../src/popup/services/home-navigation.ts'

test.describe('Home navigation', () => {
  test('opens Activity only for the explicit internal tab target', () => {
    expect(resolveHomeDefaultTab('?tab=activity')).toBe('activity')
    expect(resolveHomeDefaultTab('')).toBe('assets')
    expect(resolveHomeDefaultTab('?tab=lending')).toBe('assets')
    expect(resolveHomeDefaultTab('?tab=activity&tab=assets')).toBe('activity')
  })
})
