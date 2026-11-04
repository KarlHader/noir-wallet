import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const sha = /^[0-9a-f]{40}$/
const positiveId = value => Number.isSafeInteger(value) && value > 0

export async function resolveDemoPreview({ repository, runId, runAttempt, request }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !positiveId(runId) || !positiveId(runAttempt))
    throw new Error('Invalid preview identity')
  const run = await request(`actions/runs/${runId}`)
  if (
    run.id !== runId ||
    run.path !== '.github/workflows/extension-ci.yml' ||
    run.event !== 'pull_request' ||
    run.repository?.full_name !== repository ||
    run.head_repository?.full_name !== repository ||
    !positiveId(run.head_repository?.id) ||
    !sha.test(run.head_sha)
  )
    return null
  if (run.run_attempt !== runAttempt || run.status !== 'completed' || run.conclusion !== 'success')
    return null
  const associated = run.pull_requests?.length
    ? run.pull_requests
    : await request(`commits/${run.head_sha}/pulls`)
  if (!Array.isArray(associated)) throw new Error('Invalid associated PRs')
  const { artifacts, total_count: total } = await request(
    `actions/runs/${runId}/artifacts?per_page=100`
  )
  if (!Array.isArray(artifacts) || !Number.isSafeInteger(total) || total < 0 || total > 100)
    throw new Error('Invalid preview artifact inventory')
  for (const { number } of associated) {
    if (!positiveId(number)) throw new Error('Invalid PR number')
    const pr = await request(`pulls/${number}`)
    if (
      pr.number !== number ||
      pr.state !== 'open' ||
      pr.head?.sha !== run.head_sha ||
      pr.head.repo?.id !== run.head_repository.id ||
      pr.head.repo?.full_name !== repository ||
      pr.base?.repo?.full_name !== repository ||
      pr.base.ref !== 'v2' ||
      !sha.test(pr.base.sha) ||
      !sha.test(pr.merge_commit_sha)
    )
      continue
    const suffix = `-pr.${number}.${pr.merge_commit_sha.slice(0, 7)}`
    const valid = artifact =>
      positiveId(artifact.id) &&
      !artifact.expired &&
      artifact.size_in_bytes > 0 &&
      artifact.workflow_run?.id === runId &&
      artifact.workflow_run.head_sha === run.head_sha &&
      Date.parse(artifact.created_at) >= Date.parse(run.run_started_at)
    const demos = artifacts.filter(
      artifact =>
        valid(artifact) &&
        /^noir-wallet-demo-v2\.\d+\.\d+-pr\.\d+\.[0-9a-f]{7}$/.test(artifact.name) &&
        artifact.name.endsWith(suffix)
    )
    if (demos.length !== 1) continue
    const label = demos[0].name.slice('noir-wallet-demo-'.length)
    const extensions = artifacts.filter(
      artifact => valid(artifact) && artifact.name === `noir-wallet-development-${label}`
    )
    if (extensions.length !== 1) continue
    return {
      repository,
      runId,
      runAttempt,
      prNumber: number,
      headSha: run.head_sha,
      baseSha: pr.base.sha,
      sourceSha: pr.merge_commit_sha,
      artifactLabel: label,
      artifactId: demos[0].id,
      extensionArtifactId: extensions[0].id
    }
  }
  return null
}

