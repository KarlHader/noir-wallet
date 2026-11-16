import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  createKeyringCommandSuccess,
  parseKeyringCommand
} from '../../../../src/core/keyring/ports/index.ts'
import { parseChainId } from '../../../../src/core/chains/registry/index.ts'
import { parseKeyDomainId } from '../../../../src/core/keyring/domain/index.ts'
import { BitcoinMultichainDerivationClient } from '../../../../src/infrastructure/keyring/multichain/bitcoin-derivation-client.ts'
import { decodeChromeRuntimeCommand } from '../../../../src/infrastructure/keyring/multichain/chrome-runtime-codec.ts'

const chainId = parseChainId('bip122:000000000019d6689c085ae165831e93').id
const keyDomainId = parseKeyDomainId('key-domain:bitcoin-derivation-test')
const binding = {
  kind: 'credential',
  keyDomainId,
  credentialGenerationId: 'credential-generation:1',
  globalUnlockEpoch: 'global-unlock:1'
}
const address = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'

function derivedValue(overrides = {}) {
  return {
    chainId,
    derivation: { scheme: 'bip84', path: "m/84'/0'/0'/0/0" },
    identity: { kind: 'account-identifier', value: address },
    addresses: [
      {
        value: address,
        scheme: 'bitcoin_p2wpkh',
        purpose: 'receive',
        derivation: { scheme: 'bip84', path: "m/84'/0'/0'/0/0" }
      }
    ],
    publicKey: `0x02${'1'.repeat(64)}`,
    masterFingerprint: '0x73c5da0a',
    scriptPubKey: `0x0014${'2'.repeat(40)}`,
    ...overrides
  }
}

test('derives a Bitcoin public address through the attested Background binding', async () => {
  const calls = []
  const client = new BitcoinMultichainDerivationClient({
    credentials: {
      getCredentialBinding: async requested => {
        calls.push(['binding', requested])
        return binding
      }
    },
    now: () => 1_000,
    createCommandId: () => 'keyring-command:bitcoin-derive:1',
    forward: async (method, forwardedPayload) => {
      expect(method).toBe('multichain.execute')
      const command = parseKeyringCommand(decodeChromeRuntimeCommand(forwardedPayload.command))
      calls.push([command.operation, command.binding, command.payload])
      return createKeyringCommandSuccess(command.commandId, derivedValue())
    }
  })

  await expect(
    client.deriveAddress(keyDomainId, {
      chainId,
      addressType: 'p2wpkh',
      accountIndex: 0,
      change: false,
      addressIndex: 0
    })
  ).resolves.toEqual({
    chainId,
    addressType: 'p2wpkh',
    accountIndex: 0,
    change: false,
    addressIndex: 0,
    address,
    addressScheme: 'bitcoin-p2wpkh',
    derivationScheme: 'bip84',
    derivationPath: "m/84'/0'/0'/0/0",
    publicKey: `0x02${'1'.repeat(64)}`,
    masterFingerprint: '0x73c5da0a',
    scriptPubKey: `0x0014${'2'.repeat(40)}`
  })
  expect(calls).toEqual([
    ['binding', keyDomainId],
    [
      'account.derive-public',
      binding,
      {
        family: 'bitcoin',
        chainId,
        addressType: 'p2wpkh',
        accountIndex: 0,
        change: false,
        addressIndex: 0
      }
    ]
  ])
  await client.destroy()
})

test('derives a bounded Bitcoin address batch in one WASM command', async () => {
  const payloads = []
  const client = new BitcoinMultichainDerivationClient({
    credentials: { getCredentialBinding: async () => binding },
    now: () => 1_000,
    createCommandId: () => 'keyring-command:bitcoin-batch',
    forward: async (_method, forwardedPayload) => {
      const command = parseKeyringCommand(decodeChromeRuntimeCommand(forwardedPayload.command))
      payloads.push(command.payload)
      return createKeyringCommandSuccess(command.commandId, [
        derivedValue(),
        derivedValue({
          derivation: { scheme: 'bip84', path: "m/84'/0'/0'/0/1" },
          addresses: [
            {
              value: address,
              scheme: 'bitcoin_p2wpkh',
              purpose: 'receive',
              derivation: { scheme: 'bip84', path: "m/84'/0'/0'/0/1" }
            }
          ]
        })
      ])
    }
  })

  const accounts = await client.deriveAddresses(keyDomainId, {
    chainId,
    addressType: 'p2wpkh',
    accountIndex: 0,
    change: false,
    startAddressIndex: 0,
    count: 2
  })
  expect(accounts.map(account => account.addressIndex)).toEqual([0, 1])
  expect(payloads).toEqual([
    {
      family: 'bitcoin',
      chainId,
      addressType: 'p2wpkh',
      accountIndex: 0,
      change: false,
      startAddressIndex: 0,
      count: 2
    }
  ])
  await client.destroy()
})

