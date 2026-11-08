import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  homeAssetDomainPath,
  legacyShieldHomePath,
  resolveHomeDefaultTab
} from '../../../src/popup/services/home-navigation.ts'

test.describe('Home navigation', () => {
  test('opens Activity only for the explicit internal tab target', () => {
    expect(resolveHomeDefaultTab('?tab=activity')).toBe('activity')
    expect(resolveHomeDefaultTab('')).toBe('assets')
    expect(resolveHomeDefaultTab('?tab=lending')).toBe('assets')
    expect(resolveHomeDefaultTab('?tab=activity&tab=assets')).toBe('activity')
    expect(resolveHomeDefaultTab('?tab=shield')).toBe('assets')
  })

  test('opens legacy Shield targets on the standalone page', () => {
    expect(legacyShieldHomePath('?tab=shield')).toBe('/shield-funds')
    expect(legacyShieldHomePath('?domain=shield&mode=private')).toBeNull()
    expect(legacyShieldHomePath('?tab=activity')).toBeNull()
    expect(homeAssetDomainPath('', 'shield')).toBe('/?domain=shield')
  })
})
