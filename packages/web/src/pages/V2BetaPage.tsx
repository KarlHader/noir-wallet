import { useEffect, useState } from 'react'
import { Footer } from '../landing-components/Footer'
import { MobileWarning, useMobileWarning } from '../landing-components/MobileWarning'
import { getV2BetaRelease } from '../lib/v2-beta-release'

const EXTENSIONS_URL = 'chrome://extensions'

export default function V2BetaPage() {
  const release = getV2BetaRelease()
  const mobileWarning = useMobileWarning()
  const [copyStatus, setCopyStatus] = useState('')

  useEffect(() => {
    document.title = 'V2 Beta - Noir Wallet'
  }, [])

  const copyExtensionsUrl = async () => {
    try {
      await navigator.clipboard.writeText(EXTENSIONS_URL)
      setCopyStatus('Copied')
    } catch {
      setCopyStatus('Copy failed. Enter the address manually.')
    }
  }

  return (
    <div className="min-h-screen bg-bg">
      <header className="mx-auto flex max-w-[1120px] items-center justify-between px-5 py-6 md:px-8 md:py-8">
        <a href="/" aria-label="Noir Wallet home" className="flex items-center gap-2.5">
          <img src="/images/logo.png" alt="" className="h-8 w-8 object-contain" />
          <span className="font-serif text-[22px] text-white">
            Noir <span className="text-primary">Wallet</span>
          </span>
        </a>
        <a href="/" className="text-sm text-white/60 transition-colors hover:text-white">
          Back to home <span aria-hidden="true">↗</span>
        </a>
      </header>
      <main className="mx-auto max-w-[1120px] px-5 pb-8 pt-12 md:px-8 md:pt-20">
        <header className="max-w-[780px]">
          <p className="text-sm font-medium uppercase text-primary">Noir Wallet</p>
          <h1 className="mt-4 font-serif text-[38px] leading-[1.15] text-white md:text-[60px]">
            Try V2 Beta
          </h1>
          <p className="mt-5 max-w-[670px] text-base leading-relaxed text-text-70 md:text-lg">
            Install V2 Beta in a separate Chrome profile, then set up your wallet with your invite
            code.
          </p>
        </header>

        <section
          aria-label="Beta download"
          className="mt-10 border-y border-border py-7 md:mt-14 md:py-9"
        >
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-serif text-2xl text-white">V2 Beta for Chrome</h2>
              {release ? (
                <p className="mt-2 text-sm text-text-60">
                  Version {release.version}
                  {release.releaseDate && <> · Released {release.releaseDate}</>}
                </p>
              ) : null}
              {release && (
                <a
                  href={release.releaseNotesUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-block text-sm text-primary underline underline-offset-4 hover:text-primary-light"
                >
                  Release notes
                </a>
              )}
            </div>
            {release ? (
              <a
                href={release.downloadUrl}
                onClick={event => mobileWarning.handleClick(event)}
                className="flex h-12 shrink-0 items-center justify-center rounded-lg bg-primary px-7 text-sm font-medium text-black transition-opacity hover:opacity-80"
              >
                Download ZIP
              </a>
            ) : (
              <button
                type="button"
                disabled
                className="flex h-12 shrink-0 items-center justify-center rounded-lg bg-white/10 px-7 text-sm font-medium text-text-60"
              >
                Download coming soon
              </button>
            )}
          </div>
        </section>

        <section aria-labelledby="install-heading" className="pt-10 md:pt-14">
          <h2 id="install-heading" className="font-serif text-[30px] text-white md:text-[36px]">
            Install in Chrome
          </h2>
          <ol className="mt-5 divide-y divide-border">
            <li className="grid gap-2 py-5 sm:grid-cols-[40px_1fr] sm:gap-5">
              <span className="text-sm font-medium text-primary" aria-hidden="true">
                01
              </span>
              <p className="text-base leading-relaxed text-white">
                Create a separate Chrome profile for V2 Beta.
              </p>
            </li>
            <li className="grid gap-2 py-5 sm:grid-cols-[40px_1fr] sm:gap-5">
              <span className="text-sm font-medium text-primary" aria-hidden="true">
                02
              </span>
              <p className="text-base leading-relaxed text-white">
                Unzip the download into a fixed folder.
              </p>
            </li>
            <li className="grid gap-2 py-5 sm:grid-cols-[40px_1fr] sm:gap-5">
              <span className="text-sm font-medium text-primary" aria-hidden="true">
                03
              </span>
              <div>
                <p className="text-base leading-relaxed text-white">Open Chrome extensions.</p>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <code className="rounded border border-border px-3 py-2 text-sm text-primary">
                    {EXTENSIONS_URL}
                  </code>
                  <button
                    type="button"
                    onClick={copyExtensionsUrl}
                    className="rounded border border-border px-3 py-2 text-sm text-white transition-colors hover:bg-white/10"
                    aria-label="Copy Chrome extensions address"
                  >
                    Copy
                  </button>
                  <span role="status" aria-live="polite" className="text-sm text-text-60">
                    {copyStatus}
                  </span>
                </div>
              </div>
            </li>
            <li className="grid gap-2 py-5 sm:grid-cols-[40px_1fr] sm:gap-5">
              <span className="text-sm font-medium text-primary" aria-hidden="true">
                04
              </span>
              <p className="text-base leading-relaxed text-white">
                Enable <strong>Developer mode</strong>, choose <strong>Load unpacked</strong>, and
                select the folder containing <code className="text-primary">manifest.json</code>.
              </p>
            </li>
            <li className="grid gap-2 py-5 sm:grid-cols-[40px_1fr] sm:gap-5">
              <span className="text-sm font-medium text-primary" aria-hidden="true">
                05
              </span>
              <p className="text-base leading-relaxed text-white">
                Pin and open Noir Wallet. Enter your invite code, then create or import a wallet.
              </p>
            </li>
          </ol>
        </section>

        <section
          aria-labelledby="update-heading"
          className="mt-10 border-t border-border pt-8 md:mt-14"
        >
          <h2 id="update-heading" className="font-serif text-[30px] text-white md:text-[36px]">
            Update V2 Beta
          </h2>
          <p className="mt-4 max-w-[740px] text-base leading-relaxed text-text-70">
            Replace the files in the same folder with the new ZIP contents, then select{' '}
            <strong className="text-white">Reload</strong> on the extension in Chrome. Keep the
            extension installed to retain your wallet data.
          </p>
        </section>
      </main>
      <Footer />
      {mobileWarning.show && <MobileWarning onClose={() => mobileWarning.setShow(false)} />}
    </div>
  )
}
