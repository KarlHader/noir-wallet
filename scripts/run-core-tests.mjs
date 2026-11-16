import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

const allFiles = findTests(directory).sort()
const args = process.argv.slice(2)
const nodeArgs = []
const selectedFiles = new Set()
let filtered = false
let list = false

for (let index = 0; index < args.length; index += 1) {
  const argument = args[index]
  if (argument === '--list') {
    list = true
  } else if (argument === '--file' || argument.startsWith('--file=')) {
    const selector = argument === '--file' ? args[++index] : argument.slice('--file='.length)
    if (!selector || selector.startsWith('-')) throw new Error('--file requires a core test path')
    const selectedPath = path.resolve(directory, selector)
    const relativePath = path.relative(directory, selectedPath)
    if (
      relativePath.startsWith(`..${path.sep}`) ||
      relativePath === '..' ||
      path.isAbsolute(relativePath)
    ) {
      throw new Error('--file must be inside packages/extension/tests/core')
    }
    const matches = allFiles.filter(
      file => file === selectedPath || file.startsWith(`${selectedPath}${path.sep}`)
    )
    if (matches.length === 0) throw new Error(`No core tests match --file=${selector}`)
    for (const file of matches) selectedFiles.add(file)
    filtered = true
  } else {
    nodeArgs.push(argument)
  }
}

const files = filtered ? allFiles.filter(file => selectedFiles.has(file)) : allFiles

if (files.length === 0) throw new Error('No core tests found')

if (list) {
  for (const file of files) {
    console.log(path.relative(repositoryDirectory, file).split(path.sep).join('/'))
  }
  process.exit(0)
}

// Share only compiled source between isolated test processes, never runtime state.
// A fresh directory per invocation avoids stale output and cross-run cache trust.
const cacheDirectory = mkdtempSync(path.join(tmpdir(), 'noir-core-tests-'))
try {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      new URL('./register-test-loader.mjs', import.meta.url).href,
      '--test',
      '--test-concurrency=4',
      ...nodeArgs,
      ...files
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, NOIR_TEST_TRANSPILE_CACHE: cacheDirectory }
    }
  )
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  rmSync(cacheDirectory, { recursive: true, force: true })
}
