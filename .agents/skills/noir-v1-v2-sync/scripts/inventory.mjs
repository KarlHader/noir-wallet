#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const CHECKPOINT_PATH = 'docs/v1-v2-sync/checkpoint.json'

function fail(message) {
  console.error(`inventory: ${message}`)
  process.exit(1)
}

function git(args, { allowFailure = false, encoding = 'utf8' } = {}) {
  const result = spawnSync('git', args, { encoding, maxBuffer: 64 * 1024 * 1024 })
  if (result.error) fail(`could not run git: ${result.error.message}`)
  if (result.status !== 0 && !allowFailure) {
    const detail = String(result.stderr ?? '').trim()
    fail(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`)
  }
  return result
}

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: inventory.mjs --source <ref> --target <ref> [--base <sha>] [--format markdown|json]'
      )
      process.exit(0)
    }
    if (!['--source', '--target', '--base', '--format'].includes(arg)) {
      fail(`unknown option: ${arg}`)
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) fail(`missing value for ${arg}`)
    index += 1
    const key = arg.slice(2)
    if (values[key] !== undefined) fail(`option supplied more than once: ${arg}`)
    values[key] = value
  }
  values.format ??= 'markdown'
  if (!values.source) fail('required option missing: --source')
  if (!values.target) fail('required option missing: --target')
  if (!['markdown', 'json'].includes(values.format)) {
    fail('--format must be markdown or json')
  }
  return values
}

function resolveCommit(ref, label) {
  const result = git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], {
    allowFailure: true
  })
  if (result.status !== 0) fail(`invalid ${label} ref: ${ref}`)
  return result.stdout.trim()
}

function readCheckpoint() {
  let content
  try {
    content = readFileSync(resolve(CHECKPOINT_PATH), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    fail(`could not read ${CHECKPOINT_PATH}: ${error.message}`)
  }

  let checkpoint
  try {
    checkpoint = JSON.parse(content)
  } catch (error) {
    fail(`${CHECKPOINT_PATH} is not valid JSON: ${error.message}`)
  }
  const validSha = value => typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value)
  if (
    !checkpoint ||
    typeof checkpoint !== 'object' ||
    checkpoint.schemaVersion !== 1 ||
    typeof checkpoint.sourceRef !== 'string' ||
    checkpoint.sourceRef.length === 0 ||
    typeof checkpoint.targetRef !== 'string' ||
    checkpoint.targetRef.length === 0 ||
    !checkpoint.reviewedSource ||
    typeof checkpoint.reviewedSource !== 'object' ||
    !validSha(checkpoint.reviewedSource.sha) ||
    !(
      checkpoint.reviewedSource.tag === null || typeof checkpoint.reviewedSource.tag === 'string'
    ) ||
    !validSha(checkpoint.targetBaselineSha) ||
    typeof checkpoint.reportPath !== 'string' ||
    checkpoint.reportPath.length === 0
  ) {
    fail(
      `${CHECKPOINT_PATH} must follow schemaVersion 1 with sourceRef, targetRef, reviewedSource.sha/tag, targetBaselineSha, and reportPath`
    )
  }
  return checkpoint
}

function nulFields(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean)
}

function changedFiles(from, to) {
  const result = git(['diff', '--no-renames', '--name-only', '-z', from, to], {
    encoding: 'buffer'
  })
  return [...new Set(nulFields(result.stdout))].sort()
}

function diffSize(from, to) {
  const result = git(['diff', '--no-renames', '--numstat', '-z', from, to], {
    encoding: 'buffer'
  })
  const stats = { additions: 0, deletions: 0, binaryFiles: 0 }
  const records = nulFields(result.stdout)
  for (const record of records) {
    const firstTab = record.indexOf('\t')
    const secondTab = record.indexOf('\t', firstTab + 1)
    if (firstTab < 0 || secondTab < 0) fail('could not parse git numstat output')
    const additions = record.slice(0, firstTab)
    const deletions = record.slice(firstTab + 1, secondTab)
    if (additions === '-' || deletions === '-') {
      stats.binaryFiles += 1
    } else {
      stats.additions += Number(additions)
      stats.deletions += Number(deletions)
    }
  }
  return stats
}

function sourceUnits(base, source, targetFileSet) {
  const history = git(['rev-list', '--first-parent', '--reverse', `${base}..${source}`])
  return history.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(sha => {
      const parentsAndSubject = git(['show', '-s', '--format=%P%x00%s', sha]).stdout.trimEnd()
      const separator = parentsAndSubject.indexOf('\0')
      const parents = parentsAndSubject.slice(0, separator).split(' ').filter(Boolean)
      const subject = parentsAndSubject.slice(separator + 1)
      const parent = parents[0]
      if (!parent) fail(`source unit has no first parent: ${sha}`)
      const files = changedFiles(parent, sha)
      const overlap = files.filter(file => targetFileSet.has(file))
      return {
        sha,
        subject,
        firstParent: parent,
        files,
        changeSize: diffSize(parent, sha),
        v2Overlap: overlap
      }
    })
}

function buildReport(args) {
  const sourceSha = resolveCommit(args.source, 'source')
  const targetSha = resolveCommit(args.target, 'target')
  let baseSha
  let baseSource
  let checkpoint = null
  if (args.base) {
    baseSha = resolveCommit(args.base, 'base')
    baseSource = 'explicit'
  } else {
    checkpoint = readCheckpoint()
    if (checkpoint) {
      baseSha = resolveCommit(checkpoint.reviewedSource.sha, 'checkpoint reviewed source')
      baseSource = 'checkpoint'
    } else {
      const mergeBase = git(['merge-base', sourceSha, targetSha], { allowFailure: true })
      if (mergeBase.status !== 0) fail('source and target refs have no merge-base')
      baseSha = mergeBase.stdout.trim()
      baseSource = 'merge-base'
    }
  }

  const sourceFirstParents = new Set(
    git(['rev-list', '--first-parent', sourceSha]).stdout.trim().split('\n')
  )
  if (!sourceFirstParents.has(baseSha)) {
    fail(`base ${baseSha} is not on the source ref's first-parent chain`)
  }
  const mergeBase = git(['merge-base', sourceSha, targetSha], { allowFailure: true })
  if (mergeBase.status !== 0) fail('source and target refs have no merge-base')
  const comparisonBase = mergeBase.stdout.trim()
  const targetFiles = changedFiles(comparisonBase, targetSha)
  const units = sourceUnits(baseSha, sourceSha, new Set(targetFiles))
  const report = {
    source: { ref: args.source, sha: sourceSha },
    target: { ref: args.target, sha: targetSha },
    base: { sha: baseSha, selectedBy: baseSource },
    comparisonBase: { sha: comparisonBase, selectedBy: 'merge-base' },
    sourceFirstParentUnitCount: units.length,
    targetChangedFiles: targetFiles,
    units
  }
  if (checkpoint) {
    const checkpointSourceSha = resolveCommit(checkpoint.sourceRef, 'checkpoint source ref')
    const checkpointTargetSha = resolveCommit(checkpoint.targetRef, 'checkpoint target ref')
    const targetBaselineSha = resolveCommit(
      checkpoint.targetBaselineSha,
      'checkpoint target baseline'
    )
    const checkpointSourceFirstParents = new Set(
      git(['rev-list', '--first-parent', checkpointSourceSha]).stdout.trim().split('\n')
    )
    if (!checkpointSourceFirstParents.has(baseSha)) {
      fail(`checkpoint reviewed source ${baseSha} is not on its source ref's first-parent chain`)
    }
    const checkpointTargetAncestors = new Set(
      git(['rev-list', checkpointTargetSha]).stdout.trim().split('\n')
    )
    if (!checkpointTargetAncestors.has(targetBaselineSha)) {
      fail(`checkpoint target baseline ${targetBaselineSha} is not an ancestor of its target ref`)
    }
    const targetAncestors = new Set(git(['rev-list', targetSha]).stdout.trim().split('\n'))
    if (!targetAncestors.has(targetBaselineSha)) {
      fail(`checkpoint target baseline ${targetBaselineSha} is not an ancestor of the target ref`)
    }
    report.checkpoint = {
      sourceRef: checkpoint.sourceRef,
      targetRef: checkpoint.targetRef,
      reviewedSourceSha: baseSha,
      targetBaselineSha,
      reportPath: checkpoint.reportPath
    }
  }
  return report
}

function markdown(report) {
  const lines = [
    '# V1 to V2 Inventory',
    '',
    `- Source: \`${report.source.sha}\` (\`${report.source.ref}\`)`,
    `- Target: \`${report.target.sha}\` (\`${report.target.ref}\`)`,
    `- First-parent source units: ${report.sourceFirstParentUnitCount}`,
    `- Source unit base: \`${report.base.sha}\` (${report.base.selectedBy})`,
    `- V2 overlap base: \`${report.comparisonBase.sha}\` (merge-base)`,
    `- Target changed paths since merge-base: ${report.targetChangedFiles.length}`,
    '',
    '| Source unit | Subject | Files | Additions | Deletions | Binary | V2 overlap |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- |'
  ]
  for (const unit of report.units) {
    const subject = unit.subject.replaceAll('|', '\\|').replaceAll('\n', ' ')
    const files = unit.files.map(file => `\`${file.replaceAll('`', '\\`')}\``).join(', ')
    const overlap = unit.v2Overlap.map(file => `\`${file.replaceAll('`', '\\`')}\``).join(', ')
    lines.push(
      `| \`${unit.sha.slice(0, 12)}\` | ${subject} | ${files || '-'} | ${unit.changeSize.additions} | ${unit.changeSize.deletions} | ${unit.changeSize.binaryFiles} | ${overlap || '-'} |`
    )
  }
  return `${lines.join('\n')}\n`
}

const args = parseArgs(process.argv.slice(2))
const report = buildReport(args)
if (args.format === 'json') console.log(JSON.stringify(report, null, 2))
else process.stdout.write(markdown(report))
