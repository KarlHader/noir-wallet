import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  deploymentDemoUrl,
  resolveDemoPreview,
  seedExistingPages,
  stageDemoSite,
  validateStaticDemo
} from '../../../../../scripts/demo-preview.mjs'

function fixture() {
  const repository = 'NoirWallet/noir-wallet'
  const headSha = 'a'.repeat(40)
  const baseSha = 'b'.repeat(40)
  const sourceSha = 'c'.repeat(40)
  const label = 'v2.0.0-pr.7.ccccccc'
  const run = {
    id: 12,
    run_attempt: 2,
    path: '.github/workflows/extension-ci.yml',
    event: 'pull_request',
    repository: { full_name: repository },
    head_repository: { id: 9, full_name: repository },
    head_sha: headSha,
    status: 'completed',
    conclusion: 'success',
    pull_requests: [{ number: 7 }],
    run_started_at: '2026-11-03T00:00:00Z'
  }
  const pr = {
    number: 7,
    state: 'open',
    head: { sha: headSha, repo: { id: 9, full_name: repository } },
    base: { sha: baseSha, ref: 'v2', repo: { full_name: repository } },
    merge_commit_sha: sourceSha
  }
  const artifact = (id, name) => ({
    id,
    name,
    expired: false,
    size_in_bytes: 1234,
    workflow_run: { id: 12, head_sha: headSha },
    created_at: '2026-11-03T00:01:00Z'
  })
  const artifacts = [
    artifact(21, `noir-wallet-demo-${label}`),
    artifact(22, `noir-wallet-development-${label}`)
  ]
  const source = {
    repository,
    runId: 12,
    runAttempt: 2,
    prNumber: 7,
    headSha,
    baseSha,
    sourceSha,
    artifactLabel: label,
    artifactId: 21,
    extensionArtifactId: 22
  }
  const request = async route => {
    if (route === 'actions/runs/12') return run
    if (route === 'actions/runs/12/artifacts?per_page=100')
      return { artifacts, total_count: artifacts.length }
    if (route === 'pulls/7') return pr
    if (route === `commits/${headSha}/pulls`) return [{ number: 7 }]
    throw new Error('Unexpected GitHub request')
  }
  return {
    run,
    pr,
    artifacts,
    source,
    resolve: () => resolveDemoPreview({ repository, runId: 12, runAttempt: 2, request })
  }
}

function staticDemo(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'noir-demo-preview-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const source = fixture().source
  const metadata = {
    schemaVersion: 1,
    mode: 'preview',
    buildChannel: 'development',
    repository: source.repository,
    sourceSha: source.sourceSha,
    prHeadSha: source.headSha,
    prBaseSha: source.baseSha,
    artifactLabel: source.artifactLabel,
    prNumber: '7',
    runId: '12',
    runAttempt: '2'
  }
  writeFileSync(path.join(directory, 'index.html'), '<div id="root"></div>')
  mkdirSync(path.join(directory, 'assets'))
  writeFileSync(path.join(directory, 'assets/index.js'), 'export {}')
  const save = () =>
    writeFileSync(path.join(directory, 'extension-preview.json'), JSON.stringify(metadata))
  save()
  return { directory, source, metadata, save }
}

test('publishes only a current same-repository PR with paired artifacts from one run', async () => {
  const good = fixture()
  assert.deepEqual(await good.resolve(), good.source)
  good.run.pull_requests = []
  assert.deepEqual(await good.resolve(), good.source)
  for (const mutate of [
    f => {
      f.run.head_repository.full_name = 'contributor/fork'
    },
    f => {
      f.run.event = 'push'
    },
    f => {
      f.run.path = '.github/workflows/other.yml'
    },
    f => {
      f.run.conclusion = 'failure'
    },
    f => {
      f.run.run_attempt = 3
    },
    f => {
      f.pr.state = 'closed'
    },
    f => {
      f.pr.head.sha = 'd'.repeat(40)
    },
    f => {
      f.pr.merge_commit_sha = 'e'.repeat(40)
    },
    f => {
      f.artifacts[1].expired = true
    },
    f => {
      f.artifacts[0].workflow_run.id = 13
    },
    f => {
      f.artifacts[0].created_at = '2026-11-02T23:59:00Z'
    },
    f => {
      f.artifacts.push({ ...f.artifacts[0], id: 23 })
    }
  ]) {
    const changed = fixture()
    mutate(changed)
    assert.equal(await changed.resolve(), null)
  }
})

