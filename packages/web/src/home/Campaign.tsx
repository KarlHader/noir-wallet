/**
 * Shield & Win campaign entry on the home page, per the design mock ("Go Private, Win …"). The
 * prize, minimum and dates come from the campaign API, the same data the campaign page shows.
 * Desktop: a countdown ticket in the bottom-right corner (clear of the support chat) opens a
 * sheet with the three steps and Join Now. Phones cannot run the extension, so once per visit a
 * sheet sends people to a computer and offers the site link to copy.
 */
import './campaign.css'
import { type MouseEvent, useEffect, useRef, useState } from 'react'
import { getCampaigns, selectCampaign, type ShieldWinCampaign } from '../shield-and-win/api'
import { Icon } from './Icon'
import { walletLinkProps } from './walletStore'

const CAMPAIGN_PAGE = '/campaign'
const SITE_LINK = 'https://www.zknoir.com'
// Stand-in for the mock's 3D coin until that image is exported
const COIN = '/shield-and-win/zec.svg'
const PHONE = '(max-width: 759px)'
/** Phones see their sheet once per browser session. */
const SEEN_KEY = 'noir:campaign-sheet-seen'

type Phase = { readonly kind: 'upcoming' | 'live'; readonly target: number }

/** Counts down to the start while the campaign is upcoming, then to the end; null once it is over. */
function phaseOf(campaign: ShieldWinCampaign, nowMs: number): Phase | null {
  const now = nowMs / 1000
  if (campaign.status === 'UPCOMING' && campaign.start_time > now) {
    return { kind: 'upcoming', target: campaign.start_time }
  }
  if ((campaign.status === 'ACTIVE' || campaign.status === 'UPCOMING') && campaign.end_time > now) {
    return { kind: 'live', target: campaign.end_time }
  }
  return null
}

const pad = (value: number) => String(value).padStart(2, '0')

function countdown(targetSeconds: number, nowMs: number) {
  const left = Math.max(0, Math.floor(targetSeconds - nowMs / 1000))
  const days = Math.floor(left / 86400)
  return {
    days: `${days} ${days === 1 ? 'Day' : 'Days'}`,
    clock: `${pad(Math.floor((left % 86400) / 3600))} : ${pad(Math.floor((left % 3600) / 60))} : ${pad(left % 60)}`
  }
}

/** UTC, like the campaign page, with the time so the day cannot be misread in other time zones. */
function dateLabel(seconds: number): string {
  const text = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(new Date(seconds * 1000))
  return `${text} UTC`
}

function prizeOf(campaign: ShieldWinCampaign): string {
  return `${campaign.reward_amount} ${campaign.reward_asset}`.trim()
}

function minimumOf(campaign: ShieldWinCampaign): string {
  const amount = Number(campaign.min_usd_value)
  return Number.isFinite(amount) && amount > 0
    ? `at least $${campaign.min_usd_value}`
    : 'any amount'
}

function winnersOf(campaign: ShieldWinCampaign): string {
  const prize = prizeOf(campaign)
  if (campaign.max_winners === 1) return `One winner gets ${prize}`
  if (campaign.max_winners === 0) return `Every winning draw gets ${prize}`
  return `Up to ${campaign.max_winners} winners get ${prize} each`
}

function useCampaign(): ShieldWinCampaign | null {
  const [campaign, setCampaign] = useState<ShieldWinCampaign | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    // Without campaign data the entry simply stays hidden.
    getCampaigns(controller.signal).then(
      list => setCampaign(selectCampaign(list)),
      () => undefined
    )
    return () => controller.abort()
  }, [])
  return campaign
}

function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])
  return now
}

/** Clicks on the dimmed page around a sheet close it. */
function closeOnBackdrop(event: MouseEvent<HTMLDialogElement>) {
  if (event.target === event.currentTarget) event.currentTarget.close()
}

/** The orange countdown ticket: used as the desktop button and at the top of the phone sheet. */
function Ticket({ title, days, clock, when }: Record<'title' | 'days' | 'clock' | 'when', string>) {
  return (
    <span className="cw-ticket">
      <span className="cw-tab">{title}</span>
      <span className="cw-card">
        <span className="cw-time">
          {days}
          <span>{clock}</span>
        </span>
        <span className="cw-when">{when}</span>
      </span>
      <img className="cw-coin" src={COIN} width={100} height={100} alt="" />
    </span>
  )
}

