import globals from 'globals'
import tseslint from 'typescript-eslint'

/**
 * Share basic checks across the extension; types and unused bindings are handled by tsc.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-dev/**',
      '**/e2e-dist/**',
      '**/node_modules/**',
      'packages/extension/src/lib/wasm-pkg/**',
      '**/*.d.ts',
      'eslint.config.mjs'
    ]
  },
  {
    files: ['packages/extension/src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true }
      }
    },
    rules: {
      'no-debugger': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }]
    }
  },
  {
    files: [
      'packages/extension/src/lib/ledger/**/*.ts',
      'packages/extension/src/core/wallet/ledger-hardware-credential.ts',
      'packages/extension/src/core/keyring/protocol/ledger-signing.ts',
      'packages/extension/src/background/ledger-*.ts',
      'packages/extension/src/infrastructure/keyring/ledger-*.ts',
      'packages/extension/src/infrastructure/keyring/multichain/ledger-*.ts',
      'packages/extension/src/popup/services/ledger-*.ts',
      'packages/extension/src/popup/pages/hardware/Ledger*.tsx',
      'packages/extension/src/popup/pages/hardware/ledger-*.ts'
    ],
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'prefer-const': 'error'
    }
  },
  {
    files: ['packages/extension/src/popup/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true }
      },
      globals: {
        ...globals.browser,
        chrome: 'readonly'
      }
    },
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-undef': 'off'
    }
  }
)