export function validateStaticDemo(directory, source) {
  const metadata = JSON.parse(readFileSync(path.join(directory, 'extension-preview.json'), 'utf8'))
  const expected = {
    schemaVersion: 1,
    mode: 'preview',
    buildChannel: 'development',
    repository: source.repository,
    sourceSha: source.sourceSha,
    prHeadSha: source.headSha,
    prBaseSha: source.baseSha,
    artifactLabel: source.artifactLabel,
    prNumber: String(source.prNumber),
    runId: String(source.runId),
    runAttempt: String(source.runAttempt)
  }
  for (const [key, value] of Object.entries(expected)) {
    if (metadata[key] !== value) throw new Error('Demo and extension provenance mismatch')
  }
  if (!lstatSync(path.join(directory, 'index.html')).isFile()) throw new Error('Missing demo entry')
  const extensions = new Set([
    '.html',
    '.js',
    '.css',
    '.json',
    '.svg',
    '.png',
    '.jpg',
    '.jpeg',
    '.webp',
    '.ico',
    '.woff',
    '.woff2',
    '.ttf'
  ])
  let count = 0
  function validate(parent) {
    for (const name of readdirSync(parent)) {
      const file = path.join(parent, name)
      const stat = lstatSync(file)
      // Keep executable server code and deployment directives out of the publisher.
      if (
        ++count > 1000 ||
        stat.isSymbolicLink() ||
        name.startsWith('.') ||
        name.startsWith('_') ||
        name === 'functions'
      ) {
        throw new Error('Unexpected executable or configuration in static demo')
      }
      if (stat.isDirectory()) validate(file)
      else if (
        !stat.isFile() ||
        stat.size > 25 * 1024 * 1024 ||
        !extensions.has(path.extname(name))
      )
        throw new Error('Unexpected static demo file')
    }
  }
  validate(directory)
}

export function deploymentDemoUrl(repository, source) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid preview URL identity')
  const [owner, name] = repository.split('/')
  return `https://${owner.toLowerCase()}.github.io/${name}/${previewPath(source)}/#noir-public`
}

function previewPath(source) {
  if (
    !positiveId(source.prNumber) ||
    !positiveId(source.runId) ||
    !positiveId(source.runAttempt) ||
    !sha.test(source.sourceSha)
  )
    throw new Error('Invalid preview path identity')
  return `pr/${source.prNumber}/${source.sourceSha}/${source.runId}-${source.runAttempt}`
}

export async function seedExistingPages(directory, repository, request = fetch) {
  const [owner, name] = repository.split('/')
  const root = new URL(`https://${owner.toLowerCase()}.github.io/${name}/`)
  const response = await request(root, { signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error('Cannot preserve existing Pages root')
  const html = await response.text()
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, 'index.html'), html)
  // The existing Vite example constructs its logo URL in JavaScript rather than HTML.
  const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(
    match => new URL(match[1], root)
  )
  references.push(new URL('logo.png', root))
  for (const url of references) {
    if (url.origin !== root.origin) continue
    if (!url.pathname.startsWith(root.pathname) || url.search || url.hash)
      throw new Error('Unexpected existing Pages asset')
    const relative = decodeURIComponent(url.pathname.slice(root.pathname.length))
    if (!/^(?:assets\/)?[\w.-]+\.(?:js|css|ico|png|svg)$/.test(relative))
      throw new Error('Unexpected existing Pages asset path')
    const asset = await request(url, { signal: AbortSignal.timeout(30000) })
    if (!asset.ok) throw new Error('Cannot preserve existing Pages asset')
    const bytes = Buffer.from(await asset.arrayBuffer())
    if (bytes.length > 25 * 1024 * 1024) throw new Error('Existing Pages asset exceeds size limit')
    mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true })
    writeFileSync(path.join(directory, relative), bytes)
  }
}

export function stageDemoSite(archive, preview, output, source) {
  validateStaticDemo(preview, source)
  const target = path.join(archive, previewPath(source))
  if (existsSync(target)) {
    function identical(left, right) {
      const files = readdirSync(left).sort()
      if (JSON.stringify(files) !== JSON.stringify(readdirSync(right).sort())) return false
      return files.every(name => {
        const a = path.join(left, name),
          b = path.join(right, name)
        const stat = lstatSync(b)
        if (stat.isSymbolicLink()) return false
        return lstatSync(a).isDirectory()
          ? stat.isDirectory() && identical(a, b)
          : stat.isFile() && readFileSync(a).equals(readFileSync(b))
      })
    }
    if (!identical(preview, target)) throw new Error('Cannot replace immutable preview contents')
  } else {
    mkdirSync(target, { recursive: true })
    cpSync(preview, target, { recursive: true })
  }
  cpSync(archive, output, { recursive: true, filter: file => path.basename(file) !== '.git' })
}

