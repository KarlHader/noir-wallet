import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const signingLibraries = new Set(['@scure/bip32', '@solana/web3.js', 'near-api-js'])

export function collectLedgerDependencyNotices(extensionDirectory) {
  const { dependencies } = JSON.parse(
    readFileSync(path.join(extensionDirectory, 'package.json'), 'utf8')
  )
  return Object.keys(dependencies)
    .filter(name => name.startsWith('@ledgerhq/') || signingLibraries.has(name))
    .flatMap(dependency => {
      const packageDirectory = path.join(extensionDirectory, 'node_modules', dependency)
      const notices = readdirSync(packageDirectory, { withFileTypes: true })
        .filter(entry => entry.isFile() && /^(license|notice)(\..*)?$/i.test(entry.name))
        .map(entry => entry.name)
        .sort()
      if (!notices.some(notice => /^license(\.|$)/i.test(notice))) {
        throw new Error(`Missing dependency license: ${dependency}`)
      }
      return notices.map(notice => ({
        fileName: `licenses/${dependency}/${notice}`,
        source: readFileSync(path.join(packageDirectory, notice))
      }))
    })
}
