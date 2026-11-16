import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const extensionDirectory = fileURLToPath(new URL('../packages/extension/', import.meta.url))
const require = createRequire(new URL('../packages/extension/package.json', import.meta.url))
const cacheDirectory = process.env.NOIR_TEST_TRANSPILE_CACHE
let ts
const sourceDirectory = pathToFileURL(`${extensionDirectory}/src/`)
const sdkPackageJsonUrl = new URL('../packages/sdk/package.json', import.meta.url).href

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'typescript') {
    return nextResolve(require.resolve('typescript'), context)
  }
  const candidate = specifier.startsWith('@/')
    ? new URL(specifier.slice(2), sourceDirectory)
    : (specifier.startsWith('./') || specifier.startsWith('../')) &&
        context.parentURL?.startsWith('file:')
      ? new URL(specifier, context.parentURL)
      : null
  if (candidate) {
    for (const suffix of ['', '.ts', '.tsx', '.js', '/index.ts', '/index.js']) {
      const url = new URL(candidate.href + suffix)
      try {
        if ((await stat(url)).isFile()) return { url: url.href, shortCircuit: true }
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
      }
    }
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url === sdkPackageJsonUrl) {
    const data = JSON.parse(await readFile(new URL(url), 'utf8'))
    const namedExports = Object.keys(data)
      .filter(name => /^[A-Za-z_$][\w$]*$/.test(name) && name !== 'default')
      .map(
        (name, index) =>
          `const value${index} = data[${JSON.stringify(name)}]; export { value${index} as ${name} };`
      )
    return {
      format: 'module',
      source: `const data = ${JSON.stringify(data)};\nexport default data;\n${namedExports.join('\n')}`,
      shortCircuit: true
    }
  }
  if (url.startsWith('file:') && /\.tsx?$/.test(new URL(url).pathname)) {
    const source = await readFile(new URL(url), 'utf8')
    // Include the module URL: identical source at another path has different
    // relative imports and source maps. Content hashing also handles edits mid-run.
    const cacheFile = cacheDirectory
      ? path.join(
          cacheDirectory,
          `${createHash('sha256').update(url).update('\0').update(source).digest('hex')}.mjs`
        )
      : null
    if (cacheFile) {
      try {
        return { format: 'module', source: await readFile(cacheFile, 'utf8'), shortCircuit: true }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    ts ??= require('typescript')
    const result = ts.transpileModule(source, {
      fileName: fileURLToPath(url),
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
        inlineSourceMap: true,
        inlineSources: true
      }
    })
    if (cacheFile) {
      const temporaryFile = `${cacheFile}.${randomUUID()}.tmp`
      await writeFile(temporaryFile, result.outputText, { mode: 0o600 })
      await rename(temporaryFile, cacheFile)
    }
    return { format: 'module', source: result.outputText, shortCircuit: true }
  }
  return nextLoad(url, context)
}
