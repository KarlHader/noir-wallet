import { create } from 'zustand'
import { WALLET_CONFIG, type MnemonicWordCount } from '@/config/wallet'
import { getNewPasswordValidationError } from '@/core/wallet/password-policy'
import { ANALYTICS_EVENTS, sendAnalyticsEvent } from '@/lib/analytics'
import { LatestAttempt } from '@/lib/async-utils'
import { classifyError } from '@/lib/errors'
import {
  generateAddWalletMnemonic,
  provisionAdditionalSoftwareWallet
} from '@/core/wallet/software-wallet-provisioning-client'
import { zcashWalletRuntimeClient } from '@/popup/services/zcash-wallet-runtime-client'
import { rehydrateWalletStore } from '@/store/wallet-store'
import {
  selectDifferentVerificationIndices,
  type VerificationWordOption
} from '@/popup/utils/recovery-phrase-confirmation'
import { DEFAULT_ACCOUNT_NAME, normalizeAccountName } from '@/core/wallet/account-name'
import type { ImportZcashHistorySelection } from '@/popup/services/import-zcash-history-selection'

export type FlowMode = 'onboarding' | 'addWallet'

export interface OnboardingState {
  flowMode: FlowMode
  mode: 'create' | 'import'
  mnemonicWordCount: MnemonicWordCount
  accountName: string
  password: string
  confirmPassword: string
  seedPhrase: string[]
  importedSeedPhrase: string
  birthdayHeight?: number
  importZcashHistorySelection: ImportZcashHistorySelection | null
  agreedToTerms: boolean
  acknowledgedWarning: boolean
  selectedVerificationWords: VerificationWordOption[]
  verificationIndices: number[]
  verificationPassed: boolean
  isLoading: boolean
  error: string | null
  dappRequestId: string | null // Store dApp request ID if onboarding triggered by dApp

  // Actions
  setFlowMode: (mode: FlowMode) => void
  setMode: (mode: 'create' | 'import') => void
  setMnemonicWordCount: (wordCount: MnemonicWordCount) => void
  setAccountName: (accountName: string) => void
  setPassword: (password: string) => void
  setConfirmPassword: (password: string) => void
  setSeedPhrase: (phrase: string[]) => void
  setImportedSeedPhrase: (phrase: string) => void
  setBirthdayHeight: (height?: number) => void
  setImportZcashHistorySelection: (selection: ImportZcashHistorySelection | null) => void
  setAgreedToTerms: (agreed: boolean) => void
  setAcknowledgedWarning: (acknowledged: boolean) => void
  setDappRequestId: (requestId: string | null) => void
  selectVerificationWord: (option: VerificationWordOption) => void
  refreshVerificationChallenge: () => void
  generateSeedPhrase: () => Promise<void>
  verifySeedPhrase: () => boolean
  createWallet: () => Promise<boolean>
  importWallet: () => Promise<boolean>
  reset: () => void
  validatePassword: () => boolean
  addWallet: () => Promise<boolean>
  addImportedWallet: () => Promise<boolean>
}

const importAttempts = new LatestAttempt()
const generationAttempts = new LatestAttempt()

function clearedSensitiveOnboardingState(): Pick<
  OnboardingState,
  | 'password'
  | 'confirmPassword'
  | 'seedPhrase'
  | 'importedSeedPhrase'
  | 'birthdayHeight'
  | 'importZcashHistorySelection'
  | 'acknowledgedWarning'
  | 'selectedVerificationWords'
  | 'verificationIndices'
  | 'verificationPassed'
  | 'isLoading'
  | 'error'
> {
  return {
    password: '',
    confirmPassword: '',
    seedPhrase: [],
    importedSeedPhrase: '',
    birthdayHeight: undefined,
    importZcashHistorySelection: null,
    acknowledgedWarning: false,
    selectedVerificationWords: [],
    verificationIndices: [],
    verificationPassed: false,
    isLoading: false,
    error: null
  }
}

