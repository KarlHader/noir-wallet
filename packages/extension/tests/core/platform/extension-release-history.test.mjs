import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  collectReleaseCommits,
  formatReleaseCommitLog,
  validateReleaseCommits
} from '../../../../../scripts/lib/extension-release-history.mjs'

const sha = digit => digit.repeat(40)
const commit = (digit, message, parents = [sha('f')]) => ({
  sha: sha(digit),
  commit: { message },
  parents: parents.map(parentSha => ({ sha: parentSha }))
})

describe('Release commit history', () => {
  it('pins the query and retains the first 20 eligible commits in API order', async () => {
    const routes = []
    const response = [
      commit('1', 'Merge pull request #42', [sha('a'), sha('b')]),
      commit('2', 'ci(build): refresh runner'),
      commit('3', 'fix(ci): repair release job'),
      commit('4', 'chore(deps): update'),
      commit('5', 'test(wallet): add coverage'),
      commit('6', 'feat(wallet): restore history\n\nLong body ignored'),
      commit('7', 'fix(wallet): retain deposits'),
      commit('8', 'perf(sync): reduce scans'),
      commit('9', 'docs: explain setup'),
      ...Array.from({ length: 16 }, (_, index) => ({
        ...commit('a', `feat: change ${index}`),
        sha: index.toString(16).padStart(40, '0')
      }))
    ]
    const result = await collectReleaseCommits({
      sourceSha: sha('e'),
      request: async route => {
        routes.push(route)
        return response
      }
    })

    assert.deepEqual(routes, [`commits?sha=${sha('e')}&per_page=100`])
    assert.equal(result.length, 20)
    assert.deepEqual(result.slice(0, 4), [
      { sha: sha('6'), subject: 'feat(wallet): restore history' },
      { sha: sha('7'), subject: 'fix(wallet): retain deposits' },
      { sha: sha('8'), subject: 'perf(sync): reduce scans' },
      { sha: sha('9'), subject: 'docs: explain setup' }
    ])
    assert.equal(result.at(-1).subject, 'feat: change 15')
  })

  it('rejects malformed GitHub data, even after the displayed limit', async () => {
    const valid = Array.from({ length: 20 }, (_, index) =>
      commit(String(index % 10), `feat: update ${index}`)
    )
    valid.forEach((item, index) => {
      item.sha = index.toString(16).padStart(40, '0')
    })
    const invalid = [
      { ...commit('a', 'feat: missing parents'), parents: undefined },
      commit('b', 'feat: invalid parent', ['bad']),
      commit('c', '\nOnly a body'),
      { ...commit('d', 'feat: missing details'), commit: null },
      { ...commit('e', 'feat: bad SHA'), sha: 'bad' }
    ]
    for (const item of invalid) {
      await assert.rejects(
        collectReleaseCommits({ sourceSha: sha('f'), request: async () => [...valid, item] }),
        /GitHub commit 21/
      )
    }
    await assert.rejects(
      collectReleaseCommits({ sourceSha: sha('f'), request: async () => ({ commits: [] }) }),
      /GitHub commit response must be an array/
    )
    await assert.rejects(
      collectReleaseCommits({ sourceSha: 'bad', request: async () => [] }),
      /Source SHA/
    )
  })

  it('bounds long subjects and validates serialized commit entries', async () => {
    const [entry] = await collectReleaseCommits({
      sourceSha: sha('a'),
      request: async () => [commit('b', `feat: ${'x'.repeat(240)}\nignored body`)]
    })
    assert.equal(entry.subject.length, 200)
    assert.deepEqual(validateReleaseCommits([entry]), [entry])

    for (const invalid of [
      [{ ...entry, extra: true }],
      [{ ...entry, sha: 'B'.repeat(40) }],
      [{ ...entry, subject: 'feat: bad\nsecond line' }],
      [{ ...entry, subject: '' }],
      [{ ...entry, subject: 'x'.repeat(201) }],
      [entry, entry],
      Array.from({ length: 21 }, () => entry)
    ]) {
      assert.throws(() => validateReleaseCommits(invalid))
    }
  })

  it('escapes untrusted subjects without changing the Markdown structure', () => {
    const subject = 'fix: <script>alert("x")</script> [click](https://evil.example) & `code`'
    const body = formatReleaseCommitLog('NoirWallet/noir-wallet', [{ sha: sha('a'), subject }])
    assert.match(body, /^<details>\n<summary>Commit log \(1 commits\)<\/summary>\n/)
    assert.match(body, new RegExp(`https://github\\.com/NoirWallet/noir-wallet/commit/${sha('a')}`))
    assert.match(body, /&lt;script&gt;/)
    assert.match(body, /\\\[click\\\]\\\(https:\/\/evil\\\.example\\\)/)
    assert.match(body, /&amp; \\`code\\`/)
    assert.doesNotMatch(body, /<script>/)
    assert.equal((body.match(/^- /gm) || []).length, 1)
    assert.match(
      formatReleaseCommitLog('NoirWallet/noir-wallet', []),
      /Infrastructure changes only\./
    )
    assert.throws(
      () => formatReleaseCommitLog('owner/repo)\nattack', []),
      /Invalid release repository/
    )
  })
})
