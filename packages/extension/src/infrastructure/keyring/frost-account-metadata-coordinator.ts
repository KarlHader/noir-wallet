import { commitCredentialBoundStorageV2Pointer } from '@/core/keyring/application'
import { getZcashChainId } from '@/core/chains/registry'
import {
  parseStorageV2Snapshot,
  parseStorageV2GenerationId,
  parseStorageV2SourceFingerprint
} from '@/infrastructure/persistence/schema'
import type { CredentialRepository, StorageV2Repository } from '@/ports/repositories'
import type { MultisigCreationOperation } from '@/lib/multisig-creation-storage'
import type { AccountData } from '@/types/wallet'
import { bytesToHex } from '@/lib/bytes'
import { WALLET_STATE_KEY } from '@/lib/wallet-metadata-storage'

/** Called inside the shared undeleted-account metadata lock by Background creation. */
export class FrostAccountMetadataCoordinator {
  constructor(
    private readonly credentials: CredentialRepository,
    private readonly storage: StorageV2Repository
  ) {}

  async commit(
    op: MultisigCreationOperation,
    account: AccountData,
    assertAuthorized: () => Promise<void>
  ): Promise<void> {
    if (
      !account.source ||
      account.id !== op.scope.accountId ||
      account.source.groupId !== op.groupId ||
      account.source.network !== op.scope.network ||
      !account.addresses.shielded
    )
      throw new Error('Invalid external account metadata')
    for (let attempt = 0; attempt < 3; attempt++) {
      await assertAuthorized()
      const pointer = await this.storage.getActivePointer()
      if (!pointer) throw new Error('Verified wallet storage is required')
      const source = await this.storage.getSnapshot(pointer.generationId)
      if (
        !source ||
        source.manifest.status !== 'verified' ||
        source.manifest.sourceFingerprint !== pointer.sourceFingerprint ||
        source.manifest.verifiedAt === undefined
      )
        throw new Error('Verified wallet storage is unavailable')
      const owner = source.keyDomains.find(w => w.id === op.scope.walletId)
      if (!owner || owner.source.kind !== 'software')
        throw new Error('External account owner is unavailable')
      const prior = source.accounts.find(a => a.id === account.id)
      if (prior) {
        if (
          prior.keyDomainId !== owner.id ||
          !prior.source ||
          prior.source.groupId !== op.groupId ||
          prior.source.network !== account.source.network
        )
          throw new Error('Account identity conflicts with creation')
        const chain = source.chainAccounts.find(c => c.scope.accountId === prior.id)
        if (
          !chain?.source ||
          chain.source.groupId !== op.groupId ||
          !source.addresses.some(
            a => a.chainAccountId === chain.id && a.value === account.addresses.shielded
          )
        )
          throw new Error('External account metadata is incomplete')
        break
      }
      const timestamp = Math.max(Date.now(), pointer.committedAt, source.manifest.verifiedAt)
      const chainId = `frost-chain:${account.id}`
      const accounts = [
        ...source.accounts,
        {
          id: account.id,
          keyDomainId: owner.id,
          displayName: account.name,
          source: account.source,
          createdAt: op.createdAt
        }
      ]
      const chainAccounts = [
        ...source.chainAccounts,
        {
          id: chainId,
          scope: {
            keyDomainId: owner.id,
            accountId: account.id,
            chainId: getZcashChainId(account.source.network)
          },
          source: account.source,
          identity: { kind: 'account-identifier', value: account.addresses.shielded },
          createdAt: op.createdAt
        }
      ]
      const addresses = [
        ...source.addresses,
        {
          id: `frost-address:${account.id}`,
          chainAccountId: chainId,
          value: account.addresses.shielded,
          scheme: 'zcash-unified',
          purpose: 'receive',
          rotatable: true,
          preferredForReceive: true,
          privacy: 'shielded',
          walletCompatibility: 'limited'
        }
      ]
      const fingerprint = parseStorageV2SourceFingerprint(
        bytesToHex(
          new Uint8Array(
            await crypto.subtle.digest(
              'SHA-256',
              new TextEncoder().encode(
                JSON.stringify(['frost-account-v1', pointer.generationId, op.operationId, account])
              )
            )
          )
        )
      )
      const generationId = parseStorageV2GenerationId(`storage-v2:frost:${fingerprint}`)
      const target = parseStorageV2Snapshot({
        manifest: {
          ...source.manifest,
          generationId,
          sourceFingerprint: fingerprint,
          createdAt: timestamp,
          verifiedAt: timestamp,
          counts: {
            keyDomains: source.keyDomains.length,
            accounts: accounts.length,
            chainAccounts: chainAccounts.length,
            addresses: addresses.length
          }
        },
        keyDomains: source.keyDomains,
        accounts,
        chainAccounts,
        addresses
      })
      await this.storage.stage(target)
      await assertAuthorized()
      const status = await commitCredentialBoundStorageV2Pointer(
        this.storage,
        this.credentials,
        { schemaVersion: 2, generationId, sourceFingerprint: fingerprint, committedAt: timestamp },
        pointer.generationId
      )
      const active = await this.storage.getActivePointer()
      if (active?.generationId === generationId) {
        const readback = await this.storage.getSnapshot(generationId)
        if (!readback?.accounts.some(a => a.id === account.id && a.source?.groupId === op.groupId))
          throw new Error('Account metadata did not read back')
        break
      }
      await this.storage.discardUncommittedGeneration(generationId)
      if (status !== 'active-generation-changed' || attempt === 2)
        throw new Error('Account metadata could not be committed')
    }
    await assertAuthorized()
    // The caller holds the same metadata lock used by deletion and retained-state writers.
    const raw = (await chrome.storage.local.get(WALLET_STATE_KEY))[WALLET_STATE_KEY]
    const snapshot = typeof raw === 'string' ? JSON.parse(raw) : raw
    const wallet = snapshot?.state?.wallets?.find((w: { id: string }) => w.id === op.scope.walletId)
    if (!wallet || (wallet.keySource !== undefined && wallet.keySource !== 'software'))
      throw new Error('Retained wallet metadata is unavailable')
    const existing = wallet.accounts.find((a: AccountData) => a.id === account.id)
    if (
      existing &&
      (!existing.source ||
        existing.source.groupId !== op.groupId ||
        existing.source.network !== op.scope.network)
    )
      throw new Error('Retained account identity conflicts')
    const retained = {
      ...account,
      networkAddresses: { [op.scope.network]: account.addresses },
      networkBirthdayHeights: { [op.scope.network]: op.birthdayHeight },
      networkSelections: { [op.scope.network]: ['zcash'] }
    }
    wallet.accounts = existing
      ? wallet.accounts.map((a: AccountData) => (a.id === account.id ? retained : a))
      : [...wallet.accounts, retained]
    await chrome.storage.local.set({
      [WALLET_STATE_KEY]: typeof raw === 'string' ? JSON.stringify(snapshot) : snapshot
    })
    const stored = (await chrome.storage.local.get(WALLET_STATE_KEY))[WALLET_STATE_KEY]
    const readback = typeof stored === 'string' ? JSON.parse(stored) : stored
    if (
      !readback?.state?.wallets
        ?.find((w: { id: string }) => w.id === op.scope.walletId)
        ?.accounts?.some(
          (a: AccountData) =>
            a.id === account.id &&
            a.source?.groupId === op.groupId &&
            a.birthdayHeight === op.birthdayHeight
        )
    )
      throw new Error('Retained account metadata did not read back')
  }
}
