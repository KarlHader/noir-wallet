import { test } from 'node:test'
import { expect } from '@playwright/test'
import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const extensionRoot = fileURLToPath(new URL('../../..', import.meta.url))
const sourceRoot = join(extensionRoot, 'src')
const workerTypesPath = join(sourceRoot, 'core/worker/types.ts')
const workerClientPath = join(sourceRoot, 'core/worker/client.ts')
const zcashWorkerPath = join(sourceRoot, 'core/worker/zcash.worker.ts')
const approvalPagePath = join(sourceRoot, 'popup/pages/dapp/ApprovalPage.tsx')
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx'])
const GENERATED_SOURCE_SEGMENTS = ['/lib/wasm-pkg/', '/public/wasm/']
const SENSITIVE_IDENTIFIER =
  /^(?:seed|seedPhrase|mnemonic|password|passphrase|privateKey|spendingKey|sessionKey|sessionPassword|vault|signature|signed|signedMessage|pczt|rawPayload)$/i

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

function collectIdentifiers(node, result) {
  if (ts.isIdentifier(node)) result.add(node.text)
  node.forEachChild(child => collectIdentifiers(child, result))
}

function findSensitiveLogArguments() {
  const violations = []
  for (const file of collectSourceFiles(sourceRoot)) {
    const source = readFileSync(file, 'utf8')
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    )

    function visit(node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        (node.expression.expression.text === 'console' ||
          node.expression.expression.text === 'logger')
      ) {
        const identifiers = new Set()
        for (const argument of node.arguments) collectIdentifiers(argument, identifiers)
        const sensitive = [...identifiers].filter(identifier =>
          SENSITIVE_IDENTIFIER.test(identifier)
        )
        if (sensitive.length > 0) {
          const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          violations.push(
            `${relative(extensionRoot, file)}:${position.line + 1} (${sensitive.join(', ')})`
          )
        }
      }
      node.forEachChild(visit)
    }

    visit(sourceFile)
  }
  return violations
}

test.describe('Sensitive data source gates', () => {
  test('does not pass secret-bearing identifiers to loggers', () => {
    expect(findSensitiveLogArguments()).toEqual([])
  })

  test('keeps optional BIP-39 passphrases out of the product mnemonic API', () => {
    const workerTypes = readFileSync(workerTypesPath, 'utf8')
    const workerClient = readFileSync(workerClientPath, 'utf8')
    const zcashWorker = readFileSync(zcashWorkerPath, 'utf8')

    expect(workerTypes).toMatch(/'mnemonic\.toSeed':\s*\{\s*request:\s*\{\s*phrase:\s*string\s*\}/)
    expect(workerClient).toContain('async mnemonicToSeed(phrase: string)')
    expect(workerClient).not.toMatch(/mnemonicToSeed\([^)]*passphrase/i)
    expect(zcashWorker).toContain("mnemonic_to_seed(phrase, '')")
  })

  test('does not expose recovered credential passwords to extension pages', () => {
    for (const file of collectSourceFiles(sourceRoot)) {
      const source = readFileSync(file, 'utf8')
      expect(source, relative(extensionRoot, file)).not.toContain('RECOVER_WALLET_SESSION')
      expect(source, relative(extensionRoot, file)).not.toContain('session.recover-password')
      expect(source, relative(extensionRoot, file)).not.toMatch(/recoverPassword\s*\(/)
    }
  })

  test('does not disclose dApp origins to a third-party favicon service', () => {
    const approvalPage = readFileSync(approvalPagePath, 'utf8')

    expect(approvalPage).not.toContain('google.com/s2/favicons')
    expect(approvalPage).not.toMatch(/<img[^>]+src=\{`[^`]*\$\{origin\}/s)
  })
})
