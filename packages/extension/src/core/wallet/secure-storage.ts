import { WALLET_CONFIG } from '@/config/wallet'
import type { HardwareWalletData } from '@/types'
import {
  createZcashHardwareCredential,
  legacyZcashHardwareWalletData,
  parseKeystoneHardwareCredential,
  parseLedgerHardwareCredential,
  parseStoredHardwareCredential,
  parseStoredKeystoneHardwareCredential,
  type KeystoneHardwareCredential,
  type LedgerHardwareCredential,
  type StoredHardwareCredential
} from './hardware-wallet-data'

interface StoredData {
  encryptedData: string
  salt: string
  iv: string
}

export type CredentialInspection =
  | { status: 'valid'; data: unknown }
  | { status: 'missing' | 'invalid' | 'wrong_password' }

export class SecureStorage {
  // ==================== Encryption ====================

  static async deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
    const encoder = new TextEncoder()
    const passwordKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      'PBKDF2',
      false,
      ['deriveBits', 'deriveKey']
    )

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt as BufferSource,
        iterations: 100000,
        hash: 'SHA-256'
      },
      passwordKey,
      { name: 'AES-GCM', length: 256 },
      false, // NOT extractable - key cannot be exported
      ['encrypt', 'decrypt']
    )
  }

  static async encrypt(data: string, password: string): Promise<StoredData> {
    const encoder = new TextEncoder()
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const key = await this.deriveKey(password, salt)

    const encryptedBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      encoder.encode(data)
    )

    return {
      encryptedData: this.bufferToBase64(encryptedBuffer),
      salt: this.bufferToBase64(salt.buffer),
      iv: this.bufferToBase64(iv.buffer)
    }
  }

  static async decrypt(storedData: StoredData, password: string): Promise<string> {
    const salt = this.base64ToBuffer(storedData.salt)
    const iv = this.base64ToBuffer(storedData.iv)
    const encryptedData = this.base64ToBuffer(storedData.encryptedData)
    const key = await this.deriveKey(password, salt)

    const decryptedBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      encryptedData as BufferSource
    )

    const decoder = new TextDecoder()
    return decoder.decode(decryptedBuffer)
  }

  // ==================== Storage Operations ====================

  static async saveEncrypted(key: string, data: any, password: string): Promise<void> {
    const jsonData = JSON.stringify(data)
    const encrypted = await this.encrypt(jsonData, password)
    await chrome.storage.local.set({ [key]: encrypted })
  }

  static async loadEncrypted(key: string, password: string): Promise<any> {
    const result = await chrome.storage.local.get(key)
    if (!result[key]) {
      return null
    }

    try {
      const decrypted = await this.decrypt(result[key], password)
      return JSON.parse(decrypted)
    } catch (error) {
      // Decryption failed (wrong password or corrupted data)
      // Return null to trigger failed attempt tracking in unlock flow
      console.warn('[SecureStorage] Decryption failed for key:', key)
      return null
    }
  }

  static async inspectEncryptedCredential(
    key: string,
    password: string
  ): Promise<CredentialInspection> {
    const saved = (await chrome.storage.local.get(key))[key]
    if (saved == null) return { status: 'missing' }
    if (
      !saved ||
      typeof saved !== 'object' ||
      typeof saved.salt !== 'string' ||
      typeof saved.iv !== 'string' ||
      typeof saved.encryptedData !== 'string'
    ) {
      return { status: 'invalid' }
    }
    let salt: Uint8Array
    let iv: Uint8Array
    let ciphertext: Uint8Array
    try {
      salt = new Uint8Array(this.base64ToBuffer(saved.salt))
      iv = new Uint8Array(this.base64ToBuffer(saved.iv))
      ciphertext = new Uint8Array(this.base64ToBuffer(saved.encryptedData))
    } catch {
      return { status: 'invalid' }
    }
    if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 16) {
      return { status: 'invalid' }
    }
    const cryptoKey = await this.deriveKey(password, salt)
    let plaintext: ArrayBuffer
    try {
      plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as BufferSource },
        cryptoKey,
        ciphertext as BufferSource
      )
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'OperationError') throw error
      return { status: 'wrong_password' }
    }
    try {
      return { status: 'valid', data: JSON.parse(new TextDecoder().decode(plaintext)) as unknown }
    } catch {
      return { status: 'invalid' }
    }
  }

  static async saveWalletSeedPhrase(
    walletId: string,
    seedPhrase: string,
    password: string
  ): Promise<void> {
    const key = `seed_${walletId}`
    await this.saveEncrypted(key, { seedPhrase }, password)
  }

  static async loadWalletSeedPhrase(walletId: string, password: string): Promise<string | null> {
    const key = `seed_${walletId}`
    const data = await this.loadEncrypted(key, password)
    return data?.seedPhrase || null
  }

  static async removeWalletSeedPhrase(walletId: string): Promise<void> {
    await chrome.storage.local.remove(`seed_${walletId}`)
  }

  // ==================== Hardware Wallet Credentials ====================
  // Encrypted with the same password-derived key as seed phrases, so a
  // successful decrypt doubles as password verification for hardware wallets.

  static async saveHardwareWalletData(
    walletId: string,
    data: HardwareWalletData,
    password: string
  ): Promise<void> {
    await this.saveKeystoneHardwareCredential(
      walletId,
      createZcashHardwareCredential(data),
      password
    )
  }

  static async saveKeystoneHardwareCredential(
    walletId: string,
    credential: KeystoneHardwareCredential,
    password: string
  ): Promise<void> {
    await this.saveEncrypted(
      `hw_${walletId}`,
      parseKeystoneHardwareCredential(credential),
      password
    )
  }

  static async loadKeystoneHardwareCredential(
    walletId: string,
    password: string
  ): Promise<KeystoneHardwareCredential | null> {
    const data = await this.loadEncrypted(`hw_${walletId}`, password)
    if (!data) return null
    try {
      return parseStoredKeystoneHardwareCredential(data)
    } catch {
      console.warn('[SecureStorage] Invalid hardware wallet data for key:', `hw_${walletId}`)
      return null
    }
  }

  static async saveLedgerHardwareCredential(
    walletId: string,
    credential: LedgerHardwareCredential,
    password: string
  ): Promise<void> {
    await this.saveEncrypted(`hw_${walletId}`, parseLedgerHardwareCredential(credential), password)
  }

  static async loadStoredHardwareCredential(
    walletId: string,
    password: string
  ): Promise<StoredHardwareCredential | null> {
    const data = await this.loadEncrypted(`hw_${walletId}`, password)
    if (!data) return null
    try {
      return parseStoredHardwareCredential(data)
    } catch {
      console.warn('[SecureStorage] Invalid hardware wallet data for key:', `hw_${walletId}`)
      return null
    }
  }

  static async loadHardwareWalletData(
    walletId: string,
    password: string
  ): Promise<HardwareWalletData | null> {
    const credential = await this.loadStoredHardwareCredential(walletId, password)
    return credential ? legacyZcashHardwareWalletData(credential) : null
  }

  static async removeHardwareWalletData(walletId: string): Promise<void> {
    await chrome.storage.local.remove(`hw_${walletId}`)
  }

  // ==================== Login Attempt Limiting ====================

  private static readonly LOGIN_ATTEMPTS_KEY = 'login_attempts'
  private static readonly MAX_ATTEMPTS = WALLET_CONFIG.SECURITY.LOGIN_ATTEMPTS.MAX_ATTEMPTS
  private static readonly LOCKOUT_DURATION_MS =
    WALLET_CONFIG.SECURITY.LOGIN_ATTEMPTS.LOCKOUT_DURATION_MS

  static async getLoginAttempts(): Promise<{
    failedCount: number
    remainingAttempts: number
    isLocked: boolean
    lockRemainingMs: number
  }> {
    const result = await chrome.storage.local.get(this.LOGIN_ATTEMPTS_KEY)
    const data = result[this.LOGIN_ATTEMPTS_KEY] as
      | { failedCount: number; lastFailedAt: number; lockedUntil: number }
      | undefined

    if (!data) {
      return {
        failedCount: 0,
        remainingAttempts: this.MAX_ATTEMPTS,
        isLocked: false,
        lockRemainingMs: 0
      }
    }

    const now = Date.now()
    const isLocked = data.lockedUntil > now
    const lockRemainingMs = isLocked ? data.lockedUntil - now : 0

    // Reset counter if lockout has expired
    if (!isLocked && data.lockedUntil > 0) {
      await this.resetLoginAttempts()
      return {
        failedCount: 0,
        remainingAttempts: this.MAX_ATTEMPTS,
        isLocked: false,
        lockRemainingMs: 0
      }
    }

    return {
      failedCount: data.failedCount,
      remainingAttempts: Math.max(0, this.MAX_ATTEMPTS - data.failedCount),
      isLocked,
      lockRemainingMs
    }
  }

  static async recordFailedAttempt(): Promise<{
    remainingAttempts: number
    isLocked: boolean
    lockRemainingMs: number
  }> {
    const result = await chrome.storage.local.get(this.LOGIN_ATTEMPTS_KEY)
    const data = (result[this.LOGIN_ATTEMPTS_KEY] as {
      failedCount: number
      lastFailedAt: number
      lockedUntil: number
    }) || { failedCount: 0, lastFailedAt: 0, lockedUntil: 0 }

    const now = Date.now()
    data.failedCount += 1
    data.lastFailedAt = now

    if (data.failedCount >= this.MAX_ATTEMPTS) {
      data.lockedUntil = now + this.LOCKOUT_DURATION_MS
    }

    await chrome.storage.local.set({ [this.LOGIN_ATTEMPTS_KEY]: data })

    const isLocked = data.lockedUntil > now
    return {
      remainingAttempts: Math.max(0, this.MAX_ATTEMPTS - data.failedCount),
      isLocked,
      lockRemainingMs: isLocked ? data.lockedUntil - now : 0
    }
  }

  static async resetLoginAttempts(): Promise<void> {
    await chrome.storage.local.remove(this.LOGIN_ATTEMPTS_KEY)
  }

  // ==================== Activity Time Tracking ====================

  static readonly LAST_ACTIVITY_KEY = 'last_activity_time'

  static async saveLastActivityTime(): Promise<void> {
    await chrome.storage.local.set({ [this.LAST_ACTIVITY_KEY]: Date.now() })
  }

  static async getLastActivityTime(): Promise<number | null> {
    const result = await chrome.storage.local.get(this.LAST_ACTIVITY_KEY)
    return result[this.LAST_ACTIVITY_KEY] || null
  }

  static async clearLastActivityTime(): Promise<void> {
    await chrome.storage.local.remove(this.LAST_ACTIVITY_KEY)
  }

  /** Remove credentials written by pre-V2 builds; current sessions never create these keys. */
  static async clearLegacySessionPasswordArtifacts(): Promise<void> {
    await chrome.storage.session.remove(['session_password', 'session_key_material'])
  }

  // ==================== Secure Memory ====================

  /** Zero out Uint8Array contents - most reliable way to clear sensitive data */
  static secureZeroArray(arr: Uint8Array): void {
    if (!arr || arr.length === 0) return
    arr.fill(0)
  }

  // ==================== Private Helpers ====================

  private static bufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    return btoa(binary)
  }

  private static base64ToBuffer(base64: string): Uint8Array {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  }
}
