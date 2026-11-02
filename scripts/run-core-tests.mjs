import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryDirectory = fileURLToPath(new URL('..', import.meta.url))
const directory = path.join(repositoryDirectory, 'packages/extension/tests/core')

function findTests(parent) {
  return readdirSync(parent, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(parent, entry.name)
    if (entry.isDirectory()) return findTests(filename)
    return entry.isFile() && /\.test\.(mjs|js|ts)$/.test(entry.name) ? [filename] : []
  })
}

const files = findTests(directory).sort()

if (files.length === 0) throw new Error('No core tests found')

if (process.argv.includes('--list')) {
  for (const file of files) {
    console.log(path.relative(repositoryDirectory, file).split(path.sep).join('/'))
  }
  process.exit(0)
}

const result = spawnSync(
  process.execPath,
  [
    '--import',
    new URL('./register-test-loader.mjs', import.meta.url).href,
    '--test',
    '--test-concurrency=4',
    ...process.argv.slice(2),
    ...files
  ],
  { stdio: 'inherit' }
)
if (result.error) throw result.error
process.exit(result.status ?? 1)