function githubRequest(repository, token) {
  if (!token) throw new Error('GH_TOKEN is required')
  return async (route, body) => {
    const response = await fetch(`https://api.github.com/repos/${repository}/${route}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000)
    })
    if (response.status === 404 && route === 'git/ref/heads/demo-previews') return null
    if (!response.ok) throw new Error(`Preview GitHub request failed (${response.status})`)
    return response.json()
  }
}

async function main() {
  const env = process.env
  if (env.GITHUB_EVENT_NAME !== 'workflow_run' || env.GITHUB_REF !== 'refs/heads/main')
    throw new Error('Demo publishing requires the trusted main workflow')
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
  if (event.action !== 'completed') throw new Error('Expected a completed build event')
  const resolve = () =>
    resolveDemoPreview({
      repository: env.GITHUB_REPOSITORY,
      runId: event.workflow_run.id,
      runAttempt: event.workflow_run.run_attempt,
      request: githubRequest(env.GITHUB_REPOSITORY, env.GH_TOKEN)
    })
  const command = process.argv[2]
  if (command === 'resolve') {
    const source = await resolve()
    if (!source) return
    writeFileSync('demo-source.json', JSON.stringify(source))
    appendFileSync(
      env.GITHUB_OUTPUT,
      `artifact_id=${source.artifactId}\npr_number=${source.prNumber}\nsource_sha=${source.sourceSha}\n`
    )
    return
  }
  const source = JSON.parse(readFileSync('demo-source.json', 'utf8'))
  // Recheck after download and after deployment; stale runs never advertise a newer PR's preview.
  const current = await resolve()
  if (JSON.stringify(current) !== JSON.stringify(source))
    throw new Error('Preview source changed; rerun Extension CI')
  if (command === 'stage') {
    const request = githubRequest(source.repository, env.GH_TOKEN)
    const archive = 'pages-archive'
    const gitEnv = {
      ...env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${env.GH_TOKEN}`).toString('base64')}`
    }
    const git = args =>
      execFileSync(
        'git',
        ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
        { cwd: archive, env: gitEnv, stdio: 'pipe' }
      )
    mkdirSync(archive)
    git(['init', '--quiet'])
    git(['remote', 'add', 'origin', `https://github.com/${source.repository}.git`])
    const existing = await request('git/ref/heads/demo-previews')
    if (existing) {
      git(['fetch', '--depth=1', 'origin', 'demo-previews'])
      git(['checkout', '--quiet', '-B', 'demo-previews', 'FETCH_HEAD'])
    } else {
      git(['checkout', '--quiet', '--orphan', 'demo-previews'])
      await seedExistingPages(archive, source.repository)
    }
    stageDemoSite(archive, 'preview', 'pages-site', source)
    git(['config', 'user.name', 'github-actions[bot]'])
    git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'])
    git(['add', '--all'])
    if (git(['status', '--porcelain']).toString().trim()) {
      git(['commit', '--quiet', '-m', `Demo PR ${source.prNumber} ${source.sourceSha}`])
      git(['push', 'origin', 'HEAD:refs/heads/demo-previews'])
    }
    return
  }
  if (command !== 'report') throw new Error('Unknown preview command')
  const url = deploymentDemoUrl(source.repository, source)
  const extension = `${env.GITHUB_SERVER_URL}/${source.repository}/actions/runs/${source.runId}/artifacts/${source.extensionArtifactId}`
  const summary = `[Open Public demo](${url}) · [Download paired extension](${extension})\n\nTested merge commit: \`${source.sourceSha}\`. Extension download requires GitHub access and expires after three days.\n`
  await githubRequest(source.repository, env.GH_TOKEN)('check-runs', {
    name: 'Public demo',
    head_sha: source.headSha,
    status: 'completed',
    conclusion: 'success',
    details_url: url,
    output: { title: 'Demo and extension from the same tested merge', summary }
  })
  appendFileSync(env.GITHUB_OUTPUT, `url=${url}\n`)
  appendFileSync(env.GITHUB_STEP_SUMMARY, summary)
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
