import { useEffect, useRef, useState } from 'react'

const ORIGINAL = 'The Privacy DeFi Entryway, starting with Zcash'
const CHARS = 'ABCDEF0123456789/?!@#$%^&*()_+-=[]{}|;:,.<>øπΩμ∑†‡'
const PRESERVE = new Set([' ', ',', '.'])

export function Hero() {
  const sectionRef = useRef<HTMLElement>(null)
  const [text, setText] = useState(ORIGINAL)
  const [opacity, setOpacity] = useState(1)
  const [blur, setBlur] = useState(0)
  useEffect(() => {
    let raf = 0

    const onFrame = () => {
      const el = sectionRef.current
      if (!el) {
        raf = requestAnimationFrame(onFrame)
        return
      }

      const rect = el.getBoundingClientRect()
      const progress = Math.min(Math.max(-rect.top / 600, 0), 1)

      let scrambled = ''
      for (let i = 0; i < ORIGINAL.length; i++) {
        if (PRESERVE.has(ORIGINAL[i])) {
          scrambled += ORIGINAL[i]
        } else if (Math.random() < progress) {
          scrambled += CHARS[Math.floor(Math.random() * CHARS.length)]
        } else {
          scrambled += ORIGINAL[i]
        }
      }

      setText(scrambled)
      setOpacity(1 - progress * 0.8)
      setBlur(progress * 4)

      raf = requestAnimationFrame(onFrame)
    }

    raf = requestAnimationFrame(onFrame)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <section
      id="hero"
      ref={sectionRef}
      className="relative mx-auto h-[calc(100dvh-20px)] md:h-[calc(100dvh-100px)] max-w-[1440px] px-5 text-center flex flex-col items-center justify-center"
    >
      <p className="text-base font-medium tracking-[0.14em] text-primary md:text-xl">
        Noir Privacy Wallet
      </p>

      <h1
        className="mx-auto mt-8 max-w-[849px] whitespace-pre-wrap font-serif text-[28px] font-medium leading-[1.2] tracking-[0.04em] text-white md:mt-[50px] md:text-[50px] md:tracking-[0.06em] min-h-[110px]"
        style={{
          opacity,
          filter: `blur(${blur}px)`,
          willChange: 'filter, opacity'
        }}
      >
        {text}
      </h1>

      <div className="mt-6 flex flex-wrap items-center justify-center gap-3 md:mt-8">
        <a
          href="https://app.zknoir.com/"
          target="_blank"
          rel="noopener noreferrer"
          className="flex h-12 min-w-[150px] items-center justify-center rounded-[14px] border border-white px-7 text-sm font-normal text-white transition-colors hover:bg-white/10"
        >
          Launch App
        </a>
        <a
          href="/v2/beta"
          className="flex h-12 min-w-[150px] items-center justify-center rounded-[14px] bg-primary px-7 text-sm font-medium text-black transition-opacity hover:opacity-80"
        >
          Try V2 Beta
        </a>
      </div>
    </section>
  )
}