test('maps BIP-44 and BIP-49 derivation requests to the WASM address types', async () => {
  const cases = [
    {
      addressType: 'p2pkh',
      rawAddressType: 'p2pkh',
      address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
      scheme: 'bitcoin_p2pkh',
      publicScheme: 'bitcoin-p2pkh',
      derivationScheme: 'bip44',
      purpose: 44,
      scriptPubKey: `0x76a914${'2'.repeat(40)}88ac`
    },
    {
      addressType: 'p2sh-p2wpkh',
      rawAddressType: 'p2sh_p2wpkh',
      address: '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
      scheme: 'bitcoin_p2sh_p2wpkh',
      publicScheme: 'bitcoin-p2sh-p2wpkh',
      derivationScheme: 'bip49',
      purpose: 49,
      scriptPubKey: `0xa914${'2'.repeat(40)}87`,
      redeemScript: `0x0014${'3'.repeat(40)}`
    }
  ]
  for (const fixture of cases) {
    let payload
    const client = new BitcoinMultichainDerivationClient({
      credentials: { getCredentialBinding: async () => binding },
      forward: async (_method, forwardedPayload) => {
        const command = parseKeyringCommand(decodeChromeRuntimeCommand(forwardedPayload.command))
        payload = command.payload
        const path = `m/${fixture.purpose}'/0'/0'/0/0`
        return createKeyringCommandSuccess(command.commandId, {
          chainId,
          derivation: { scheme: fixture.derivationScheme, path },
          identity: { kind: 'account-identifier', value: fixture.address },
          addresses: [
            {
              value: fixture.address,
              scheme: fixture.scheme,
              purpose: 'receive',
              derivation: { scheme: fixture.derivationScheme, path }
            }
          ],
          publicKey: `0x02${'1'.repeat(64)}`,
          masterFingerprint: '0x73c5da0a',
          scriptPubKey: fixture.scriptPubKey,
          ...(fixture.redeemScript === undefined ? {} : { redeemScript: fixture.redeemScript })
        })
      }
    })
    await expect(
      client.deriveAddress(keyDomainId, {
        chainId,
        addressType: fixture.addressType,
        accountIndex: 0,
        change: false,
        addressIndex: 0
      })
    ).resolves.toMatchObject({
      address: fixture.address,
      addressScheme: fixture.publicScheme,
      derivationScheme: fixture.derivationScheme,
      scriptPubKey: fixture.scriptPubKey
    })
    expect(payload.addressType).toBe(fixture.rawAddressType)
    await client.destroy()
  }
})

test('rejects a derived address whose path or address metadata does not match the request', async () => {
  for (const value of [
    derivedValue({ derivation: { scheme: 'bip84', path: "m/84'/0'/1'/0/0" } }),
    derivedValue({ masterFingerprint: '0x73C5DA0A' }),
    derivedValue({ masterFingerprint: '0x73c5da0a00' }),
    derivedValue({
      identity: { kind: 'account-identifier', value: `${address.slice(0, -1)}x` },
      addresses: [
        {
          value: `${address.slice(0, -1)}x`,
          scheme: 'bitcoin_p2wpkh',
          purpose: 'receive',
          derivation: { scheme: 'bip84', path: "m/84'/0'/0'/0/0" }
        }
      ]
    }),
    derivedValue({
      addresses: [
        {
          value: address,
          scheme: 'bitcoin_p2tr',
          purpose: 'receive',
          derivation: { scheme: 'bip84', path: "m/84'/0'/0'/0/0" }
        }
      ]
    })
  ]) {
    const client = new BitcoinMultichainDerivationClient({
      credentials: { getCredentialBinding: async () => binding },
      now: () => 1_000,
      createCommandId: () => 'keyring-command:bitcoin-invalid',
      forward: async (_method, forwardedPayload) => {
        const command = parseKeyringCommand(decodeChromeRuntimeCommand(forwardedPayload.command))
        return createKeyringCommandSuccess(command.commandId, value)
      }
    })

    await expect(
      client.deriveAddress(keyDomainId, {
        chainId,
        addressType: 'p2wpkh',
        accountIndex: 0,
        change: false,
        addressIndex: 0
      })
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await client.destroy()
  }
})

test('fails before transport for unsupported chains and exhausted indexes', async () => {
  const calls = []
  const client = new BitcoinMultichainDerivationClient({
    credentials: {
      getCredentialBinding: async () => {
        calls.push('binding')
        return binding
      }
    },
    forward: async () => {
      calls.push('forward')
    }
  })

  await expect(
    client.deriveAddress(keyDomainId, {
      chainId: parseChainId('bip122:00000000da84f2bafbbc53dee25a72ae').id,
      addressType: 'p2wpkh',
      accountIndex: 0,
      change: false,
      addressIndex: 0
    })
  ).rejects.toThrow(/Unsupported Bitcoin chain ID/)
  await expect(
    client.deriveAddress(keyDomainId, {
      chainId,
      addressType: 'p2wpkh',
      accountIndex: 0,
      change: false,
      addressIndex: 0x80000000
    })
  ).rejects.toThrow(/Invalid Bitcoin address index/)
  expect(calls).toEqual([])
  await client.destroy()
})