export default function Campaign({ inert }: { inert: boolean }) {
  const campaign = useCampaign()
  const now = useNow(campaign !== null)
  const sheetRef = useRef<HTMLDialogElement>(null)
  const phoneRef = useRef<HTMLDialogElement>(null)
  const [copied, setCopied] = useState(false)
  const phase = campaign ? phaseOf(campaign, now) : null
  const running = phase !== null

  // Phones: open the "use a computer" sheet once per session, shortly after the page settles.
  useEffect(() => {
    if (!running || !window.matchMedia(PHONE).matches) return
    try {
      if (window.sessionStorage.getItem(SEEN_KEY)) return
    } catch {
      // Storage blocked: show the sheet anyway.
    }
    const timer = window.setTimeout(() => phoneRef.current?.showModal(), 1200)
    return () => window.clearTimeout(timer)
  }, [running])

  if (!campaign || !phase) return null

  const title = `Go Private, Win ${prizeOf(campaign)}`
  const time = countdown(phase.target, now)
  const when =
    phase.kind === 'upcoming'
      ? `Starts ${dateLabel(campaign.start_time)}`
      : `Ends ${dateLabel(campaign.end_time)}`
  const minimum = minimumOf(campaign)

  const markSeen = () => {
    try {
      window.sessionStorage.setItem(SEEN_KEY, '1')
    } catch {
      // Storage blocked: it may show again next time.
    }
  }

  const copyLink = () => {
    const done = () => setCopied(true)
    if (navigator.clipboard) navigator.clipboard.writeText(SITE_LINK).then(done, done)
    else done()
  }

  return (
    <div className="cw" inert={inert}>
      <button
        type="button"
        className="cw-badge"
        aria-label={`${title}. ${when}. See how to enter.`}
        onClick={() => sheetRef.current?.showModal()}
      >
        <Ticket title={title} when={when} {...time} />
      </button>

      <dialog
        ref={sheetRef}
        className="cw-sheet"
        aria-labelledby="cw-title"
        onClick={closeOnBackdrop}
      >
        <div className="cw-sheet-in">
          <div className="cw-head">
            <h2 id="cw-title">
              {title}
              <img src={COIN} width={92} height={92} alt="" />
            </h2>
            <p className="cw-sub">Complete 3 steps to enter the draw:</p>
            <div className="cw-act">
              <p className="cw-clock">
                {phase.kind === 'upcoming' && <span className="cw-clock-label">Starts in</span>}
                {time.days}
                <span>{time.clock}</span>
              </p>
              <a className="cw-join" href={CAMPAIGN_PAGE}>
                Join Now
                <Icon name="arrow" />
              </a>
            </div>
          </div>
          <ol className="cw-steps">
            <li>
              <h3>1. Set up Noir</h3>
              <p>Install Noir, then create a new wallet or import your existing one.</p>
              <a {...walletLinkProps}>Add Noir to your browser extension →</a>
            </li>
            <li>
              <h3>2. Add funds (new wallets only)</h3>
              <p>Deposit {minimum} to your public address. Already have funds? Skip this step.</p>
            </li>
            <li>
              <h3>3. Shield once</h3>
              <p>
                Move {minimum} from your public balance to your shielded balance. That’s it. Your
                entry is confirmed in the app.
              </p>
            </li>
          </ol>
          <p className="cw-note">
            Entries close {dateLabel(campaign.end_time)}. {winnersOf(campaign)}, paid to the public
            address you shielded from.
          </p>
          <button
            type="button"
            className="cw-close"
            aria-label="Close"
            onClick={() => sheetRef.current?.close()}
          >
            <Icon name="close" />
          </button>
        </div>
      </dialog>

      <dialog
        ref={phoneRef}
        className="cw-phone"
        aria-labelledby="cw-phone-title"
        onClose={markSeen}
        onClick={closeOnBackdrop}
      >
        <div className="cw-phone-in">
          <Ticket title={title} when={when} {...time} />
          <button
            type="button"
            className="cw-close"
            aria-label="Close"
            onClick={() => phoneRef.current?.close()}
          >
            <Icon name="close" />
          </button>
          <span className="cw-laptop" aria-hidden="true">
            💻
          </span>
          <h2 id="cw-phone-title">Noir runs on browser extension</h2>
          <p>To enter the {title.replace(',', '')} draw, open this link on your laptop or PC:</p>
          <button type="button" className="cw-copy" onClick={copyLink}>
            {copied ? 'Link copied' : 'www.zknoir.com'}
            <Icon name="copy" />
          </button>
        </div>
      </dialog>
    </div>
  )
}
