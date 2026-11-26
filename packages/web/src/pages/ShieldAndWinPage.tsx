import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import {
  ShieldWinApiError,
  claimReward,
  getAllEntries,
  getCampaigns,
  getEntries,
  selectCampaign,
  type ShieldWinCampaign,
  type ShieldWinEntry
} from '../shield-and-win/api'
import { assetLabel, getAssetLabels } from '../shield-and-win/asset-label'
import {
  clearCachedCampaign,
  readCachedCampaign,
  writeCachedCampaign
} from '../shield-and-win/campaign-cache'
import { claimMessage, utf8ToHex } from '../shield-and-win/claim'
import {
  ENTRY_POLL_INTERVAL_MS,
  ENTRY_POLL_LIMIT,
  REWARD_POLL_INTERVAL_MS,
  REWARD_POLL_LIMIT,
  boardView,
  campaignStatusWord,
  closedCampaignHint,
  deadlineLabel,
  entryCopy,
  entryView,
  latestEntry,
  rewardTransactionUrl,
  sortedEntries,
  unclaimedWins,
  type EntryViewState
} from '../shield-and-win/view'
import {
  detectNoirWallet,
  detectZcashProvider,
  readAccounts,
  readTransparentAddress,
  requestAccount,
  revokeAccount,
  signClaim,
  subscribeAccounts,
  walletErrorMessage,
  type NoirEthereumProvider
} from '../shield-and-win/wallet'
import { Tooltip } from '../components/Tooltip'
import '../shield-and-win/shield-and-win.css'

const FONT_HREF =
  'https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,100;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;0,9..40,900&family=Doto:wght@400;700&display=swap'
const CHROME_STORE_URL =
  'https://chromewebstore.google.com/detail/mfoghjbpfanobmnoemoepenjjcmfpmdn?utm_source=shield_and_win'
const SUPPORT_URL = 'https://t.me/noirprivacy'
const DRAW_PENDING_MESSAGE =
  'Your draw is still processing. Check this page again in a little while.'
const PHONE_HINT = 'Noir Wallet runs in desktop Chrome.'
const INSTALL_HINT = 'Installed it just now? Refresh this page.'
const CAMPAIGN_ERROR = 'The campaign could not be loaded.'
const CONNECT_HINT = 'Connect to see your entry and result on this page.'
const TOOLBAR_HINT = 'Open Noir Wallet from the Chrome toolbar.'
const PUBLIC_TOOLTIP_SRC = '/shield-and-win/select-public-tooltip.png'
const ENTRY_REFRESH_COOLDOWN_MS = 60_000

type CampaignState = 'loading' | 'ready' | 'error'
type WalletSnapshot = { entries: readonly ShieldWinEntry[]; wins: readonly ShieldWinEntry[] }

function detectPhone(): boolean {
  if (typeof window === 'undefined') return false
  return window.innerWidth < 760 || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function isTransportError(error: unknown): boolean {
  if (error instanceof ShieldWinApiError || isAbortError(error)) return false
  if (error instanceof TypeError) return true
  if (!(error instanceof Error)) return false
  return /could not be reached|unreadable response|failed to fetch|load failed|networkerror|network error/i.test(
    error.message
  )
}

function claimCodeMessage(code: number): string {
  switch (code) {
    case -500:
      return 'Claiming is temporarily unavailable.'
    case 2004:
      return 'This reward has already been claimed.'
    case 4004:
      return 'This entry was not found.'
    case -401:
      return 'The signature or wallet does not match.'
    case -400:
      return 'Check the transparent address.'
    default:
      return 'The claim could not be submitted.'
  }
}

function rewardText(entry: ShieldWinEntry): string {
  return [entry.reward_amount, entry.reward_asset].filter(part => part && part.length > 0).join(' ')
}

function shortPayoutAddress(value: string): string {
  if (value.length <= 11) return value
  return `${value.slice(0, 6)}…${value.slice(-5)}`
}

function qualifyHint(minimumValue: string): string {
  return `Only transfers into NEAR Confidential count. At least ${minimumValue} must land after fees.`
}

function isInFlight(entry: ShieldWinEntry): boolean {
  return entry.reward_status === 'CLAIMING' || entry.reward_status === 'SENDING'
}

function inFlightKey(entries: readonly ShieldWinEntry[], wins: readonly ShieldWinEntry[]): string {
  const ids = new Set<number>()
  for (const entry of entries) if (isInFlight(entry)) ids.add(entry.id)
  for (const entry of wins) if (isInFlight(entry)) ids.add(entry.id)
  return [...ids].sort((left, right) => left - right).join(',')
}

function mergeEntries(
  entries: readonly ShieldWinEntry[],
  wins: readonly ShieldWinEntry[]
): ShieldWinEntry[] {
  const map = new Map<number, ShieldWinEntry>()
  for (const entry of entries) map.set(entry.id, entry)
  for (const entry of wins) map.set(entry.id, entry)
  return [...map.values()]
}

function chipTone(view: EntryViewState): string {
  switch (view) {
    case 'won':
    case 'claiming':
    case 'sending':
    case 'claimed':
      return 'gold'
    case 'failed':
      return 'warn'
    default:
      return ''
  }
}

function entryTone(view: EntryViewState): string {
  switch (view) {
    case 'won':
    case 'claiming':
    case 'sending':
    case 'claimed':
    case 'failed':
      return `is-${view}`
    default:
      return ''
  }
}

function completedLabel(timestamp: number): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(timestamp))
}

