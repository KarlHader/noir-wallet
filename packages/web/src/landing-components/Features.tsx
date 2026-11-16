import { useEffect, useRef, useState } from 'react'

const SCROLL_HEIGHT_DESKTOP = 3000
const SCROLL_HEIGHT_MOBILE = 1800
const WALLET_HOME_IMAGE = 'https://assets.zknoir.com/images/home-banner.png'
const LOCAL_WALLET_HOME_IMAGE = '/images/home-banner-v2.png'

export function Features() {
  const sectionRef = useRef<HTMLElement>(null)
  const [progress, setProgress] = useState(0)
  const [isMobile, setIsMobile] = useState(false)
  const [walletHomeImage, setWalletHomeImage] = useState(WALLET_HOME_IMAGE)

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768)
    checkMobile()
    window.addEventListener('resize', checkMobile)
    return () => window.removeEventListener('resize', checkMobile)
  }, [])

  const scrollHeight = isMobile ? SCROLL_HEIGHT_MOBILE : SCROLL_HEIGHT_DESKTOP

  useEffect(() => {
    const onScroll = () => {
      const el = sectionRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const scrolled = -rect.top
      setProgress(Math.max(0, Math.min(1, scrolled / (scrollHeight - window.innerHeight))))
    }

    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener('scroll', onScroll)
  }, [scrollHeight])

  const phase = (start: number, end: number) =>
    Math.max(0, Math.min(1, (progress - start) / (end - start)))

  const titleReveal = phase(0.15, 0.4)
  const demoBlur = phase(0.2, 0.55)
  const titleShrink = phase(0.55, 0.75)
  const cardsReveal = phase(0.7, 0.85)

  const titleMaxSize = isMobile ? 60 : 120
  const titleMinSize = isMobile ? 28 : 40
  const titleSize = titleMaxSize - (titleMaxSize - titleMinSize) * titleShrink

  const line1Opacity = Math.min(1, titleReveal * 3)
  const line2Opacity = Math.max(0, Math.min(1, (titleReveal - 0.25) * 3))
  const line3Opacity = Math.max(0, Math.min(1, (titleReveal - 0.5) * 3))

  const demoOpacity = 1 - demoBlur * 0.7
  const demoBlurPx = demoBlur * 5

  const cardOffset = (1 - cardsReveal) * 60
  const cardOpacity = cardsReveal

  return (
    <section id="features" ref={sectionRef} className="relative" style={{ height: scrollHeight }}>
      <div className="sticky top-0 flex md:h-screen items-center justify-center overflow-hidden">
        <div className="relative mx-auto w-full max-w-[1440px] px-5 md:px-8 lg:px-[60px] xl:px-[120px]">
          {/* Desktop: 3-column grid */}
          <div className="hidden md:grid md:grid-cols-3 md:gap-4">
            <div
              className="flex flex-col gap-4"
              style={{
                opacity: cardOpacity,
                transform: `translateX(-${cardOffset}px)`,
                transition: 'none'
              }}
            >
              <FeatureCard
                title="Native Zcash Wallet"
                description="Manage ZEC with zero exposure."
                align="left"
                bgColor="#272727"
                textColor="white"
              />
              <FeatureCard
                title="Cross-Chain Borrowing"
                description="Borrow against your ZEC lending positions and deploy assets to other chains."
                align="left"
                bgColor="#dfdfdf"
                textColor="black"
              />
            </div>

            <div className="relative flex h-[596px] items-center justify-center">
              <div
                className="absolute inset-0 overflow-hidden rounded-xl"
                style={{
                  opacity: demoOpacity,
                  filter: `blur(${demoBlurPx}px)`,
                  willChange: 'filter, opacity'
                }}
              >
                <img
                  src={walletHomeImage}
                  onError={() => setWalletHomeImage(LOCAL_WALLET_HOME_IMAGE)}
                  alt="Noir Wallet V2 home"
                  width={375}
                  height={750}
                  className="h-full w-[322px] max-w-full object-contain mx-auto"
                />
              </div>

              <div
                className="absolute inset-0 rounded-xl"
                style={{ backgroundColor: `rgba(18, 18, 28, ${demoBlur * 0.5})` }}
              />

              <div
                className="relative z-10 text-center font-serif font-medium leading-[1.1] tracking-[0.06em] text-white"
                style={{ fontSize: `${titleSize}px`, willChange: 'font-size' }}
              >
                {titleReveal > 0 && (
                  <>
                    <div style={{ opacity: line1Opacity }}>THE</div>
                    <div style={{ opacity: line2Opacity }}>PRIVACY</div>
                    <div style={{ opacity: line3Opacity }}>TERMINAL</div>
                  </>
                )}
              </div>

              {cardsReveal > 0 && (
                <div
                  className="absolute top-[calc(50%-140px)] z-20 rounded-xl bg-badge-bg px-4 py-2.5"
                  style={{
                    opacity: cardOpacity,
                    transform: `translateY(-${(1 - cardsReveal) * 20}px)`
                  }}
                >
                  <span className="text-base font-normal tracking-[0.04em] text-white">
                    Core Features
                  </span>
                </div>
              )}

              {cardsReveal > 0.5 && (
                <div
                  className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl"
                  style={{ opacity: Math.min(1, (cardsReveal - 0.5) * 2) }}
                >
                  <div
                    className="absolute left-0 h-px w-full bg-gradient-to-r from-transparent via-primary-light/50 to-transparent"
                    style={{ animation: 'scan-line 4s ease-in-out infinite' }}
                  />
                </div>
              )}

              {cardsReveal > 0.5 && (
                <div
                  className="absolute inset-0 rounded-xl border border-white/20"
                  style={{ opacity: Math.min(1, (cardsReveal - 0.5) * 2) }}
                />
              )}
            </div>

            <div
              className="flex flex-col gap-4"
              style={{
                opacity: cardOpacity,
                transform: `translateX(${cardOffset}px)`,
                transition: 'none'
              }}
            >
              <FeatureCard
                title="ZEC Lending"
                description="Deposit your ZEC directly into Lending to unlock effortless passive income."
                align="right"
                bgColor="#a9c0b8"
                textColor="black"
              />
              <FeatureCard
                title="Privacy Swaps"
                description="Seamlessly exchange ZEC with EVM-based ETH and stablecoins."
                align="right"
                bgColor="#6a6a6a"
                textColor="white"
              />
            </div>
          </div>

          {/* Mobile: single column */}
          <div className="flex flex-col gap-4 pt-6 md:hidden">
            {/* Center image + title */}
            <div className="relative flex aspect-[1/2] w-full items-center justify-center">
              <div
                className="absolute inset-0 overflow-hidden rounded-xl"
                style={{
                  opacity: demoOpacity,
                  filter: `blur(${demoBlurPx}px)`,
                  willChange: 'filter, opacity'
                }}
              >
                <img
                  src={walletHomeImage}
                  onError={() => setWalletHomeImage(LOCAL_WALLET_HOME_IMAGE)}
                  alt="Noir Wallet V2 home"
                  width={375}
                  height={750}
                  className="h-full w-full object-contain mx-auto"
                />
              </div>

              <div
                className="absolute inset-0 rounded-xl"
                style={{ backgroundColor: `rgba(18, 18, 28, ${demoBlur * 0.5})` }}
              />

              <div
                className="relative z-10 text-center font-serif font-medium leading-[1.1] tracking-[0.06em] text-white"
                style={{ fontSize: `${titleSize}px`, willChange: 'font-size' }}
              >
                {titleReveal > 0 && (
                  <>
                    <div style={{ opacity: line1Opacity }}>THE</div>
                    <div style={{ opacity: line2Opacity }}>PRIVACY</div>
                    <div style={{ opacity: line3Opacity }}>TERMINAL</div>
                  </>
                )}
              </div>

              {cardsReveal > 0 && (
                <div
                  className="absolute top-4 z-20 rounded-xl bg-badge-bg px-3 py-2"
                  style={{ opacity: cardOpacity }}
                >
                  <span className="text-sm font-normal tracking-[0.04em] text-white">
                    Core Features
                  </span>
                </div>
              )}

              {cardsReveal > 0.5 && (
                <div
                  className="absolute inset-0 rounded-xl border border-white/20"
                  style={{ opacity: Math.min(1, (cardsReveal - 0.5) * 2) }}
                />
              )}
            </div>

            {/* Cards — 2x2 grid */}
            <div
              className="grid grid-cols-2 gap-3"
              style={{
                opacity: cardOpacity,
                transform: `translateY(${cardOffset}px)`,
                transition: 'none'
              }}
            >
              <FeatureCardMobile
                title="Native Zcash Wallet"
                description="Manage ZEC with zero exposure."
                bgColor="#272727"
                textColor="white"
              />
              <FeatureCardMobile
                title="ZEC Lending"
                description="Effortless passive income."
                bgColor="#a9c0b8"
                textColor="black"
              />
              <FeatureCardMobile
                title="Cross-Chain Borrowing"
                description="Borrow against your ZEC."
                bgColor="#dfdfdf"
                textColor="black"
              />
              <FeatureCardMobile
                title="Privacy Swaps"
                description="Exchange ZEC with EVM assets."
                bgColor="#6a6a6a"
                textColor="white"
              />
            </div>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes scan-line {
          0%, 100% { top: 5%; }
          50% { top: 95%; }
        }
      `}</style>
    </section>
  )
}

function FeatureCard({
  title,
  description,
  align,
  bgColor,
  textColor = 'white'
}: {
  title: string
  description: string
  align: 'left' | 'right'
  bgColor: string
  textColor?: 'white' | 'black'
}) {
  const isLight = textColor === 'black'
  return (
    <div
      className="feature-card relative flex h-[290px] cursor-default flex-col justify-between rounded-xl p-6"
      style={{ backgroundColor: bgColor }}
    >
      <div>
        <h4
          className={`text-[22px] font-medium leading-[1.2] tracking-[0.08em] xl:text-[26px] ${
            align === 'right' ? 'text-right' : 'text-left'
          }`}
          style={{ color: isLight ? '#000000' : '#FFFFFF' }}
        >
          {title}
        </h4>
      </div>
      <p
        className={`text-[14px] font-normal leading-[1.4] tracking-[0.07em] xl:text-base ${
          align === 'right' ? 'text-right' : 'text-left'
        }`}
        style={{ color: isLight ? 'rgba(0,0,0,0.65)' : 'rgba(255,255,255,0.65)' }}
      >
        {description}
      </p>
    </div>
  )
}

function FeatureCardMobile({
  title,
  description,
  bgColor,
  textColor = 'white'
}: {
  title: string
  description: string
  bgColor: string
  textColor?: 'white' | 'black'
}) {
  const isLight = textColor === 'black'
  return (
    <div
      className="flex flex-col justify-between rounded-xl p-4"
      style={{ minHeight: 140, backgroundColor: bgColor }}
    >
      <div>
        <h4
          className="mt-2 text-[15px] font-medium leading-[1.3] tracking-[0.04em]"
          style={{ color: isLight ? '#000000' : '#FFFFFF' }}
        >
          {title}
        </h4>
      </div>
      <p
        className="mt-2 text-[12px] font-normal leading-[1.4]"
        style={{ color: isLight ? 'rgba(0,0,0,0.65)' : 'rgba(255,255,255,0.65)' }}
      >
        {description}
      </p>
    </div>
  )
}