test('static upload is bound to the exact tested merge, PR, and run attempt', t => {
  const f = staticDemo(t)
  assert.doesNotThrow(() => validateStaticDemo(f.directory, f.source))
  for (const key of [
    'sourceSha',
    'prHeadSha',
    'prBaseSha',
    'prNumber',
    'runId',
    'runAttempt',
    'repository',
    'artifactLabel',
    'mode'
  ]) {
    const original = f.metadata[key]
    f.metadata[key] = 'mismatch'
    f.save()
    assert.throws(() => validateStaticDemo(f.directory, f.source), /provenance mismatch/)
    f.metadata[key] = original
  }
})

test('Pages worker, functions, deployment directives, and symlinks cannot enter the publisher', t => {
  const f = staticDemo(t)
  for (const name of ['_worker.js', '_headers', '_redirects', '.env', 'functions']) {
    const file = path.join(f.directory, name)
    writeFileSync(file, 'unexpected')
    assert.throws(() => validateStaticDemo(f.directory, f.source), /executable or configuration/)
    rmSync(file)
  }
  symlinkSync(path.join(f.directory, 'index.html'), path.join(f.directory, 'linked.html'))
  assert.throws(() => validateStaticDemo(f.directory, f.source), /executable or configuration/)
})

test('reported links bind the PR, merge commit, and exact build attempt', () => {
  const { source } = fixture()
  assert.equal(
    deploymentDemoUrl(source.repository, source),
    `https://noirwallet.github.io/noir-wallet/pr/7/${source.sourceSha}/12-2/#noir-public`
  )
  assert.notEqual(
    deploymentDemoUrl(source.repository, source),
    deploymentDemoUrl(source.repository, { ...source, runAttempt: 3 })
  )
  assert.throws(() => deploymentDemoUrl(source.repository, { ...source, sourceSha: '../other' }))
  assert.throws(() => deploymentDemoUrl(source.repository, { ...source, prNumber: '../other' }))
})

test('adding a preview preserves the root and other PRs, excludes git metadata, and allows an identical retry', t => {
  const f = staticDemo(t)
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'noir-demo-site-'))
  t.after(() => rmSync(temporary, { recursive: true, force: true }))
  const archive = path.join(temporary, 'archive')
  const output = path.join(temporary, 'site')
  mkdirSync(path.join(archive, '.git'), { recursive: true })
  writeFileSync(path.join(archive, '.git/config'), 'must not be deployed')
  writeFileSync(path.join(archive, 'index.html'), 'existing SDK example')
  mkdirSync(path.join(archive, 'pr/5'), { recursive: true })
  writeFileSync(path.join(archive, 'pr/5/index.html'), 'other PR')
  stageDemoSite(archive, f.directory, output, f.source)
  assert.equal(readFileSync(path.join(output, 'index.html'), 'utf8'), 'existing SDK example')
  assert.equal(readFileSync(path.join(output, 'pr/5/index.html'), 'utf8'), 'other PR')
  assert.equal(existsSync(path.join(output, '.git')), false)
  const preview = path.join(output, 'pr/7', f.source.sourceSha, '12-2', 'index.html')
  assert.equal(readFileSync(preview, 'utf8'), '<div id="root"></div>')
  assert.doesNotThrow(() => stageDemoSite(archive, f.directory, output, f.source))
  writeFileSync(path.join(f.directory, 'index.html'), 'changed')
  assert.throws(() => stageDemoSite(archive, f.directory, output, f.source), /immutable preview/)
})

test('first publication preserves deployed Vite root assets and rejects paths outside the site', async t => {
  const f = staticDemo(t)
  const html =
    '<script src="/noir-wallet/assets/app.js"></script><link href="/noir-wallet/favicon.ico">'
  const requests = []
  const request = async url => {
    requests.push(url.href)
    return new Response(url.pathname.endsWith('/') ? html : new Uint8Array([0, 1, 255]))
  }
  await seedExistingPages(f.directory, f.source.repository, request)
  assert.equal(readFileSync(path.join(f.directory, 'index.html'), 'utf8'), html)
  assert.deepEqual([...readFileSync(path.join(f.directory, 'assets/app.js'))], [0, 1, 255])
  assert.deepEqual([...readFileSync(path.join(f.directory, 'logo.png'))], [0, 1, 255])
  assert.equal(requests.length, 4)
  await assert.rejects(
    () =>
      seedExistingPages(
        f.directory,
        f.source.repository,
        async () => new Response('<script src="/other-site/app.js"></script>')
      ),
    /Unexpected existing Pages asset/
  )
})