function EntryRow({
  entry,
  phone,
  claimBusy,
  assetLabels,
  onClaim
}: {
  entry: ShieldWinEntry
  phone: boolean
  claimBusy: boolean
  assetLabels: ReadonlyMap<string, string>
  onClaim: (entry: ShieldWinEntry) => void
}) {
  const view = entryView(entry)
  const copy = entryCopy(view, entry)
  const chipClass = chipTone(view)
  const transactionUrl = rewardTransactionUrl(entry)
  return (
    <li className={`entry-row ${entryTone(view)}`}>
      <div className="entry-details">
        <div>
          <span>Asset</span>
          <b title={entry.destination_asset}>{assetLabel(entry.destination_asset, assetLabels)}</b>
        </div>
        <div>
          <span>USD value</span>
          <b>${entry.usd_value}</b>
        </div>
        <div>
          <span>Completed</span>
          <b>{completedLabel(entry.shield_completed_at)}</b>
        </div>
      </div>
      <div className="entry-result">
        <div>
          <span className="entry-k">
            {view === 'notwon' ? 'Draw result' : 'Reward status'} &nbsp;
          </span>
          <span className={chipClass ? `chip ${chipClass}` : 'chip'}>{copy.title}</span>
          {!!copy.body && <p>{copy.body}</p>}
          {view === 'won' ? <small>{rewardText(entry)}</small> : null}
        </div>
        {view === 'won' && !phone ? (
          <button
            type="button"
            className="btn primary"
            disabled={claimBusy}
            onClick={() => onClaim(entry)}
          >
            Claim
          </button>
        ) : view === 'failed' ? (
          <SupportLink />
        ) : transactionUrl ? (
          <a
            className="entry-tx"
            href={transactionUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="View payout transaction on Blockchair"
          >
            Tx <span aria-hidden="true">↗</span>
          </a>
        ) : null}
      </div>
      {view === 'claiming' || view === 'sending' ? (
        <span className="dots" aria-hidden="true">
          {Array.from({ length: 8 }, (_, index) => (
            <i key={index} style={{ '--k': index } as CSSProperties} />
          ))}
        </span>
      ) : null}
    </li>
  )
}

function SupportLink() {
  return (
    <a className="textlink" href={SUPPORT_URL} target="_blank" rel="noopener noreferrer">
      Contact support
    </a>
  )
}

function DownloadIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  )
}

function AssureIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3 5 6v5.2c0 4.3 2.9 8 7 9.8 4.1-1.8 7-5.5 7-9.8V6l-7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  )
}

function DisconnectIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  )
}

function RefreshIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M3 21v-5h5" />
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  )
}

function EntriesRefreshButton({
  busy,
  cooling,
  blocked,
  onRefresh
}: {
  busy: boolean
  cooling: boolean
  blocked: boolean
  onRefresh: () => void
}) {
  return (
    <button
      type="button"
      className={busy ? 'entry-refresh is-busy' : 'entry-refresh'}
      aria-label="Refresh your entries"
      title={cooling ? 'Available again in one minute' : 'Refresh entries'}
      aria-busy={busy}
      disabled={busy || cooling || blocked}
      onClick={onRefresh}
    >
      <RefreshIcon />
    </button>
  )
}

function Tbc() {
  return <span className="tbc">TBC</span>
}

function shortAddress(value: string): string {
  if (value.length <= 8) return value
  return `${value.slice(0, 4)}...${value.slice(-4)}`
}

function prizeAmount(campaign: ShieldWinCampaign): string {
  return [campaign.reward_amount, campaign.reward_asset].filter(part => part.length > 0).join(' ')
}

function minimumAmount(campaign: ShieldWinCampaign, minimumValue: string): string {
  if (minimumValue) return minimumValue
  return campaign.min_usd_value.startsWith('$')
    ? campaign.min_usd_value
    : `$${campaign.min_usd_value}`
}

function endingCopy(campaign: ShieldWinCampaign): string {
  if (campaign.status === 'ACTIVE') {
    const deadline = deadlineLabel(campaign.end_time)
    const when = deadline ? `, or at the deadline ${deadline}` : ''
    return `The campaign ends the moment it's won${when}. It may end with no winner.`
  }
  return `The campaign status is ${campaignStatusWord(campaign.status)}.`
}

function RulesCopy({
  campaign,
  minimumValue
}: {
  campaign: ShieldWinCampaign
  minimumValue: string
}) {
  const minimum = minimumAmount(campaign, minimumValue)
  const prize = prizeAmount(campaign)
  const ending = endingCopy(campaign)
  return (
    <>
      <ul>
        <li>
          <b>How to join:</b> install Noir Wallet, create or import a wallet, then make a private
          transfer of <b>{minimum} or more</b> into <b>NEAR Confidential</b> from your Public or
          Private account (in the wallet: Shield → NEAR Confidential). Use the latest version of
          Noir Wallet.
        </li>
        <li>
          We count the USD value credited after network, bridge and protocol fees. Smaller transfers
          can&apos;t be added together.
        </li>
        <li>
          Each eligible transfer gets one automatic draw as soon as it&apos;s credited. at{' '}
          <strong>1 in 4,444</strong> (about 0.0225%). That doesn&apos;t mean someone wins every
          4,444 draws.
        </li>
        <li>
          {campaign.max_winners === 0 ? (
            <>
              There is <b>no winner cap</b>. Each prize is <b>{prize}</b>.
            </>
          ) : campaign.max_winners === 1 ? (
            <>
              There is <b>one prize of {prize}</b>.
            </>
          ) : (
            <>
              There are{' '}
              <b>
                up to {campaign.max_winners} prizes of {prize}
              </b>
              .
            </>
          )}{' '}
          {ending}
        </li>
        <li>
          Only transfers into NEAR Confidential count. Zcash Shield, Railgun, Privacy Pool, ZAMA,
          moving funds out of or within NEAR Confidential, sending to another address, swaps, and
          failed or refunded transfers don&apos;t count.
        </li>
        <li>
          The draw runs once per transfer on our server. Refreshing, closing or reinstalling never
          draws again.
        </li>
        <li>
          The winner claims to a Zcash transparent address in Noir Wallet. We pay the network fee,
          so the full {prize} ZEC arrives. Claim window <Tbc />.
        </li>
        <li>
          We never ask for your seed phrase or keys, and never publish your balances, addresses or
          the path of your funds. &quot;Draws so far&quot; is a total count only.
        </li>
        <li>
          Entries per wallet, regions and age limits <Tbc />. Fees are shown before you sign.
          Winning isn&apos;t guaranteed.
        </li>
      </ul>
      <p className="rules-foot">
        Full terms and eligibility restrictions apply <Tbc />.
      </p>
    </>
  )
}

function readInitialCampaign(): { campaign: ShieldWinCampaign | null; reveal: boolean } {
  const campaign = readCachedCampaign()
  return { campaign, reveal: campaign === null }
}

