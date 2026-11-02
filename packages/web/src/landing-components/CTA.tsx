import { MobileWarning, useMobileWarning } from './MobileWarning'

export function CTA() {
  const mobileWarning = useMobileWarning()

  return (
    <section
      id="cta"
      className="relative mx-auto max-w-[1440px] px-5 pt-[140px] text-center md:px-[120px] md:pt-[280px]"
    >
      <h2 className="cta-flow-text font-serif text-[28px] font-medium leading-[1.2] tracking-[0.04em] md:text-[50px] md:tracking-[0.06em]">
        Start your
        <br />
        private cross-chain journey.
      </h2>

      <div className="mt-12 flex flex-col items-center justify-center gap-3 md:mt-[108px] md:flex-row md:gap-3.5">
        <a
          href="https://chromewebstore.google.com/detail/noir-wallet/mfoghjbpfanobmnoemoepenjjcmfpmdn"
          target="_blank"
          rel="noopener noreferrer"
          onClick={e => mobileWarning.handleClick(e)}
          className="glow-btn relative flex h-[48px] w-full items-center justify-center rounded-lg bg-primary px-6 text-base font-medium text-black md:h-[52px] md:w-auto"
        >
          Install Wallet
        </a>
        <a
          href="/v2/beta"
          className="group flex h-[48px] w-full items-center justify-center gap-2 rounded-lg border border-white bg-bg px-6 text-base font-medium text-white transition-opacity hover:opacity-80 md:h-[52px] md:w-auto"
        >
          <span className="underline">Try V2 Beta</span>
          <svg
            width="22"
            height="22"
            viewBox="0 0 22 22"
            fill="none"
            className="transition-transform group-hover:translate-x-0.5"
          >
            <path
              d="M5 11H17M17 11L12 6M17 11L12 16"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </a>
      </div>

      {mobileWarning.show && <MobileWarning onClose={() => mobileWarning.setShow(false)} />}
    </section>
  )
}
