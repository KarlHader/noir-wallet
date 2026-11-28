/**
 * Shield & Win campaign entry on the home page, per the design mock ("Go Private, Win …"). The
 * prize, minimum and dates come from the campaign API, the same data the campaign page shows;
 * the copy is built in campaignCopy.ts.
 * Desktop: a countdown ticket in the bottom-right corner (clear of the support chat) opens a
 * sheet with the three steps and Join Now; its close button hides it until the next visit.
 * Phones cannot run the extension, so on every visit a sheet sends people to a computer and
 * offers the site link to copy.
 */
import './campaign.css'
import { type MouseEvent, useEffect, useRef, useState } from 'react'
import { getCampaigns, selectCampaign, type ShieldWinCampaign } from '../shield-and-win/api'
import { entryCopy } from './campaignCopy'
import { Icon } from './Icon'
import { walletLinkProps } from './walletStore'

const CAMPAIGN_PAGE = '/campaign'
const SITE_LINK = 'https://www.zknoir.com'
// The mock's 3D coin, also used on the campaign page
const COIN = '/shield-and-win/zec-coin.png'
const PHONE = '(max-width: 759px)'

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

/**
 * Opens a sheet with focus on the sheet itself rather than its first button, so the close button
 * does not start out with a focus ring (the phone sheet opens on its own, which browsers treat
 * like keyboard focus). Tab then moves into the sheet.
 */
function openSheet(dialog: HTMLDialogElement | null) {
  if (!dialog || dialog.open) return
  dialog.showModal()
  dialog.focus()
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
  // Desktop: the ticket can be closed for this page view; every visit shows it again
  const [ticketClosed, setTicketClosed] = useState(false)
  const phase = campaign ? phaseOf(campaign, now) : null
  const running = phase !== null

  // Phones: open the "use a computer" sheet on every visit, even if it was closed last time,
  // shortly after the page settles.
  useEffect(() => {
    if (!running || !window.matchMedia(PHONE).matches) return
    const timer = window.setTimeout(() => openSheet(phoneRef.current), 1200)
    return () => window.clearTimeout(timer)
  }, [running])

  if (!campaign || !phase) return null

  const copy = entryCopy(campaign)
  const title = copy.title
  const time = countdown(phase.target, now)
  const when =
    phase.kind === 'upcoming'
      ? `Starts ${dateLabel(campaign.start_time)}`
      : `Ends ${dateLabel(campaign.end_time)}`

  const copyLink = () => {
    const done = () => setCopied(true)
    if (navigator.clipboard) navigator.clipboard.writeText(SITE_LINK).then(done, done)
    else done()
  }

  return (
    <div className="cw" inert={inert}>
      {ticketClosed ? null : (
        <div className="cw-float">
          <button
            type="button"
            className="cw-badge"
            aria-label={`${title}. ${when}. See how to enter.`}
            onClick={() => openSheet(sheetRef.current)}
          >
            <Ticket title={title} when={when} {...time} />
          </button>
          <button
            type="button"
            className="cw-dismiss"
            aria-label={`Hide the ${title} ticket`}
            onClick={() => setTicketClosed(true)}
          >
            <Icon name="close" />
          </button>
        </div>
      )}

      <dialog
        ref={sheetRef}
        className="cw-sheet"
        tabIndex={-1}
        aria-labelledby="cw-title"
        onClick={closeOnBackdrop}
      >
        <div className="cw-sheet-in">
          <div className="cw-head">
            <h2 id="cw-title">
              {copy.heading}
              <img src={COIN} width={92} height={92} alt="" />
            </h2>
            <p className="cw-sub">{copy.lede}</p>
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
            {copy.steps.map((step, index) => (
              <li key={step.title}>
                <h3>
                  {index + 1}. {step.title}
                </h3>
                <p>{step.body}</p>
                {index === 0 && <a {...walletLinkProps}>Add to Chrome →</a>}
              </li>
            ))}
          </ol>
          <p className="cw-note">
            {copy.facts} · <a href={`${CAMPAIGN_PAGE}#rules`}>Full rules</a>
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
        tabIndex={-1}
        aria-labelledby="cw-phone-title"
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
