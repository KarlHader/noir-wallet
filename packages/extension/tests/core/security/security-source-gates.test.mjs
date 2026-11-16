import { test } from 'node:test'
import { expect } from '@playwright/test'
import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const extensionRoot = fileURLToPath(new URL('../../..', import.meta.url))
const sourceRoot = join(extensionRoot, 'src')
const manifestSource = readFileSync(join(extensionRoot, 'manifest.config.ts'), 'utf8')
const dappMatchesSource = readFileSync(join(sourceRoot, 'config/extension.ts'), 'utf8')

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.html'])
const GENERATED_SOURCE_SEGMENTS = ['/lib/wasm-pkg/', '/public/wasm/']

function collectSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolutePath = join(directory, entry.name)
    if (entry.isDirectory()) return collectSourceFiles(absolutePath)
    if (!SOURCE_EXTENSIONS.has(extname(entry.name))) return []
    const normalizedPath = absolutePath.replaceAll('\\', '/')
    if (GENERATED_SOURCE_SEGMENTS.some(segment => normalizedPath.includes(segment))) return []
    return [absolutePath]
  })
}

const sourceFiles = collectSourceFiles(sourceRoot)

function findViolations(pattern) {
  return sourceFiles.flatMap(file => {
    const source = readFileSync(file, 'utf8')
    return pattern.test(source) ? [relative(extensionRoot, file)] : []
  })
}

test.describe('Extension security source gates', () => {
  test('rejects dangerous DOM and dynamic-code execution sinks', () => {
    const bannedPatterns = [
      /\bdangerouslySetInnerHTML\b/,
      /\.innerHTML\s*=/,
      /\.outerHTML\s*=/,
      /\binsertAdjacentHTML\s*\(/,
      /\bdocument\.write\s*\(/,
      /(?<![\w.])eval\s*\(/,
      /\bnew\s+Function\s*\(/,
      /\bset(?:Timeout|Interval)\s*\(\s*['"`]/,
      /\bimport\s*\(\s*['"`](?:https?:)?\/\//
    ]

    for (const pattern of bannedPatterns) {
      expect(findViolations(pattern), `Forbidden source pattern: ${pattern}`).toEqual([])
    }
  })

  test('keeps executable extension resources self-hosted', () => {
    expect(manifestSource).toContain("script-src 'self' 'wasm-unsafe-eval'; object-src 'self';")
    expect(manifestSource).not.toMatch(/script-src[^'"]*https?:/)
    expect(manifestSource).not.toMatch(/script-src[^'"]*'unsafe-eval'/)
    expect(manifestSource).not.toMatch(/script-src[^'"]*'unsafe-inline'/)
    expect(manifestSource).not.toMatch(/resources:\s*\[[^\]]*(?:https?:|<all_urls>)/s)
  })

  test('keeps host, content-script, and web-accessible scope centralized', () => {
    expect(dappMatchesSource).toContain("'https://*/*'")
    expect(dappMatchesSource).toContain("'http://localhost/*'")
    expect(dappMatchesSource).not.toContain('<all_urls>')
    expect(dappMatchesSource).not.toContain("'http://*/*'")

    const hostPermissionMatch = manifestSource.match(
      /host_permissions:\s*\[([\s\S]*?)\],\n\s*background:/
    )
    expect(hostPermissionMatch).not.toBeNull()
    expect([...hostPermissionMatch[1].matchAll(/'([^']+)'/g)].map(match => match[1])).toEqual([
      'https://*/*',
      'http://localhost/*'
    ])
    expect(manifestSource).toContain('http://127.0.0.1:*')
    expect(manifestSource).not.toContain('http://[::1]:*')
    expect(manifestSource).not.toContain('ws://[::1]:*')
    expect(manifestSource).toContain('matches: [...DAPP_CONTENT_SCRIPT_MATCHES]')
    expect(manifestSource).toContain("resources: ['assets/*.js', 'assets/*.css']")
    expect(manifestSource).not.toMatch(/matches:\s*\[[^\]]*<all_urls>/s)
  })

  test('does not grant unreviewed privileged capabilities', () => {
    const permissionMatch = manifestSource.match(/permissions:\s*\[([^\]]+)\]/s)
    expect(permissionMatch).not.toBeNull()
    const permissions = [...permissionMatch[1].matchAll(/'([^']+)'/g)].map(match => match[1])
    expect(permissions).toEqual([
      'storage',
      'offscreen',
      'notifications',
      'alarms',
      'sidePanel',
      'favicon'
    ])
    expect(permissions).not.toContain('tabs')
    expect(permissions).not.toContain('scripting')
    expect(permissions).not.toContain('webRequest')
    expect(permissions).not.toContain('nativeMessaging')
  })
})
