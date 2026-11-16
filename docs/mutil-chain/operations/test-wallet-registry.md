# Test Wallet Registry

Reusable test wallets are registered here. Tests may create temporary, unfunded wallets, but any wallet reused across runs needs a named slot. Never place a funded wallet's mnemonic, password, or private key in Git-tracked files. Keep each secret in a separate absolute-path file outside Git tracking with mode `0600`; the local registry holds only paths and non-secret metadata.

## Public, Permanently Unfunded Vectors

These vectors are public and may be swept automatically. Never request or store Mainnet or Testnet assets in them.

| ID                          | Public vector                                                                                                                                               | Purpose                                                                                                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public-abandon-12`         | `abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about`                                                             | V1 compatibility, both WASM packages, session/resource checks, and primary UI regression. EVM Account 0: `0x9858EfFD232B4033E47d90003D41EC34EcaEda94`.                                                    |
| `public-abandon-24`         | `abandon` × 23 + `art`                                                                                                                                      | 24-word import, EVM/Bitcoin Testnet, Receive, and dApp regression. Sepolia Account 0: `0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb`; Bitcoin Testnet BIP-84: `tb1qtk89me2ae95dmlp3yfl4q9ynpux8mxjujuf2fr`. |
| `public-legal-winner-12`    | `legal winner thank year wave sausage worth useful legal winner thank yellow`                                                                               | Second 12-word wallet and multi-wallet/account-tree checks.                                                                                                                                               |
| `public-hardhat-12`         | `test test test test test test test test test test test junk`                                                                                               | Command and SDK logic tests only; do not use on a public network.                                                                                                                                         |
| `public-private-key-1`      | `0x0000000000000000000000000000000000000000000000000000000000000001`                                                                                        | Public EVM/Bitcoin private-key import, export, password change, and signing vector. EVM address: `0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf`. Never fund it.                                             |
| `v1.0.30-golden-profile`    | Encrypted envelope and IndexedDB snapshot in `packages/extension/tests/fixtures/v1.0.30-mainnet-software-golden.json`; no plaintext credential stored here. | V1-to-V2 upgrade and storage compatibility. The immutable fixture comes from released `v1.0.30@a623a1c39f89b44a139ebadfcd3e3441de0b7cf9`; do not regenerate or edit it from current V2 code.              |
| `generated-create-wallet-*` | Generated temporarily by the pinned WASM package in each test.                                                                                              | Creation and entropy checks. Never fund or reuse across tests; delete with the isolated browser profile.                                                                                                  |

`0x1111111111111111111111111111111111111111` is a deterministic EVM recipient, not a controlled test wallet.

`public-ledger-signing-vectors` uses public 32-byte secp256k1 scalars filled with `03`, BIP-32 master seeds of 64 bytes filled with `03` or 32 bytes filled with `05`, and 32-byte Ed25519 seeds filled with `07` or `08`. These permanently unfunded vectors exercise Ledger public-export validation, isolated MV3 provisioning, PSBT/BIP-322 verification, and Solana/NEAR signature verification. They never stand in for a physical device export or a funded integration wallet.

## Funded Testnet Slots

| Slot                 | Network                        | Local registry variable                       | Intended use                                                                                                         |
| -------------------- | ------------------------------ | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `sepolia-live-1`     | Ethereum Sepolia               | `NOIR_EVM_TESTNET_WALLET_FILE`                | Real EVM send, signing, broadcast, confirmation, and Activity checks.                                                |
| `zcash-testnet-1`    | Zcash Testnet                  | `TESTNET_1_MNEMONIC_FILE` + `TESTNET_1_BLOCK` | Funded source and transparent transfer checks.                                                                       |
| `zcash-testnet-2`    | Zcash Testnet                  | `TESTNET_2_MNEMONIC_FILE` + `TESTNET_2_BLOCK` | Provisioning destination and a second reusable wallet.                                                               |
| `evm-deployer-1`     | Built-in EVM test networks     | `NOIR_EVM_DEPLOYER_KEY_FILE`                  | SDK example test-contract deployment and verification only; never use as a general transaction wallet or on Mainnet. |
| `bitcoin-live-1`     | Bitcoin Testnet3               | `NOIR_BITCOIN_TESTNET_WALLET_FILE`            | Funded BIP-84 transfer and optional BIP-44/49/84 interoperability checks.                                            |
| `solana-near-live-1` | Solana Devnet and NEAR Testnet | `NOIR_SOLANA_NEAR_TESTNET_WALLET_FILE`        | Controlled Solana cross-account and NEAR self-transfer checks.                                                       |

The slot name records purpose, not availability. Revalidate the referenced file, network, derivation, and usable balance before a live run. Public transaction IDs, previous balances, and addresses cannot recover a missing credential and do not prove a local slot is configured.

## Local Configuration

1. Copy `packages/extension/.env.test-wallets.example` to `packages/extension/.env.test-wallets.local`.
2. Apply mode `0600` to the registry and each secret file. Secret file paths must be absolute and must not be symbolic links.
3. Put only file paths, birthday heights, account slots, and test amounts in the local registry. Never put mnemonics, passwords, private keys, `NOIR_TESTNET_BROADCAST=1`, `NOIR_TESTNET_PROVISION_TARGET`, or any other broadcast-enabling setting there.
4. Run `pnpm --filter @noir-wallet/extension wallets:check`. It reports `ready`, `not configured`, or a redacted error for each slot without printing paths, addresses, or secrets.

Playwright reads `.env.test-wallets.local` automatically; explicit command-line variables take precedence. Ordinary tests work when that file is absent. An existing file with invalid permissions, variables, or format fails validation.

The EVM fixture is a `0600` JSON file with `schemaVersion: 1`, `network: "sepolia"`, the derived `address`, a 24-word `mnemonic`, and an 8-64 character `password`. The Bitcoin fixture uses the same fields with `network: "bitcoin-testnet3"`; its address must be the mnemonic's Account 0 BIP-84 `tb1q` address, and its mnemonic may contain 12 or 24 words. The Solana/NEAR fixture uses `schemaVersion: 1`, `networks: ["solana-devnet", "near-testnet"]`, `solanaAddress`, `solanaRecipientAddress`, `nearAccountId`, `mnemonic`, and `password`; use the exact format shown in the example environment file. Each Zcash fixture is a `0600` text file containing exactly one 24-word mnemonic line, with its birthday height in the corresponding `_BLOCK` registry field.

`NOIR_TESTNET_MNEMONIC_FILE` and `NOIR_TESTNET_BIRTHDAY_HEIGHT` may override the selected Zcash source for one run. Keep the override file outside Git tracking and subject to the same permission checks.

## Live-Test Boundaries

- `pnpm test live evm-testnet-live` performs a real EVM broadcast when its fixture is configured. Inspect the test and authorize the transaction before running it.
- Bitcoin live tests require `NOIR_BITCOIN_TESTNET_BROADCAST=1` on that command line. The default funded flow sends Max back to the same controlled BIP-84 address and spends the Testnet fee. The BIP-44/49/84 sequence additionally requires `NOIR_BITCOIN_LEGACY_INTEROP=1` on the same command line; it broadcasts multiple transactions and waits for intermediate confirmations.
- Solana/NEAR live tests require `NOIR_SOLANA_NEAR_TESTNET_BROADCAST=1` on that command line. `NOIR_SOLANA_NEAR_LIVE_CHAIN=solana|near` limits a run to one chain. Solana sends a small amount from Account 0 to the fixture's controlled Account 1; NEAR sends to itself.
- Zcash funded flows require `NOIR_TESTNET_FUNDING_SOURCE=1` on the command line. Broadcasting additionally requires `NOIR_TESTNET_BROADCAST=1`.
- Broadcast switches must never be stored in `.env.test-wallets.local` or other persistent configuration. Public vectors are for deterministic, offline, or simulated-RPC tests only; use a private slot for faucet or real-balance checks.
- Screenshots, traces, console output, and failure messages must not contain local paths, mnemonics, passwords, private keys, raw vaults, or signing session data.