export default function ShieldAndWinPage() {
  const initialProvider = typeof window === 'undefined' ? null : detectNoirWallet()
  const [campaignStart] = useState(readInitialCampaign)
  const [campaignState, setCampaignState] = useState<CampaignState>(
    campaignStart.campaign ? 'ready' : 'loading'
  )
  const [campaign, setCampaign] = useState<ShieldWinCampaign | null>(campaignStart.campaign)
  const [provider, setProvider] = useState<NoirEthereumProvider | null>(initialProvider)
  const [walletReady, setWalletReady] = useState(initialProvider !== null)
  const [accountReady, setAccountReady] = useState(false)
  const [address, setAddress] = useState<string | null>(null)
  const [entries, setEntries] = useState<readonly ShieldWinEntry[]>([])
  const [wins, setWins] = useState<readonly ShieldWinEntry[]>([])
  const [entriesReady, setEntriesReady] = useState(false)
  const [entriesError, setEntriesError] = useState(false)
  const [entryTotal, setEntryTotal] = useState(0)
  const [allEntriesOpen, setAllEntriesOpen] = useState(false)
  const [allEntriesLoading, setAllEntriesLoading] = useState(false)
  const [allEntriesError, setAllEntriesError] = useState(false)
  const [allEntriesRetry, setAllEntriesRetry] = useState(0)
  const [phone, setPhone] = useState(detectPhone)
  const [now, setNow] = useState(() => Date.now())
  const [rulesOpen, setRulesOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [noticeWarn, setNoticeWarn] = useState(false)
  const [drawPending, setDrawPending] = useState(false)
  const [copied, setCopied] = useState(false)
  const [claimOpen, setClaimOpen] = useState(false)
  const [claimTarget, setClaimTarget] = useState<ShieldWinEntry | null>(null)
  const [payoutAddress, setPayoutAddress] = useState<string | null>(null)
  const [claimError, setClaimError] = useState<string | null>(null)
  const [claimBusy, setClaimBusy] = useState(false)
  const [connectBusy, setConnectBusy] = useState(false)
  const [liveText, setLiveText] = useState('')
  const [entryRefreshBusy, setEntryRefreshBusy] = useState(false)
  const [entryRefreshCooling, setEntryRefreshCooling] = useState(false)
  const [assetLabels, setAssetLabels] = useState<ReadonlyMap<string, string>>(new Map())

  const addressRef = useRef(address)
  const campaignRef = useRef(campaign)
  const mountedRef = useRef(true)
  const awaitingDraw = useRef(false)
  const seenView = useRef<EntryViewState | null>(null)
  const claimAbort = useRef<AbortController | null>(null)
  const entryPoll = useRef<{ timer: number; controller: AbortController } | null>(null)
  const entryRefreshAbort = useRef<AbortController | null>(null)
  const entryRefreshCooldownTimer = useRef(0)
  const entryRefreshGate = useRef({ busy: false, cooling: false })
  const allEntriesLoaded = useRef(false)
  const allEntriesAbort = useRef<AbortController | null>(null)
  const rulesRef = useRef<HTMLDialogElement>(null)
  const claimRef = useRef<HTMLDialogElement>(null)
  const entriesRef = useRef<HTMLDialogElement>(null)
  const clearConnectedRef = useRef<() => void>(() => undefined)
  addressRef.current = address
  campaignRef.current = campaign

  const scopeKey = `${address ?? ''}:${campaign?.id ?? ''}`
  const [seenScope, setSeenScope] = useState(scopeKey)
  if (seenScope !== scopeKey) {
    setSeenScope(scopeKey)
    setEntries([])
    setWins([])
    setEntriesReady(false)
    setEntriesError(false)
    setDrawPending(false)
    setEntryTotal(0)
    setAllEntriesOpen(false)
    setAllEntriesLoading(false)
    setAllEntriesError(false)
    allEntriesLoaded.current = false
  }

  const board = boardView(campaignState === 'ready' ? campaign : null, now)
  const latest = latestEntry(entries)
  const view = entryView(latest)
  const copy = entryCopy(view, latest)
  const orderedEntries = sortedEntries(entries)
  const claimable = unclaimedWins(mergeEntries(entries, wins))
  const rewardKey = inFlightKey(entries, wins)
  const showEntry =
    Boolean(address) && entriesReady && !entriesError && !(drawPending && view === 'none')
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  function stopEntryPoll() {
    const current = entryPoll.current
    if (!current) return
    window.clearTimeout(current.timer)
    current.controller.abort()
    entryPoll.current = null
  }

  function clearConnectedWallet() {
    stopEntryPoll()
    awaitingDraw.current = false
    addressRef.current = null
    entryRefreshAbort.current?.abort()
    allEntriesAbort.current?.abort()
    claimAbort.current?.abort()
    claimAbort.current = null
    setAddress(null)
    setEntries([])
    setWins([])
    setEntriesReady(false)
    setEntriesError(false)
    setEntryTotal(0)
    setAllEntriesOpen(false)
    allEntriesLoaded.current = false
    window.clearTimeout(entryRefreshCooldownTimer.current)
    entryRefreshGate.current = { busy: false, cooling: false }
    setEntryRefreshBusy(false)
    setEntryRefreshCooling(false)
    setAssetLabels(new Map())
    setDrawPending(false)
    setClaimOpen(false)
    setClaimBusy(false)
    setClaimTarget(null)
    setPayoutAddress(null)
    setClaimError(null)
  }
  clearConnectedRef.current = clearConnectedWallet

  async function loadWalletData(signal: AbortSignal, full = false): Promise<WalletSnapshot | null> {
    const walletAddress = addressRef.current
    const current = campaignRef.current
    if (!walletAddress || !current || signal.aborted) return null
    const [entryPage, winPage] = await Promise.all([
      full
        ? getAllEntries({ wallet_address: walletAddress, campaign_id: current.id }, signal).then(
            list => ({ list, total: list.length })
          )
        : getEntries(
            {
              wallet_address: walletAddress,
              campaign_id: current.id,
              page_size: 20,
              page_number: 1
            },
            signal
          ),
      getEntries(
        {
          wallet_address: walletAddress,
          draw_result: 'WON',
          page_size: 20,
          page_number: 1
        },
        signal
      )
    ])
    if (
      signal.aborted ||
      !mountedRef.current ||
      addressRef.current !== walletAddress ||
      campaignRef.current?.id !== current.id
    )
      return null
    if (full) allEntriesLoaded.current = true
    setEntries(previous => {
      if (full || !allEntriesLoaded.current) return entryPage.list
      const merged = new Map(previous.map(entry => [entry.id, entry]))
      for (const entry of entryPage.list) merged.set(entry.id, entry)
      return [...merged.values()]
    })
    setEntryTotal(entryPage.total)
    setWins(winPage.list)
    setEntriesError(false)
    return { entries: entryPage.list, wins: winPage.list }
  }

  function startEntryPoll() {
    stopEntryPoll()
    const controller = new AbortController()
    let attempts = 0
    entryPoll.current = { controller, timer: 0 }
    const run = async () => {
      if (controller.signal.aborted || !mountedRef.current) return
      attempts += 1
      try {
        const snapshot = await loadWalletData(controller.signal)
        if (controller.signal.aborted || !mountedRef.current || !snapshot) return
        if (snapshot.entries.length > 0) {
          awaitingDraw.current = false
          setDrawPending(false)
          entryPoll.current = null
          return
        }
        if (attempts >= ENTRY_POLL_LIMIT) {
          awaitingDraw.current = false
          setDrawPending(true)
          setNotice(null)
          entryPoll.current = null
          return
        }
        const timer = window.setTimeout(() => void run(), ENTRY_POLL_INTERVAL_MS)
        entryPoll.current = { controller, timer }
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error) || !mountedRef.current) return
        if (attempts >= ENTRY_POLL_LIMIT) {
          awaitingDraw.current = false
          setNotice('Your entry could not be loaded.')
          setNoticeWarn(true)
          entryPoll.current = null
          return
        }
        const timer = window.setTimeout(() => void run(), ENTRY_POLL_INTERVAL_MS)
        entryPoll.current = { controller, timer }
      }
    }
    void run()
  }

  useEffect(() => {
    const links = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'].map(
      (href, index) => {
        const link = document.createElement('link')
        link.rel = 'preconnect'
        link.href = href
        if (index === 1) link.crossOrigin = 'anonymous'
        document.head.appendChild(link)
        return link
      }
    )
    const sheet = document.createElement('link')
    sheet.rel = 'stylesheet'
    sheet.href = FONT_HREF
    document.head.appendChild(sheet)
    return () => {
      for (const link of links) link.remove()
      sheet.remove()
    }
  }, [])

  useEffect(() => {
    const previous = document.title
    document.title = 'Shield & Win · Noir Wallet'
    return () => {
      document.title = previous
    }
  }, [])

  useEffect(() => {
    if (!campaign) return
    const reward = `${campaign.reward_amount} ${campaign.reward_asset}`.trim()
    if (!reward) return
    document.title = `Go Private, Win ${reward} · Noir Wallet`
  }, [campaign])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      claimAbort.current?.abort()
      stopEntryPoll()
      entryRefreshAbort.current?.abort()
      allEntriesAbort.current?.abort()
      window.clearTimeout(entryRefreshCooldownTimer.current)
    }
  }, [])

  useEffect(() => {
    const onResize = () => setPhone(detectPhone())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const mark = () => {
      const next = detectNoirWallet()
      setProvider(current => (current === next ? current : next))
      if (next) setWalletReady(true)
    }
    mark()
    const timer = window.setTimeout(() => setWalletReady(true), 400)
    window.addEventListener('noirwallet#initialized', mark)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('noirwallet#initialized', mark)
    }
  }, [])

  useEffect(() => {
    if (!provider) {
      setAccountReady(true)
      return
    }
    let stopped = false
    const refresh = new AbortController()
    setAccountReady(false)
    void readAccounts(provider).then(
      account => {
        if (stopped) return
        setAddress(account)
        setAccountReady(true)
      },
      error => {
        if (stopped || isAbortError(error)) return
        setAccountReady(true)
        setNotice(walletErrorMessage(error))
        setNoticeWarn(true)
      }
    )
    const unsubscribe = subscribeAccounts(provider, account => {
      if (stopped) return
      if (!account) {
        clearConnectedRef.current()
        setAccountReady(true)
        return
      }
      if (account !== addressRef.current) {
        addressRef.current = account
        entryRefreshAbort.current?.abort()
      }
      setAddress(account)
      setAccountReady(true)
      if (!campaignRef.current) return
      void loadWalletData(refresh.signal).catch(error => {
        if (isAbortError(error)) return
      })
    })
    return () => {
      stopped = true
      refresh.abort()
      unsubscribe()
    }
  }, [provider])

  useEffect(() => {
    const controller = new AbortController()
    let stopped = false
    void (async () => {
      try {
        const list = await getCampaigns(controller.signal)
        if (stopped) return
        const next = selectCampaign(list)
        setCampaign(next)
        setCampaignState('ready')
        if (next) writeCachedCampaign(next)
        else clearCachedCampaign()
      } catch (error) {
        if (stopped || isAbortError(error)) return
        if (campaignRef.current) return
        setCampaign(null)
        setCampaignState('error')
      }
    })()
    return () => {
      stopped = true
      controller.abort()
    }
  }, [])

  useEffect(() => {
    if (board.state !== 'live') return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [board.state])

  useEffect(() => {
    const previousAddress = addressRef.current
    let stopped = false
    const controller = new AbortController()
    stopEntryPoll()
    if (!address || !campaign) {
      return () => {
        stopped = true
        controller.abort()
      }
    }
    void (async () => {
      try {
        const snapshot = await loadWalletData(controller.signal)
        if (stopped || !snapshot) return
        setEntriesReady(true)
        if (snapshot.entries.length > 0) {
          awaitingDraw.current = false
          setDrawPending(false)
          return
        }
        if (awaitingDraw.current) startEntryPoll()
      } catch (error) {
        if (stopped || isAbortError(error)) return
        setEntriesReady(true)
        setEntriesError(true)
        setNotice('Your entry could not be loaded.')
        setNoticeWarn(true)
      }
    })()
    return () => {
      stopped = true
      controller.abort()
      stopEntryPoll()
      if (previousAddress && previousAddress !== addressRef.current) {
        awaitingDraw.current = false
        entryRefreshAbort.current?.abort()
      }
    }
    // loadWalletData and startEntryPoll read the latest address and campaign through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, campaign])

  useEffect(() => {
    if (!rewardKey) return
    const controller = new AbortController()
    let stopped = false
    let attempts = 0
    let timer = 0
    const tick = async () => {
      if (stopped) return
      attempts += 1
      if (attempts > REWARD_POLL_LIMIT) return
      try {
        await loadWalletData(controller.signal)
      } catch (error) {
        if (stopped || isAbortError(error)) return
      }
      if (stopped || attempts >= REWARD_POLL_LIMIT) return
      timer = window.setTimeout(() => void tick(), REWARD_POLL_INTERVAL_MS)
    }
    timer = window.setTimeout(() => void tick(), REWARD_POLL_INTERVAL_MS)
    return () => {
      stopped = true
      controller.abort()
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rewardKey])

  useEffect(() => {
    const dialog = rulesRef.current
    if (!dialog) return
    if (rulesOpen && !dialog.open) dialog.showModal()
    if (!rulesOpen && dialog.open) dialog.close()
  }, [rulesOpen])

  useEffect(() => {
    const dialog = claimRef.current
    if (!dialog) return
    if (claimOpen && !dialog.open) dialog.showModal()
    if (!claimOpen && dialog.open) dialog.close()
  }, [claimOpen])

  useEffect(() => {
    const dialog = entriesRef.current
    if (!dialog) return
    if (allEntriesOpen && !dialog.open) dialog.showModal()
    if (!allEntriesOpen && dialog.open) dialog.close()
  }, [allEntriesOpen])

  useEffect(() => {
    entryRefreshAbort.current?.abort()
    allEntriesAbort.current?.abort()
    window.clearTimeout(entryRefreshCooldownTimer.current)
    entryRefreshGate.current = { busy: false, cooling: false }
    setEntryRefreshBusy(false)
    setEntryRefreshCooling(false)
  }, [scopeKey])

  const hasEntries = entries.length > 0 || wins.length > 0
  useEffect(() => {
    setAssetLabels(new Map())
    if (!address || !entriesReady || !hasEntries) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 8_000)
    void getAssetLabels(controller.signal).then(
      labels => {
        if (!controller.signal.aborted) setAssetLabels(labels)
      },
      () => undefined
    )
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [address, entriesReady, hasEntries])

  useEffect(() => {
    if (!allEntriesOpen || allEntriesLoaded.current) return
    const controller = new AbortController()
    allEntriesAbort.current = controller
    setAllEntriesLoading(true)
    setAllEntriesError(false)
    void loadWalletData(controller.signal, true)
      .then(
        snapshot => {
          if (!controller.signal.aborted && mountedRef.current && !snapshot)
            setAllEntriesError(true)
        },
        error => {
          if (!controller.signal.aborted && !isAbortError(error) && mountedRef.current) {
            setAllEntriesError(true)
          }
        }
      )
      .finally(() => {
        if (allEntriesAbort.current === controller) allEntriesAbort.current = null
        if (!controller.signal.aborted && mountedRef.current) setAllEntriesLoading(false)
      })
    return () => controller.abort()
    // loadWalletData reads the current wallet and campaign through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allEntriesOpen, allEntriesRetry, scopeKey])

  useEffect(() => {
    seenView.current = null
  }, [address])

  useEffect(() => {
    if (!address || !entriesReady || entriesError) return
    if (seenView.current === null) {
      seenView.current = view
      return
    }
    if (seenView.current === view) return
    seenView.current = view
    setLiveText(`${copy.title}. ${copy.body}`)
  }, [address, entriesReady, entriesError, view, copy.title, copy.body])

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      if (!addressRef.current || !campaignRef.current) return
      const controller = new AbortController()
      void loadWalletData(controller.signal).catch(error => {
        if (isAbortError(error)) return
      })
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function onParticipate() {
    // The extension cannot be opened from this page. The wallet opens on Shield from the toolbar.
    awaitingDraw.current = true
    setDrawPending(false)
    setNotice(null)
    setNoticeWarn(false)
  }

  async function onRefreshEntry() {
    const gate = entryRefreshGate.current
    if (gate.busy || gate.cooling) return
    if (!addressRef.current || !campaignRef.current) return
    gate.busy = true
    gate.cooling = true
    setEntryRefreshBusy(true)
    setEntryRefreshCooling(true)
    window.clearTimeout(entryRefreshCooldownTimer.current)
    entryRefreshCooldownTimer.current = window.setTimeout(() => {
      entryRefreshGate.current.cooling = false
      if (mountedRef.current) setEntryRefreshCooling(false)
    }, ENTRY_REFRESH_COOLDOWN_MS)
    const controller = new AbortController()
    entryRefreshAbort.current = controller
    try {
      await loadWalletData(controller.signal, allEntriesLoaded.current || allEntriesOpen)
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error) || !mountedRef.current) return
      setNotice('Your entry could not be loaded.')
      setNoticeWarn(true)
    } finally {
      if (entryRefreshAbort.current === controller) entryRefreshAbort.current = null
      gate.busy = false
      if (mountedRef.current) setEntryRefreshBusy(false)
    }
  }

  async function onDisconnect() {
    const current = detectNoirWallet()
    if (!current || !addressRef.current) return
    try {
      await revokeAccount(current)
      if (!mountedRef.current) return
      clearConnectedWallet()
    } catch (error) {
      if (!mountedRef.current || isAbortError(error)) return
      setNotice(walletErrorMessage(error))
      setNoticeWarn(true)
    }
  }

  async function onConnect() {
    const current = detectNoirWallet()
    if (!current || connectBusy) return
    setNotice(null)
    setNoticeWarn(false)
    setConnectBusy(true)
    try {
      const next = await requestAccount(current)
      if (!mountedRef.current) return
      setAddress(next)
      setAccountReady(true)
    } catch (error) {
      if (!mountedRef.current || isAbortError(error)) return
      setNotice(walletErrorMessage(error))
      setNoticeWarn(true)
    } finally {
      if (mountedRef.current) setConnectBusy(false)
    }
  }

  async function copyPageLink() {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopied(true)
    } catch {
      setNotice('Copy this page link into desktop Chrome.')
      setNoticeWarn(true)
    }
  }

  async function sharePage() {
    if (!canShare) {
      await copyPageLink()
      return
    }
    try {
      await navigator.share({ title: document.title, url: window.location.href })
    } catch (error) {
      if (isAbortError(error)) return
      await copyPageLink()
    }
  }

  async function openClaim(entry: ShieldWinEntry) {
    if (phone || claimBusy) return
    const current = detectNoirWallet()
    if (!current) {
      setNotice('Install Noir Wallet in desktop Chrome, then refresh this page.')
      setNoticeWarn(true)
      return
    }
    setClaimBusy(true)
    setNotice(null)
    setNoticeWarn(false)
    try {
      let walletAddress = addressRef.current
      if (!walletAddress) {
        walletAddress = await requestAccount(current)
        if (!mountedRef.current) return
        setAddress(walletAddress)
      }
      const zcash = detectZcashProvider()
      if (!zcash) throw new Error('Noir Wallet did not return a transparent address.')
      const payout = await readTransparentAddress(zcash)
      if (!mountedRef.current) return
      setClaimTarget(entry)
      setPayoutAddress(payout)
      setClaimError(null)
      setClaimOpen(true)
    } catch (error) {
      if (!mountedRef.current || isAbortError(error)) return
      setNotice(walletErrorMessage(error))
      setNoticeWarn(true)
    } finally {
      if (mountedRef.current) setClaimBusy(false)
    }
  }

  async function onSign() {
    if (claimBusy || !claimTarget || !payoutAddress) return
    const currentProvider = detectNoirWallet()
    const walletAddress = addressRef.current
    if (!currentProvider || !walletAddress) {
      setClaimError('Connect Noir Wallet to claim.')
      return
    }
    const controller = new AbortController()
    claimAbort.current = controller
    setClaimBusy(true)
    setClaimError(null)
    const entryId = claimTarget.id
    try {
      const message = claimMessage({
        entryId,
        walletAddress,
        zcashAddress: payoutAddress
      })
      if (!utf8ToHex(message).startsWith('0x')) {
        setClaimError('The claim could not be submitted.')
        return
      }
      const signature = await signClaim(currentProvider, walletAddress, message)
      if (controller.signal.aborted) return
      const result = await claimReward(
        {
          entry_id: entryId,
          wallet_address: walletAddress,
          zcash_address: payoutAddress,
          signature
        },
        controller.signal
      )
      if (controller.signal.aborted || !mountedRef.current) return
      setEntries(previous =>
        previous.map(entry =>
          entry.id === entryId ? { ...entry, reward_status: result.reward_status } : entry
        )
      )
      setWins(previous =>
        previous.map(entry =>
          entry.id === entryId ? { ...entry, reward_status: result.reward_status } : entry
        )
      )
      try {
        await loadWalletData(controller.signal, true)
      } catch (error) {
        if (isAbortError(error)) return
      }
      if (!mountedRef.current) return
      setClaimOpen(false)
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error) || !mountedRef.current) return
      if (error instanceof ShieldWinApiError) {
        const message = claimCodeMessage(error.code)
        if (error.code === 2004 || error.code === 4004) {
          try {
            await loadWalletData(controller.signal, true)
          } catch (reloadError) {
            if (isAbortError(reloadError)) return
          }
          if (!mountedRef.current) return
          setClaimOpen(false)
          setNotice(message)
          setNoticeWarn(true)
          return
        }
        setClaimError(message)
        return
      }
      if (isTransportError(error)) {
        let movedOn = false
        try {
          const snapshot = await loadWalletData(controller.signal, true)
          const current = snapshot
            ? mergeEntries(snapshot.entries, snapshot.wins).find(entry => entry.id === entryId)
            : undefined
          movedOn = Boolean(current?.reward_status && current.reward_status !== 'UNCLAIMED')
        } catch (reloadError) {
          if (isAbortError(reloadError)) return
        }
        if (!mountedRef.current) return
        if (movedOn) {
          setClaimOpen(false)
          return
        }
        setClaimError('The claim could not be confirmed. Check this page again.')
        return
      }
      setClaimError(walletErrorMessage(error))
    } finally {
      if (claimAbort.current === controller) claimAbort.current = null
      if (mountedRef.current) setClaimBusy(false)
    }
  }

  function closeOnBackdrop(event: MouseEvent<HTMLDialogElement>, close: () => void) {
    if (event.target === event.currentTarget) close()
  }

  let hint = ''
  let hintWarn = false
  if (notice && noticeWarn) {
    hint = notice
    hintWarn = true
  } else if (phone) {
    hint = PHONE_HINT
  } else if (notice) {
    hint = notice
  } else if (drawPending) {
    hint = DRAW_PENDING_MESSAGE
  } else if (!provider && walletReady && board.canJoin) {
    hint = INSTALL_HINT
  } else if (provider && accountReady && !address && board.canJoin && claimable.length === 0) {
    hint = CONNECT_HINT
  } else if (
    address &&
    campaign &&
    board.canJoin &&
    claimable.length === 0 &&
    board.minimumValue.length > 0
  ) {
    hint = qualifyHint(board.minimumValue)
  } else if (
    campaignState === 'ready' &&
    !board.canJoin &&
    claimable.length === 0 &&
    (!address || entriesReady)
  ) {
    hint = closedCampaignHint(board)
  }

  const actionsReady = phone || (walletReady && (!provider || accountReady))
  const prizeReady = Boolean(board.prizeAmount && board.prizeAsset)
  const showFixedWin = campaignState === 'loading' || prizeReady
  const accountPending = !walletReady || Boolean(provider && !accountReady)
  const connectLoading = accountPending || connectBusy
  const campaignOpen = campaignState === 'loading' || board.canJoin
  const showInstall =
    !phone &&
    walletReady &&
    !provider &&
    claimable.length === 0 &&
    (campaignState === 'loading' || board.canJoin)
  const showTry =
    !phone &&
    ((claimable.length === 0 && campaignOpen && (accountPending || Boolean(provider))) ||
      (claimable.length > 0 && Boolean(provider) && board.canJoin))
  const showConnect =
    !phone &&
    !address &&
    claimable.length === 0 &&
    campaignOpen &&
    !showInstall &&
    (connectLoading || Boolean(provider && accountReady))
  const showExplore =
    !phone &&
    campaignState === 'ready' &&
    !board.canJoin &&
    claimable.length === 0 &&
    (!address || entriesReady)
  const historicalWins = wins.filter(win => win.campaign_id !== campaign?.id)

  const renderEntry = (entry: ShieldWinEntry) => (
    <EntryRow
      key={entry.id}
      entry={entry}
      phone={phone}
      claimBusy={claimBusy}
      assetLabels={assetLabels}
      onClaim={item => void openClaim(item)}
    />
  )

  return (
    <div className="shield-win">
      <header className="top">
        <a className="brand" href="/">
          <img src="/shield-and-win/logo.jpg" alt="" />
          <span>Noir Wallet</span>
        </a>
        <div className="top-actions">
          <a className="home-btn" href="/">
            Home
          </a>
          <button type="button" className="rules-btn" onClick={() => setRulesOpen(true)}>
            Rules
          </button>
          {address ? (
            <>
              <span className="wallet-addr" title={address}>
                {shortAddress(address)}
              </span>
              <button
                type="button"
                className="disconnect"
                aria-label="Disconnect"
                onClick={() => void onDisconnect()}
              >
                <DisconnectIcon />
              </button>
            </>
          ) : null}
        </div>
      </header>

      <main>
        <section className="stage" aria-labelledby="title" aria-busy={campaignState === 'loading'}>
          <div className="lead">
            {campaignState === 'loading' ? (
              <div className="sk sk-eyebrow" aria-hidden="true" />
            ) : (
              <p className="eyebrow doto">{campaign?.name || 'Shield & Win'}</p>
            )}
            {showFixedWin ? (
              <h1 id="title">
                Go Private,
                <br />
                {'Win'}
                {prizeReady ? (
                  <>
                    {' '}
                    <span className={campaignStart.reveal ? 'hl reveal' : 'hl'}>
                      {board.prizeAmount}
                      {'\u00A0'}
                      {board.prizeAsset}
                    </span>
                  </>
                ) : null}
              </h1>
            ) : (
              <h1 id="title">Shield & Win</h1>
            )}
            {campaignState === 'error' ? (
              <p className="sub">{CAMPAIGN_ERROR}</p>
            ) : campaignState === 'ready' && !prizeReady ? (
              <p className="sub">No campaign is available right now.</p>
            ) : (
              <p className="sub">
                {'Try a private transfer'}
                {board.minimumValue ? (
                  <span className={campaignStart.reveal ? 'reveal' : undefined}>
                    {` (min ${board.minimumValue})`}
                  </span>
                ) : null}
                {' and get an instant draw.'}
              </p>
            )}

            <div className="actions">
              {actionsReady && phone ? (
                <button type="button" className="btn primary" onClick={() => void sharePage()}>
                  {canShare ? 'Send link to your computer' : copied ? 'Link copied' : 'Copy link'}
                </button>
              ) : null}
              {actionsReady && !phone && claimable.length > 0 ? (
                <button
                  type="button"
                  className="btn primary"
                  disabled={claimBusy}
                  onClick={() => void openClaim(claimable[0])}
                >
                  Claim
                </button>
              ) : null}
              {showInstall ? (
                <a
                  className="btn primary"
                  href={CHROME_STORE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <DownloadIcon />
                  Install Noir Wallet
                </a>
              ) : null}
              {showTry ? (
                <Tooltip content={TOOLBAR_HINT} side="top">
                  <button
                    type="button"
                    className={claimable.length > 0 ? 'btn ghost' : 'btn primary'}
                    onClick={onParticipate}
                  >
                    Try a private transfer
                  </button>
                </Tooltip>
              ) : null}
              {showExplore ? (
                <a className="btn ghost" href="/">
                  Explore Noir Wallet
                </a>
              ) : null}
              {showConnect ? (
                connectLoading ? (
                  <button type="button" className="btn ghost" disabled aria-busy="true">
                    <span className="btn-spin" aria-hidden="true" />
                    Connect Wallet
                  </button>
                ) : (
                  <Tooltip
                    content={
                      <img
                        src={PUBLIC_TOOLTIP_SRC}
                        alt="Select the Public account in Noir Wallet"
                      />
                    }
                    side="top"
                    variant="plain"
                  >
                    <button type="button" className="btn ghost" onClick={() => void onConnect()}>
                      Connect Wallet
                    </button>
                  </Tooltip>
                )
              ) : null}
            </div>
            <p className={hintWarn ? 'hint warn' : 'hint'} aria-live="polite">
              {hint}
            </p>

            {showEntry ? (
              <section className="entries-card" aria-label="Your entries">
                <div className="entries-head">
                  <h2>Your entries</h2>
                  <div className="entries-tools">
                    <EntriesRefreshButton
                      busy={entryRefreshBusy}
                      cooling={entryRefreshCooling}
                      blocked={allEntriesLoading || claimBusy}
                      onRefresh={() => void onRefreshEntry()}
                    />
                    <button
                      type="button"
                      className="entries-all"
                      onClick={() => setAllEntriesOpen(true)}
                    >
                      View all <span aria-hidden="true">→</span>
                    </button>
                  </div>
                </div>
                {orderedEntries.length > 0 ? (
                  <ul className="entries-list">{orderedEntries.slice(0, 3).map(renderEntry)}</ul>
                ) : (
                  <div className="entry-empty">
                    <p>{copy.body}</p>
                  </div>
                )}
              </section>
            ) : null}
            <p className="sr" aria-live="polite">
              {liveText}
            </p>

            {historicalWins.length > 0 ? (
              <section className="wins" aria-label="Your wins">
                <h2>Earlier wins</h2>
                <ul className="entries-list">{historicalWins.map(renderEntry)}</ul>
              </section>
            ) : null}

            <p className="assure">
              <AssureIcon />
              Your private transfer lands in your own private balance. The money stays yours.
            </p>
          </div>

          <aside className="board" aria-label="Campaign progress">
            <div className="board-top">
              {campaignState === 'loading' ? (
                <>
                  <span className="sk sk-pill" />
                  <span className="sk sk-note muted" />
                </>
              ) : (
                <>
                  <span className={board.state === 'live' ? 'pill' : 'pill ended'}>
                    <i />
                    <span>{board.pill}</span>
                  </span>
                  {board.winnerNote ? <span className="muted">{board.winnerNote}</span> : null}
                </>
              )}
            </div>
            {campaignState === 'loading' ? (
              <div className="prize">
                <div className="sk sk-coin" />
                <div className="prize-copy">
                  <div className="sk sk-prize-amt" />
                  <div className="sk sk-prize-sub" />
                </div>
              </div>
            ) : prizeReady ? (
              <div className="prize">
                <img src="/shield-and-win/zec.svg" alt="" />
                <div>
                  <b>
                    {board.prizeAmount} {board.prizeAsset}
                  </b>
                  <span>{board.prizeDestination}</span>
                </div>
              </div>
            ) : null}
            {campaignState === 'loading' || typeof board.drawsSoFar === 'number' ? (
              <div className="draws">
                <span className="k">Draws so far</span>
                <span className="big doto">
                  {(typeof board.drawsSoFar === 'number' ? board.drawsSoFar : 0).toLocaleString(
                    'en-US'
                  )}
                </span>
              </div>
            ) : null}
            {campaignState === 'loading' ? (
              <div className="tiles">
                <div className="tile">
                  <span>Odds per draw</span>
                  <span className="sk sk-tile-v" />
                </div>
                <div className="tile">
                  <span>Ends in</span>
                  <span className="sk sk-tile-v" />
                </div>
              </div>
            ) : campaignState === 'ready' && campaign ? (
              <div className="tiles">
                <div className="tile">
                  <span>{board.oddsLabel}</span>
                  <b className="doto">{board.oddsValue}</b>
                </div>
                <div className="tile">
                  <span>{board.endsLabel}</span>
                  <b className="doto">{board.endsValue}</b>
                </div>
              </div>
            ) : null}
            {campaignState === 'loading' || (campaignState === 'ready' && campaign) ? (
              <p className="indep">
                Every draw is independent. More draws don’t make the next one more likely to win.
              </p>
            ) : null}
          </aside>
        </section>
      </main>

      <footer className="foot">
        {prizeReady ? (
          <p>
            {board.prizeAmount} {board.prizeAsset}. The campaign ends when it is no longer active.
            Fees may apply.{' '}
            <button type="button" className="textlink" onClick={() => setRulesOpen(true)}>
              Rules
            </button>
          </p>
        ) : (
          <p>
            <button type="button" className="textlink" onClick={() => setRulesOpen(true)}>
              Rules
            </button>
          </p>
        )}
        <p>© 2026 Noir Privacy Terminal. All Rights Reserved.</p>
      </footer>

      <dialog
        ref={rulesRef}
        className="rules"
        aria-labelledby="rules-title"
        onClose={() => setRulesOpen(false)}
        onClick={event => closeOnBackdrop(event, () => setRulesOpen(false))}
      >
        <div className="rules-head">
          <h2 id="rules-title">Rules</h2>
          <button
            type="button"
            className="x"
            aria-label="Close"
            onClick={() => setRulesOpen(false)}
          >
            <CloseIcon />
          </button>
        </div>
        <div className="rules-scroll">
          {campaign && campaignState === 'ready' ? (
            <RulesCopy campaign={campaign} minimumValue={board.minimumValue} />
          ) : (
            <ul>
              <li>
                {campaignState === 'error' ? CAMPAIGN_ERROR : 'No campaign is available right now.'}
              </li>
            </ul>
          )}
        </div>
      </dialog>

      <dialog
        ref={entriesRef}
        className="rules entries-dialog"
        aria-labelledby="entries-title"
        onClose={() => setAllEntriesOpen(false)}
        onClick={event => closeOnBackdrop(event, () => setAllEntriesOpen(false))}
      >
        <div className="rules-head">
          <div>
            <h2 id="entries-title">Your entries</h2>
            <span className="entries-count">{entryTotal} entries</span>
          </div>
          <div className="entries-tools">
            <EntriesRefreshButton
              busy={entryRefreshBusy}
              cooling={entryRefreshCooling}
              blocked={allEntriesLoading || claimBusy}
              onRefresh={() => void onRefreshEntry()}
            />
            <button
              type="button"
              className="x"
              aria-label="Close"
              onClick={() => setAllEntriesOpen(false)}
            >
              <CloseIcon />
            </button>
          </div>
        </div>
        <div className="rules-scroll">
          {allEntriesLoading ? (
            <p className="entries-message" role="status">
              Loading all entries…
            </p>
          ) : null}
          {allEntriesError ? (
            <div className="entries-message" role="alert">
              Could not load all entries.{' '}
              <button
                type="button"
                className="textlink"
                onClick={() => setAllEntriesRetry(value => value + 1)}
              >
                Retry
              </button>
            </div>
          ) : null}
          {orderedEntries.length > 0 ? (
            <ul className="entries-list">{orderedEntries.map(renderEntry)}</ul>
          ) : !allEntriesLoading ? (
            <p className="entries-message">No entries yet.</p>
          ) : null}
        </div>
      </dialog>

      <dialog
        ref={claimRef}
        className="rules claim"
        aria-labelledby="claim-title"
        onCancel={event => {
          if (claimBusy) event.preventDefault()
        }}
        onClose={() => setClaimOpen(false)}
        onClick={event => {
          if (!claimBusy) closeOnBackdrop(event, () => setClaimOpen(false))
        }}
      >
        {claimTarget && payoutAddress ? (
          <>
            <div className="rules-head">
              <h2 id="claim-title">Claim {rewardText(claimTarget)}</h2>
            </div>
            <div className="rules-scroll">
              <div className="claim-body">
                <div className="claim-prize">
                  <img src="/shield-and-win/zec.svg" alt="" />
                  <span className="doto">{rewardText(claimTarget)}</span>
                  <small>
                    Network fee paid by Noir. You receive the full {rewardText(claimTarget)}.
                  </small>
                </div>
                <p className="claim-label">Send to</p>
                <div className="claim-addr">
                  <img src="/shield-and-win/zec.svg" alt="" />
                  <div>
                    <b>Zcash · Transparent</b>
                    <small aria-label={payoutAddress}>{shortPayoutAddress(payoutAddress)}</small>
                  </div>
                  <span className="claim-radio" aria-hidden="true" />
                </div>
                <p className="claim-fine">
                  We ask for this address only because you won, and we don&apos;t link it to your
                  Public or Private accounts.
                </p>
                {claimError ? (
                  <p className="form-error" id="shield-win-claim-error">
                    {claimError}
                  </p>
                ) : null}
                <div className="claim-actions">
                  <button
                    type="button"
                    className="btn primary"
                    disabled={claimBusy || !address}
                    aria-describedby={claimError ? 'shield-win-claim-error' : undefined}
                    onClick={() => void onSign()}
                  >
                    Claim {rewardText(claimTarget)}
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={claimBusy}
                    onClick={() => setClaimOpen(false)}
                  >
                    Later
                  </button>
                </div>
              </div>
            </div>
          </>
        ) : null}
      </dialog>
    </div>
  )
}
