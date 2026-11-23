import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  isCurrentAccountNearIncognitoAddress,
  resolveNearAddressRole
} from '../../../src/core/accounts/near-address-role.ts'

const main = 'alice.near'
const implicitMain = '11'.repeat(32)
const pea = 'cd'.repeat(32)
const otherPea = 'ab'.repeat(32)
const external = 'bob.near'

describe('NEAR address roles', () => {
  it('recognizes only this account Main id and its own PEA implicit account', () => {
    const account = { mainAccountId: main, peaImplicitAccountId: pea }
    assert.equal(resolveNearAddressRole(main, account), 'main')
    assert.equal(resolveNearAddressRole(pea, account), 'incognito')
    assert.equal(isCurrentAccountNearIncognitoAddress(pea, account), true)
    assert.equal(isCurrentAccountNearIncognitoAddress(main, account), false)
    assert.equal(
      resolveNearAddressRole(implicitMain, {
        mainAccountId: implicitMain,
        peaImplicitAccountId: pea
      }),
      'main'
    )
  })

  it('does not let labels, external addresses, or other accounts establish a role', () => {
    const account = {
      mainAccountId: main,
      peaImplicitAccountId: pea,
      label: 'Incognito',
      accounts: [{ mainAccountId: external, peaImplicitAccountId: otherPea }]
    }
    assert.equal(resolveNearAddressRole('Incognito', account), 'external')
    assert.equal(resolveNearAddressRole('Savings', account), 'external')
    assert.equal(resolveNearAddressRole(external, account), 'external')
    assert.equal(resolveNearAddressRole(otherPea, account), 'external')
    assert.equal(isCurrentAccountNearIncognitoAddress(otherPea, account), false)
    assert.equal(resolveNearAddressRole(pea, null), 'external')
    assert.equal(resolveNearAddressRole(pea, undefined), 'external')
    assert.equal(isCurrentAccountNearIncognitoAddress(pea, null), false)
  })

  it('requires a canonical id and a distinct implicit PEA', () => {
    const account = { mainAccountId: main, peaImplicitAccountId: pea }
    assert.equal(resolveNearAddressRole('Alice.near', account), 'external')
    assert.equal(resolveNearAddressRole(pea.toUpperCase(), account), 'external')
    assert.equal(resolveNearAddressRole(` ${main}`, account), 'external')
    assert.equal(resolveNearAddressRole('', account), 'external')
    assert.equal(
      resolveNearAddressRole('hidden.near', {
        mainAccountId: main,
        peaImplicitAccountId: 'hidden.near'
      }),
      'external'
    )
    assert.equal(
      isCurrentAccountNearIncognitoAddress('hidden.near', {
        mainAccountId: main,
        peaImplicitAccountId: 'hidden.near'
      }),
      false
    )
    assert.equal(
      resolveNearAddressRole(pea, { mainAccountId: pea, peaImplicitAccountId: pea }),
      'main'
    )
    assert.equal(
      isCurrentAccountNearIncognitoAddress(pea, {
        mainAccountId: pea,
        peaImplicitAccountId: pea
      }),
      false
    )
  })
})