export const useOnboardingStore = create<OnboardingState>((set, get) => ({
  flowMode: 'onboarding',
  mode: 'create',
  mnemonicWordCount: WALLET_CONFIG.MNEMONIC_LENGTH,
  accountName: DEFAULT_ACCOUNT_NAME,
  password: '',
  confirmPassword: '',
  seedPhrase: [],
  importedSeedPhrase: '',
  birthdayHeight: undefined,
  importZcashHistorySelection: null,
  agreedToTerms: false,
  acknowledgedWarning: false,
  selectedVerificationWords: [],
  verificationIndices: [],
  verificationPassed: false,
  isLoading: false,
  error: null,
  dappRequestId: null,

  setFlowMode: flowMode => {
    generationAttempts.invalidate()
    set({ flowMode, seedPhrase: [], verificationPassed: false, importZcashHistorySelection: null })
  },
  setMode: mode => {
    generationAttempts.invalidate()
    set({ mode, seedPhrase: [], verificationPassed: false })
  },
  setMnemonicWordCount: mnemonicWordCount => {
    importAttempts.invalidate()
    generationAttempts.invalidate()
    set({
      mnemonicWordCount,
      seedPhrase: [],
      importedSeedPhrase: '',
      selectedVerificationWords: [],
      verificationIndices: [],
      verificationPassed: false,
      birthdayHeight: undefined,
      importZcashHistorySelection: null,
      isLoading: false,
      error: null
    })
  },
  setAccountName: accountName => set({ accountName, error: null }),
  setPassword: password => set({ password, error: null }),
  setConfirmPassword: confirmPassword => set({ confirmPassword, error: null }),
  setSeedPhrase: seedPhrase => set({ seedPhrase, verificationPassed: false }),
  setImportedSeedPhrase: importedSeedPhrase => {
    importAttempts.invalidate()
    set({
      importedSeedPhrase,
      error: null,
      isLoading: false
    })
  },
  setBirthdayHeight: birthdayHeight => set({ birthdayHeight }),
  setImportZcashHistorySelection: importZcashHistorySelection =>
    set({ importZcashHistorySelection }),
  setAgreedToTerms: agreedToTerms => set({ agreedToTerms, error: null }),
  setAcknowledgedWarning: acknowledgedWarning => set({ acknowledgedWarning }),
  setDappRequestId: dappRequestId => set({ dappRequestId }),

  selectVerificationWord: option =>
    set(state => {
      if (
        !Number.isSafeInteger(option.optionId) ||
        option.optionId < 0 ||
        state.seedPhrase[option.optionId] !== option.word
      ) {
        return state
      }

      const isSelected = state.selectedVerificationWords.some(
        selected => selected.optionId === option.optionId
      )
      const selectedVerificationWords = isSelected
        ? state.selectedVerificationWords.filter(selected => selected.optionId !== option.optionId)
        : [...state.selectedVerificationWords, option].slice(0, 2)
      return { selectedVerificationWords, verificationPassed: false, error: null }
    }),

  refreshVerificationChallenge: () =>
    set(state => ({
      verificationIndices: selectDifferentVerificationIndices(
        state.seedPhrase.length,
        state.verificationIndices
      ),
      selectedVerificationWords: [],
      verificationPassed: false,
      error: null
    })),

  generateSeedPhrase: async () => {
    if (get().isLoading) return
    const attempt = generationAttempts.begin()
    set({ isLoading: true, error: null })
    try {
      const { flowMode, mnemonicWordCount, password } = get()
      const words =
        flowMode === 'addWallet'
          ? await generateAddWalletMnemonic(mnemonicWordCount)
          : await zcashWalletRuntimeClient.generatePrimaryMnemonic(mnemonicWordCount, password)
      if (words.length !== mnemonicWordCount) {
        throw new Error('Secure module returned an unexpected recovery phrase length')
      }
      if (!generationAttempts.isCurrent(attempt)) return
      set({
        seedPhrase: words,
        verificationIndices: [],
        selectedVerificationWords: [],
        verificationPassed: false,
        isLoading: false
      })
    } catch (err) {
      if (!generationAttempts.isCurrent(attempt)) return
      set({ isLoading: false, error: (err as Error).message || 'Failed to generate seed phrase' })
    }
  },

  verifySeedPhrase: () => {
    const { verificationIndices, seedPhrase, selectedVerificationWords } = get()
    const isCorrect =
      verificationIndices.length === 2 &&
      verificationIndices[0] !== verificationIndices[1] &&
      selectedVerificationWords.length === 2 &&
      selectedVerificationWords.every(
        (option, index) =>
          option.optionId === verificationIndices[index] &&
          option.word === seedPhrase[verificationIndices[index]]
      )
    if (!isCorrect) {
      set({
        selectedVerificationWords: [],
        verificationPassed: false,
        error: 'Selected words do not match. Please try again.'
      })
      return false
    }
    set({ verificationPassed: true, error: null })
    return true
  },

  createWallet: async () => {
    set({ isLoading: true, error: null })
    try {
      const { seedPhrase, password, accountName, verificationPassed, mnemonicWordCount } = get()
      if (!verificationPassed || seedPhrase.length !== mnemonicWordCount) {
        throw new Error('Confirm your recovery phrase before creating the wallet')
      }
      await zcashWalletRuntimeClient.provisionPrimarySoftwareWallet({
        mnemonic: seedPhrase.join(' '),
        password,
        accountName: normalizeAccountName(accountName)
      })
      await rehydrateWalletStore()
      sendAnalyticsEvent(ANALYTICS_EVENTS.WALLET_CREATED, { params: { method: 'create' } })

      set(clearedSensitiveOnboardingState())
      return true
    } catch (err) {
      const { userMessage } = classifyError(err)
      set({ isLoading: false, error: userMessage })
      return false
    }
  },

  importWallet: async () => {
    const importAttemptId = importAttempts.begin()
    set({ isLoading: true, error: null })
    try {
      const { importedSeedPhrase, password, birthdayHeight, accountName } = get()
      await zcashWalletRuntimeClient.provisionPrimarySoftwareWallet({
        mnemonic: importedSeedPhrase,
        password,
        accountName: normalizeAccountName(accountName),
        ...(birthdayHeight === undefined ? {} : { birthdayHeight })
      })
      await rehydrateWalletStore()

      if (!importAttempts.isCurrent(importAttemptId)) {
        return false
      }
      sendAnalyticsEvent(ANALYTICS_EVENTS.WALLET_CREATED, {
        params: { method: 'import' },
        extra: { has_birthday_height: get().birthdayHeight !== undefined }
      })

      set(clearedSensitiveOnboardingState())
      return true
    } catch (err) {
      if (!importAttempts.isCurrent(importAttemptId)) {
        return false
      }
      const { userMessage } = classifyError(err)
      set({ isLoading: false, error: userMessage })
      return false
    }
  },

  validatePassword: () => {
    const { password, confirmPassword, agreedToTerms } = get()
    const passwordError = getNewPasswordValidationError(password)
    if (passwordError) {
      set({ error: passwordError })
      return false
    }
    if (password !== confirmPassword) {
      set({ error: 'Passwords do not match' })
      return false
    }
    if (!agreedToTerms) {
      set({ error: 'Please agree to the Terms of Use' })
      return false
    }
    return true
  },

  reset: () => {
    // Preserve dappRequestId when resetting - it's set before onboarding and needed after
    const currentDappRequestId = get().dappRequestId
    importAttempts.invalidate()
    generationAttempts.invalidate()
    set({
      flowMode: 'onboarding',
      mode: 'create',
      mnemonicWordCount: WALLET_CONFIG.MNEMONIC_LENGTH,
      accountName: DEFAULT_ACCOUNT_NAME,
      password: '',
      confirmPassword: '',
      seedPhrase: [],
      importedSeedPhrase: '',
      birthdayHeight: undefined,
      importZcashHistorySelection: null,
      agreedToTerms: false,
      acknowledgedWarning: false,
      selectedVerificationWords: [],
      verificationIndices: [],
      verificationPassed: false,
      isLoading: false,
      error: null,
      dappRequestId: currentDappRequestId // Keep dappRequestId
    })
  },

  addWallet: async () => {
    set({ isLoading: true, error: null })
    try {
      const { seedPhrase, accountName, verificationPassed, mnemonicWordCount } = get()
      if (!verificationPassed || seedPhrase.length !== mnemonicWordCount) {
        throw new Error('Confirm your recovery phrase before creating the wallet')
      }
      await provisionAdditionalSoftwareWallet({
        mode: 'create',
        mnemonic: seedPhrase.join(' '),
        accountName: normalizeAccountName(accountName)
      })
      await rehydrateWalletStore()
      sendAnalyticsEvent(ANALYTICS_EVENTS.WALLET_CREATED, { params: { method: 'create' } })

      set(clearedSensitiveOnboardingState())
      return true
    } catch (err) {
      const { userMessage } = classifyError(err)
      set({ isLoading: false, error: userMessage })
      return false
    }
  },

  addImportedWallet: async () => {
    const importAttemptId = importAttempts.begin()
    set({ isLoading: true, error: null })
    try {
      const { importedSeedPhrase, birthdayHeight, accountName } = get()
      await provisionAdditionalSoftwareWallet({
        mode: 'import',
        mnemonic: importedSeedPhrase,
        accountName: normalizeAccountName(accountName),
        ...(birthdayHeight === undefined ? {} : { birthdayHeight })
      })
      await rehydrateWalletStore()

      if (!importAttempts.isCurrent(importAttemptId)) {
        return false
      }
      sendAnalyticsEvent(ANALYTICS_EVENTS.WALLET_CREATED, {
        params: { method: 'import' },
        extra: { has_birthday_height: birthdayHeight !== undefined }
      })

      set(clearedSensitiveOnboardingState())
      return true
    } catch (err) {
      if (!importAttempts.isCurrent(importAttemptId)) {
        return false
      }
      const { userMessage } = classifyError(err)
      set({ isLoading: false, error: userMessage })
      return false
    }
  }
}))
