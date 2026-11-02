import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  selectedZeroIndexerNodeLabel,
  validateZeroIndexerNodeUrl,
  zeroIndexerNodeErrorField
} from '../../../../src/popup/services/zero-indexer-node-model.ts'

const baseStatus = {
  network: 'mainnet',
  enabled: true,
  mode: 'auto',
  selectedEndpointId: null,
  managedEndpoints: [{ id: 'managed', label: 'Managed', url: 'https://managed.example' }],
  customEndpoints: [{ id: 'custom:one', label: 'Mine', url: 'https://mine.example' }],
  orderedEndpointIds: ['managed', 'custom:one'],
  probes: {}
}

describe('ZeroIndexer node settings', () => {
  it('shows Auto or the fixed node, including a custom node', () => {
    assert.equal(selectedZeroIndexerNodeLabel(baseStatus), 'Auto')
    assert.equal(
      selectedZeroIndexerNodeLabel({
        ...baseStatus,
        mode: 'fixed',
        selectedEndpointId: 'custom:one'
      }),
      'Mine'
    )
  })

  it('keeps invalid URLs in the URL field before asking the background to verify a node', () => {
    assert.equal(validateZeroIndexerNodeUrl(''), 'Enter a URL')
    assert.equal(validateZeroIndexerNodeUrl('http://node.example')?.includes('HTTPS'), true)
    assert.equal(
      validateZeroIndexerNodeUrl('https://user:pass@node.example')?.includes('HTTPS'),
      true
    )
    assert.equal(
      validateZeroIndexerNodeUrl('https://node.example?key=value')?.includes('HTTPS'),
      true
    )
    assert.equal(validateZeroIndexerNodeUrl(' https://node.example '), null)
    assert.equal(zeroIndexerNodeErrorField('Invalid ZeroIndexer name'), 'name')
    assert.equal(zeroIndexerNodeErrorField('Invalid ZeroIndexer URL'), 'url')
  })
})
