import { useEffect, useRef, useState, type MouseEvent } from 'react'
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
import { assetInfo, getAssetLabels, type ShieldWinAsset } from '../shield-and-win/asset-label'
import {
  clearCachedCampaign,
  readCachedCampaign,
  writeCachedCampaign
} from '../shield-and-win/campaign-cache'
import { claimMessage, isTransparentZcashAddress, utf8ToHex } from '../shield-and-win/claim'
import {
  CAMPAIGN_POLL_INTERVAL_MS,
  ENTRIES_LIST_POLL_INTERVAL_MS,
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
  formatEntryUsd,
  latestEntry,
  rewardTransactionUrl,
  sortedEntries,
  unclaimedWins,
  type EntryViewState
} from '../shield-and-win/view'
import {
  connectTransparentAddress,
  detectNoirWallet,
  detectZcashProvider,
  disconnectZcash,
  isUnsupportedZcashAccount,
  readAccounts,
  readConnectedTransparentAddress,
  requestAccount,
  revokeAccount,
  signClaim,
  subscribeAccounts,
  walletErrorMessage,
  type NoirEthereumProvider
} from '../shield-and-win/wallet'
import { Tooltip } from '../components/Tooltip'
import '../tailwind.css'

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
const NO_ZCASH_ADDRESS = 'This account has no Zcash address. Enter a transparent address.'
const INVALID_TRANSPARENT_ADDRESS = 'Enter a valid transparent Zcash address.'

type PayoutSource = 'wallet' | 'manual'

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

function completedLabel(timestamp: number): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(timestamp))
}

function EntryColumns({ dialog = false }: { dialog?: boolean }) {
  return (
    <div
      className={
        dialog
          ? 'entries-dialog grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_160px_50px] items-center gap-4 max-[760px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] shrink-0 border-b border-[#303333] bg-[#141414] px-[26px] py-2.5 text-[11px] leading-[18px] font-medium text-[#a1a5a5] max-[760px]:[&>span:last-child]:col-span-full'
          : 'entries-not-dialog grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_160px_50px] items-center gap-4 max-[760px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] shrink-0 border-b border-[#303333] px-6 py-2.5 text-[11px] leading-[18px] font-medium text-[#a1a5a5] max-[760px]:[&>span:last-child]:col-span-full'
      }
    >
      <span>Asset</span>
      <span>USD value</span>
      <span>Completed</span>
    </div>
  )
}

function AssetMark({ asset }: { asset: ShieldWinAsset }) {
  const [failedToken, setFailedToken] = useState<string | null>(null)
  const [failedChain, setFailedChain] = useState<string | null>(null)
  const tokenUrl = asset.tokenIconUrl
  const chainUrl = asset.chainIconUrl
  const letter = asset.symbol.trim().charAt(0).toUpperCase() || '?'
  return (
    <span className="relative size-6 shrink-0">
      <span
        className="relative block size-6 overflow-hidden rounded-full bg-[#34343f] text-center text-[10px] leading-6 font-bold text-white/80"
        aria-hidden="true"
      >
        {letter}
        {tokenUrl && failedToken !== tokenUrl ? (
          <img
            className="absolute inset-0 size-6 rounded-full object-cover"
            src={tokenUrl}
            alt=""
            onError={() => {
              if (tokenUrl) setFailedToken(tokenUrl)
            }}
          />
        ) : null}
      </span>
      {chainUrl && failedChain !== chainUrl ? (
        <img
          className="absolute top-3.5 left-3.5 size-2.5 rounded-[20%] object-cover"
          src={chainUrl}
          alt=""
          onError={() => {
            if (chainUrl) setFailedChain(chainUrl)
          }}
        />
      ) : null}
    </span>
  )
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
  assetLabels: ReadonlyMap<string, ShieldWinAsset>
  onClaim: (entry: ShieldWinEntry) => void
}) {
  const view = entryView(entry)
  const copy = entryCopy(view, entry)
  const transactionUrl = rewardTransactionUrl(entry)
  const asset = assetInfo(entry.destination_asset, assetLabels)
  return (
    <li
      className={
        view === 'won' || view === 'claiming' || view === 'sending' || view === 'claimed'
          ? 'flex min-w-0 flex-col gap-2.5 rounded-lg border border-[#303333] bg-[#24271f] px-5 py-4'
          : 'flex min-w-0 flex-col gap-2.5 rounded-lg border border-[#303333] bg-[#232525] px-5 py-4'
      }
    >
      <div className="entries-row grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_160px_50px] items-center gap-4 max-[760px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="flex h-8 min-w-0 items-center gap-2">
          <AssetMark asset={asset} />
          <div className="min-w-0">
            <b
              className="block truncate text-xs leading-[18px] font-medium text-[#f2f4f3]"
              title={entry.destination_asset}
            >
              {asset.symbol}
            </b>
            {asset.network ? (
              <span className="block truncate text-[10px] leading-[14px] font-normal text-[#a1a5a5]">
                {asset.network}
              </span>
            ) : null}
          </div>
        </div>
        <b className="block truncate text-sm leading-[18px] font-medium text-[#f2f4f3]">
          {formatEntryUsd(entry.usd_value)}
        </b>
        <b className="block truncate text-xs leading-[18px] font-normal text-[#f2f4f3] max-[760px]:col-span-full">
          {completedLabel(entry.shield_completed_at)}
        </b>
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-[11px] leading-[18px] text-[#a1a5a5]">
            {view === 'notwon' ? 'Draw result' : 'Reward status'}
          </span>
          <span
            className={
              view === 'claimed'
                ? 'inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-[11px] leading-[18px] font-medium bg-[#3b3420] text-[#f0cb45]'
                : view === 'won' || view === 'claiming' || view === 'sending'
                  ? 'inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-[11px] leading-[18px] font-medium bg-[rgba(255,204,0,0.12)] text-[#ffcc00]'
                  : view === 'failed'
                    ? 'inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-[11px] leading-[18px] font-medium bg-[rgba(255,161,0,0.12)] text-[#ffc04d]'
                    : 'inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-[11px] leading-[18px] font-medium bg-[#2b2e2e] text-[#c4c8c7]'
            }
          >
            {copy.title}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          {view === 'won' ? (
            <small className="text-xs text-[#ffcc00]">{rewardText(entry)}</small>
          ) : null}
          {view === 'won' && !phone ? (
            <button
              type="button"
              className="inline-flex cursor-pointer items-center justify-center gap-2.5 border font-['DM_Sans',system-ui,sans-serif] leading-none font-medium no-underline transition-[background-color,border-color] duration-150 disabled:cursor-default disabled:opacity-[0.55] [&_svg]:block [&_svg]:size-[18px] [&_svg]:shrink-0 h-[28px] shrink-0 rounded border-transparent bg-[#00d18a] px-3.5 text-[13px] text-black hover:bg-[#1ee3a0] hover:text-black"
              disabled={claimBusy}
              onClick={() => onClaim(entry)}
            >
              Claim
            </button>
          ) : view === 'claiming' || view === 'sending' ? (
            <span className="flex gap-1.5" aria-hidden="true">
              {Array.from({ length: 8 }, (_, index) => (
                <i
                  key={index}
                  className="size-1.5 animate-shield-run rounded-full bg-white/14 motion-reduce:animate-none"
                  style={{ animationDelay: `${index * 120}ms` }}
                />
              ))}
            </span>
          ) : view === 'failed' ? (
            <SupportLink />
          ) : transactionUrl ? (
            <a
              className="inline-flex w-11 shrink-0 items-center justify-end gap-1 text-[11px] leading-[18px] font-medium whitespace-nowrap !text-[#1ee3a0] no-underline hover:text-white hover:underline hover:underline-offset-[3px]"
              href={transactionUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="View payout transaction on Blockchair"
            >
              Tx <span aria-hidden="true">↗</span>
            </a>
          ) : null}
        </div>
      </div>
      {/* {copy.body ? <p className="text-[11px] leading-[18px] text-[#bbc1bc]">{copy.body}</p> : null} */}
    </li>
  )
}

function SupportLink() {
  return (
    <a
      className="cursor-pointer border-0 bg-transparent p-0 font-[inherit] text-[length:inherit] leading-[inherit] text-[#bcbcc8] underline decoration-white/30 underline-offset-[3px] hover:text-white"
      href={SUPPORT_URL}
      target="_blank"
      rel="noopener noreferrer"
    >
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

function selectedTransparentAddress(
  source: PayoutSource,
  walletAddress: string | null,
  manualAddress: string
): string | null {
  if (source === 'wallet') return walletAddress
  const trimmed = manualAddress.trim()
  return isTransparentZcashAddress(trimmed) ? trimmed : null
}

function destinationRowClass(selected: boolean): string {
  return selected
    ? 'flex w-full cursor-pointer items-center gap-2.5 rounded-xl border border-[rgba(61,255,190,0.45)] bg-[#1c1c22] px-3 py-2.5 text-left'
    : 'flex w-full cursor-pointer items-center gap-2.5 rounded-xl border border-[#3a3a3a] bg-[#1c1c22] px-3 py-2.5 text-left'
}

function DestinationRadio({ selected }: { selected: boolean }) {
  return (
    <span
      className={
        selected
          ? "grid size-[18px] shrink-0 place-items-center rounded-full border border-[#3dffbe] after:size-[9px] after:rounded-full after:bg-[#3dffbe] after:content-['']"
          : 'size-[18px] shrink-0 rounded-full border border-[#6a6a6a]'
      }
      aria-hidden="true"
    />
  )
}

function DisconnectIcon(props: { className?: string; color?: string }) {
  const { className, color } = props
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke={color || 'currentColor'}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  )
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      className={
        spinning
          ? 'size-4 animate-spin [animation-duration:700ms] motion-reduce:animate-none'
          : 'size-4'
      }
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
      className={
        busy
          ? 'inline-flex size-7 cursor-default items-center justify-center rounded-lg border-0 bg-transparent p-0 text-[#8b8e93] [&_svg]:size-4'
          : 'inline-flex size-7 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent p-0 text-[#8b8e93] enabled:hover:text-white disabled:cursor-default disabled:opacity-[0.35] [&_svg]:size-4'
      }
      aria-label="Refresh your entries"
      title={cooling ? 'Available again in one minute' : 'Refresh entries'}
      aria-busy={busy}
      disabled={busy || cooling || blocked}
      onClick={onRefresh}
    >
      <RefreshIcon spinning={busy} />
    </button>
  )
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
          <b>How to join:</b> install Noir Wallet, create or import a wallet, then make a shield
          transfer of <b>{minimum} or more</b> into <b>NEAR Confidential</b> from your Public or
          Incognito account (in the wallet: Shield → NEAR Confidential). Use the latest version of
          Noir Wallet.
        </li>
        <li>
          We count the USD value credited after network, bridge and protocol fees. Smaller transfers
          can&apos;t be added together.
        </li>
        <li>
          Each eligible transfer gets one automatic draw as soon as it&apos;s credited, at{' '}
          <strong>1 in 444</strong> (about 0.225%). That doesn&apos;t mean someone wins every 444
          draws.
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
          so the full {prize} arrives.
        </li>
        <li>
          We never ask for your seed phrase or keys, and never publish your balances, addresses or
          the path of your funds. &quot;Draws so far&quot; is a total count only.
        </li>
        <li>
          {/*Entries per wallet, regions and age limits <Tbc />. */}Fees are shown before you sign.
          Winning isn&apos;t guaranteed.
        </li>
      </ul>
      <p className="border-t border-[#232323] px-[22px] pt-3 pb-[22px] text-[13px] text-[#8b8e93]">
        zknoir.com reserves the right to interpret this campaign.
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
  const [walletPayout, setWalletPayout] = useState<string | null>(null)
  const [manualPayout, setManualPayout] = useState('')
  const [payoutSource, setPayoutSource] = useState<PayoutSource>('wallet')
  const [claimError, setClaimError] = useState<string | null>(null)
  const [claimBusy, setClaimBusy] = useState(false)
  const [connectBusy, setConnectBusy] = useState(false)
  const [liveText, setLiveText] = useState('')
  const [entryRefreshBusy, setEntryRefreshBusy] = useState(false)
  const [entryRefreshCooling, setEntryRefreshCooling] = useState(false)
  const [assetLabels, setAssetLabels] = useState<ReadonlyMap<string, ShieldWinAsset>>(new Map())

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
  const manualPayoutRef = useRef<HTMLInputElement>(null)
  const claimSession = useRef(0)
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
    setWalletPayout(null)
    setManualPayout('')
    setPayoutSource('wallet')
    setClaimError(null)
    claimSession.current += 1
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
    document.title = `Go Shield, Win ${reward} · Noir Wallet`
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
    let stopped = false
    let controller = new AbortController()
    const refresh = async () => {
      controller.abort()
      controller = new AbortController()
      const { signal } = controller
      try {
        const list = await getCampaigns(signal)
        if (stopped) return
        const next = selectCampaign(list)
        const current = campaignRef.current
        const unchanged =
          current === next ||
          (current !== null && next !== null && JSON.stringify(current) === JSON.stringify(next))
        if (!unchanged) setCampaign(next)
        setCampaignState('ready')
        if (next) writeCachedCampaign(next)
        else clearCachedCampaign()
      } catch (error) {
        if (stopped || isAbortError(error)) return
        if (campaignRef.current) return
        setCampaign(null)
        setCampaignState('error')
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), CAMPAIGN_POLL_INTERVAL_MS)
    return () => {
      stopped = true
      controller.abort()
      window.clearInterval(timer)
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
    if (!address || !campaign) return
    let stopped = false
    let controller = new AbortController()
    const refreshEntries = () => {
      controller.abort()
      controller = new AbortController()
      void loadWalletData(controller.signal).catch(error => {
        if (stopped || isAbortError(error)) return
      })
    }
    const timer = window.setInterval(refreshEntries, ENTRIES_LIST_POLL_INTERVAL_MS)
    return () => {
      stopped = true
      controller.abort()
      window.clearInterval(timer)
    }
    // loadWalletData reads the current wallet and campaign through refs.
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

  const assetKey = [...new Set([...entries, ...wins].map(entry => entry.destination_asset))]
    .filter(assetId => assetId.length > 0)
    .sort()
    .join('\n')
  useEffect(() => {
    setAssetLabels(new Map())
    if (!address || !entriesReady || !assetKey) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 8_000)
    void getAssetLabels(controller.signal, fetch, assetKey.split('\n')).then(
      labels => {
        if (!controller.signal.aborted) setAssetLabels(labels)
      },
      () => undefined
    )
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [address, entriesReady, assetKey])

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
      const zcash = detectZcashProvider()
      if (zcash) {
        try {
          await disconnectZcash(zcash)
        } catch {
          // Zcash may already be disconnected. Logout still completes.
        }
      }
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
    const session = ++claimSession.current
    setNotice(null)
    setNoticeWarn(false)
    setClaimTarget(entry)
    setWalletPayout(null)
    setManualPayout('')
    setPayoutSource('wallet')
    setClaimError(null)
    setClaimOpen(true)
    const zcash = detectZcashProvider()
    if (!zcash) return
    try {
      const payout = await readConnectedTransparentAddress(zcash)
      if (!mountedRef.current || claimSession.current !== session || !payout) return
      setWalletPayout(payout)
    } catch {
      // A silent lookup must not block the dialog.
    }
  }

  function selectManualPayout() {
    setPayoutSource('manual')
    manualPayoutRef.current?.focus()
  }

  async function onDisconnectZcash() {
    if (claimBusy) return
    const session = ++claimSession.current
    const zcash = detectZcashProvider()
    if (zcash) {
      try {
        await disconnectZcash(zcash)
      } catch (error) {
        if (!mountedRef.current || claimSession.current !== session || isAbortError(error)) return
        setClaimError(walletErrorMessage(error))
        return
      }
    }
    if (!mountedRef.current || claimSession.current !== session) return
    setClaimError(null)
    setWalletPayout(null)
  }

  async function onConnectZcash() {
    if (claimBusy) return
    const zcash = detectZcashProvider()
    if (!zcash) {
      setClaimError('Install Noir Wallet in desktop Chrome, then refresh this page.')
      return
    }
    const session = claimSession.current
    setClaimBusy(true)
    setClaimError(null)
    try {
      const payout = await connectTransparentAddress(zcash)
      if (!mountedRef.current || claimSession.current !== session) return
      setWalletPayout(payout)
      setPayoutSource('wallet')
    } catch (error) {
      if (!mountedRef.current || claimSession.current !== session || isAbortError(error)) return
      if (isUnsupportedZcashAccount(error)) {
        setPayoutSource('manual')
        setClaimError(NO_ZCASH_ADDRESS)
        window.setTimeout(() => {
          if (mountedRef.current && claimSession.current === session) {
            manualPayoutRef.current?.focus()
          }
        }, 0)
        return
      }
      setClaimError(walletErrorMessage(error))
    } finally {
      if (mountedRef.current && claimSession.current === session) setClaimBusy(false)
    }
  }

  async function onSign() {
    const payoutAddress = selectedTransparentAddress(payoutSource, walletPayout, manualPayout)
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
  const walletLinkOpen = campaignState === 'loading' || campaign !== null
  const showInstall = !phone && walletReady && !provider && claimable.length === 0 && walletLinkOpen
  const showTry =
    !phone &&
    ((claimable.length === 0 && campaignOpen && (accountPending || Boolean(provider))) ||
      (claimable.length > 0 && Boolean(provider) && board.canJoin))
  const showConnect =
    !phone &&
    !address &&
    claimable.length === 0 &&
    walletLinkOpen &&
    !showInstall &&
    (connectLoading || Boolean(provider && accountReady))
  const showExplore =
    !phone &&
    campaignState === 'ready' &&
    !board.canJoin &&
    claimable.length === 0 &&
    (!address || entriesReady)
  const historicalWins = wins.filter(win => win.campaign_id !== campaign?.id)
  const manualTrimmed = manualPayout.trim()
  const manualInvalid =
    payoutSource === 'manual' &&
    manualTrimmed.length > 0 &&
    !isTransparentZcashAddress(manualTrimmed)
  const walletSelected = payoutSource === 'wallet'
  const selectedPayout = selectedTransparentAddress(payoutSource, walletPayout, manualPayout)
  const claimAction = selectedPayout ? 'claim' : walletSelected ? 'connect' : 'enter'

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
    <div className="flex min-h-screen min-h-dvh flex-col overflow-x-hidden bg-black font-['DM_Sans',system-ui,sans-serif] text-base leading-[1.55] text-white antialiased scheme-dark [&_img]:block [&_img]:max-w-full **:focus-visible:outline-2 **:focus-visible:outline-offset-[3px] **:focus-visible:outline-[#3dffbe]">
      <header className="flex h-[72px] items-center justify-between gap-3 px-[clamp(16px,4vw,64px)] max-[760px]:h-16">
        <a
          className="flex min-w-0 items-center gap-2.5 text-xl font-medium text-white no-underline"
          href="/"
        >
          <img
            className="size-7 shrink-0 rounded-full object-cover"
            src="/shield-and-win/logo.jpg"
            alt=""
          />
          <span className="truncate">Noir Wallet</span>
        </a>
        <div className="flex shrink-0 items-center gap-2">
          <a
            className="cursor-pointer inline-flex h-10 items-center rounded border border-[#3a3a3a] bg-black px-4 text-[15px] font-medium text-white no-underline hover:border-[#666]"
            href="/"
          >
            Home
          </a>
          <button
            type="button"
            className="cursor-pointer inline-flex h-10 items-center rounded border border-[#3a3a3a] bg-black px-4 text-[15px] font-medium text-white no-underline hover:border-[#666]"
            onClick={() => setRulesOpen(true)}
          >
            Rules
          </button>
          {address ? (
            <>
              <span
                className="text-sm leading-none font-medium whitespace-nowrap text-[#bcbcc8]"
                title={address}
              >
                {shortAddress(address)}
              </span>
              <button
                type="button"
                className="cursor-pointer grid size-10 shrink-0 place-items-center rounded border border-[#3a3a3a] bg-black text-white hover:border-[#666] [&_svg]:size-[18px]"
                aria-label="Disconnect"
                onClick={() => void onDisconnect()}
              >
                <DisconnectIcon color="#FF5E59" />
              </button>
            </>
          ) : null}
        </div>
      </header>

      <main className="flex-1 px-[clamp(16px,4vw,64px)] max-[760px]:px-3">
        <section
          className="relative isolate mx-auto grid max-w-[1360px] grid-cols-[minmax(0,1.05fr)_minmax(380px,0.95fr)] items-center gap-[clamp(32px,5vw,80px)] overflow-hidden rounded-[30px] border border-[#262626] bg-[linear-gradient(155deg,#1c1c1c_0%,#141414_55%,#0e0e10_100%)] p-[clamp(36px,5vw,80px)] max-[1040px]:grid-cols-1 max-[760px]:gap-7 max-[760px]:rounded-3xl max-[760px]:px-[18px] max-[760px]:pt-7 max-[760px]:pb-[22px]"
          aria-labelledby="title"
          aria-busy={campaignState === 'loading'}
        >
          <div
            className="pointer-events-none absolute inset-0 z-[-1] bg-[radial-gradient(circle,rgba(61,255,190,0.32)_1.4px,transparent_2px)] [background-size:18px_18px] [mask-image:radial-gradient(60%_75%_at_85%_100%,#000_0%,rgba(0,0,0,0.4)_45%,transparent_75%)] [-webkit-mask-image:radial-gradient(60%_75%_at_85%_100%,#000_0%,rgba(0,0,0,0.4)_45%,transparent_75%)]"
            aria-hidden="true"
          />
          <div>
            {campaignState === 'loading' ? (
              <div
                className="block animate-shield-sk bg-white/12 motion-reduce:animate-none h-[18px] w-[148px] rounded-lg max-[760px]:h-[15px]"
                aria-hidden="true"
              />
            ) : (
              <p className="font-['Doto',ui-monospace,monospace] text-lg leading-none font-normal tracking-[0.06em] text-[#3dffbe] uppercase max-[760px]:text-[15px]">
                {campaign?.name || 'Shield & Win'}
              </p>
            )}
            {showFixedWin ? (
              <h1
                id="title"
                className="pt-[clamp(18px,3vh,28px)] text-[clamp(48px,min(6vw,10vh),96px)] leading-[1.02] font-semibold tracking-[-0.035em] max-[760px]:text-[clamp(44px,13vw,60px)]"
              >
                Go Shield,
                <br />
                {'Win'}
                {prizeReady ? (
                  <>
                    {' '}
                    <span
                      className={
                        campaignStart.reveal
                          ? 'text-[#3dffbe] animate-shield-fade motion-reduce:animate-none'
                          : 'text-[#3dffbe]'
                      }
                    >
                      {board.prizeAmount}
                      {'\u00A0'}
                      {board.prizeAsset}
                    </span>
                  </>
                ) : null}
              </h1>
            ) : (
              <h1
                id="title"
                className="pt-[clamp(18px,3vh,28px)] text-[clamp(48px,min(6vw,10vh),96px)] leading-[1.02] font-semibold tracking-[-0.035em] max-[760px]:text-[clamp(44px,13vw,60px)]"
              >
                Shield & Win
              </h1>
            )}
            {campaignState === 'error' ? (
              <p className="pt-[clamp(18px,3vh,28px)] max-w-[31em] text-[clamp(17px,1.4vw,21px)] leading-[1.55] text-[#bcbcc8]">
                {CAMPAIGN_ERROR}
              </p>
            ) : campaignState === 'ready' && !prizeReady ? (
              <p className="pt-[clamp(18px,3vh,28px)] max-w-[31em] text-[clamp(17px,1.4vw,21px)] leading-[1.55] text-[#bcbcc8]">
                No campaign is available right now.
              </p>
            ) : (
              <p className="pt-[clamp(18px,3vh,28px)] max-w-[31em] text-[clamp(17px,1.4vw,21px)] leading-[1.55] text-[#bcbcc8]">
                {'Try a shield transfer'}
                {board.minimumValue ? (
                  <span
                    className={
                      campaignStart.reveal
                        ? 'animate-shield-fade motion-reduce:animate-none'
                        : undefined
                    }
                  >
                    {` (min ${board.minimumValue})`}
                  </span>
                ) : null}
                {' and get an instant draw.'}
              </p>
            )}

            <div className="mt-[clamp(18px,3vh,30px)] flex min-h-14 flex-wrap gap-3.5 max-[760px]:flex-col">
              {actionsReady && phone ? (
                <button
                  type="button"
                  className="inline-flex cursor-pointer items-center justify-center gap-2.5 border font-['DM_Sans',system-ui,sans-serif] leading-none font-medium no-underline transition-[background-color,border-color] duration-150 disabled:cursor-default disabled:opacity-[0.55] [&_svg]:block [&_svg]:size-[18px] [&_svg]:shrink-0 h-14 rounded px-7 text-[17px] max-[760px]:w-full border-transparent bg-[#00d18a] text-black hover:bg-[#1ee3a0] hover:text-black"
                  onClick={() => void sharePage()}
                >
                  {canShare ? 'Send link to your computer' : copied ? 'Link copied' : 'Copy link'}
                </button>
              ) : null}
              {actionsReady && !phone && claimable.length > 0 ? (
                <button
                  type="button"
                  className="inline-flex cursor-pointer items-center justify-center gap-2.5 border font-['DM_Sans',system-ui,sans-serif] leading-none font-medium no-underline transition-[background-color,border-color] duration-150 disabled:cursor-default disabled:opacity-[0.55] [&_svg]:block [&_svg]:size-[18px] [&_svg]:shrink-0 h-14 rounded px-7 text-[17px] max-[760px]:w-full border-transparent bg-[#00d18a] text-black hover:bg-[#1ee3a0] hover:text-black"
                  disabled={claimBusy}
                  onClick={() => void openClaim(claimable[0])}
                >
                  Claim
                </button>
              ) : null}
              {showInstall ? (
                <a
                  className="inline-flex cursor-pointer items-center justify-center gap-2.5 border font-['DM_Sans',system-ui,sans-serif] leading-none font-medium no-underline transition-[background-color,border-color] duration-150 disabled:cursor-default disabled:opacity-[0.55] [&_svg]:block [&_svg]:size-[18px] [&_svg]:shrink-0 h-14 rounded px-7 text-[17px] max-[760px]:w-full border-transparent bg-[#00d18a] text-black hover:bg-[#1ee3a0] hover:text-black"
                  href={CHROME_STORE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <DownloadIcon />
                  Install Noir Wallet
                </a>
              ) : null}
              {showTry ? (
                <Tooltip
                  className="max-[760px]:flex max-[760px]:w-full"
                  content={TOOLBAR_HINT}
                  side="top"
                >
                  <button
                    type="button"
                    className={
                      claimable.length > 0
                        ? "inline-flex cursor-default items-center justify-center gap-2.5 border font-['DM_Sans',system-ui,sans-serif] leading-none font-medium no-underline transition-[background-color,border-color] duration-150 disabled:cursor-default disabled:opacity-[0.55] [&_svg]:block [&_svg]:size-[18px] [&_svg]:shrink-0 h-14 rounded px-7 text-[17px] max-[760px]:w-full border-[#3a3a3a] bg-[#0b0b0b] text-white hover:border-[#6a6a6a] hover:text-white"
                        : "inline-flex cursor-default items-center justify-center gap-2.5 border font-['DM_Sans',system-ui,sans-serif] leading-none font-medium no-underline transition-[background-color,border-color] duration-150 disabled:cursor-default disabled:opacity-[0.55] [&_svg]:block [&_svg]:size-[18px] [&_svg]:shrink-0 h-14 rounded px-7 text-[17px] max-[760px]:w-full border-transparent bg-[#00d18a] text-black hover:bg-[#1ee3a0] hover:text-black"
                    }
                    onClick={onParticipate}
                  >
                    Try a shield transfer
                  </button>
                </Tooltip>
              ) : null}
              {showExplore ? (
                <a
                  className="inline-flex cursor-pointer items-center justify-center gap-2.5 border font-['DM_Sans',system-ui,sans-serif] leading-none font-medium no-underline transition-[background-color,border-color] duration-150 disabled:cursor-default disabled:opacity-[0.55] [&_svg]:block [&_svg]:size-[18px] [&_svg]:shrink-0 h-14 rounded px-7 text-[17px] max-[760px]:w-full border-[#3a3a3a] bg-[#0b0b0b] text-white hover:border-[#6a6a6a] hover:text-white"
                  href="/"
                >
                  Explore Noir Wallet
                </a>
              ) : null}
              {showConnect ? (
                connectLoading ? (
                  <button
                    type="button"
                    className="inline-flex cursor-pointer items-center justify-center gap-2.5 border font-['DM_Sans',system-ui,sans-serif] leading-none font-medium no-underline transition-[background-color,border-color] duration-150 disabled:cursor-default disabled:opacity-[0.55] [&_svg]:block [&_svg]:size-[18px] [&_svg]:shrink-0 h-14 rounded px-7 text-[17px] max-[760px]:w-full border-[#3a3a3a] bg-[#0b0b0b] text-white hover:border-[#6a6a6a] hover:text-white"
                    disabled
                    aria-busy="true"
                  >
                    <span
                      className="size-4 animate-spin rounded-full border-2 border-white/35 border-t-white [animation-duration:700ms] motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                    Connect Wallet
                  </button>
                ) : (
                  <Tooltip
                    className="max-[760px]:flex max-[760px]:w-full"
                    content={
                      <img
                        src={PUBLIC_TOOLTIP_SRC}
                        alt="Select the Public account in Noir Wallet"
                      />
                    }
                    side="top"
                    variant="plain"
                  >
                    <button
                      type="button"
                      className="inline-flex cursor-pointer items-center justify-center gap-2.5 border font-['DM_Sans',system-ui,sans-serif] leading-none font-medium no-underline transition-[background-color,border-color] duration-150 disabled:cursor-default disabled:opacity-[0.55] [&_svg]:block [&_svg]:size-[18px] [&_svg]:shrink-0 h-14 rounded px-7 text-[17px] max-[760px]:w-full border-[#3a3a3a] bg-[#0b0b0b] text-white hover:border-[#6a6a6a] hover:text-white"
                      onClick={() => void onConnect()}
                    >
                      Connect Wallet
                    </button>
                  </Tooltip>
                )
              ) : null}
            </div>
            <p
              className={
                hintWarn
                  ? 'pt-3 max-w-[36em] text-sm leading-normal text-[#ffc04d] empty:hidden'
                  : 'pt-3 max-w-[36em] text-sm leading-normal text-[#8b8e93] empty:hidden'
              }
              aria-live="polite"
            >
              {hint}
            </p>

            {showEntry ? (
              <section
                className="mt-[22px] w-full overflow-hidden rounded-xl border border-[#303333] bg-[#1d1e1e]"
                aria-label="Your entries"
              >
                <div className="flex items-center justify-between gap-3 border-b border-[#303333] bg-[#202222] px-5 py-4">
                  <h2 className="text-base leading-6 font-semibold text-[#f2f4f3]">Your entries</h2>
                  <div className="flex shrink-0 items-center gap-2">
                    <EntriesRefreshButton
                      busy={entryRefreshBusy}
                      cooling={entryRefreshCooling}
                      blocked={allEntriesLoading || claimBusy}
                      onRefresh={() => void onRefreshEntry()}
                    />
                    <button
                      type="button"
                      className="cursor-pointer inline-flex items-center gap-1.5 text-xs leading-[18px] font-medium whitespace-nowrap text-[#52e4b3] hover:text-white"
                      onClick={() => setAllEntriesOpen(true)}
                    >
                      View all <span aria-hidden="true">→</span>
                    </button>
                  </div>
                </div>
                {orderedEntries.length > 0 ? (
                  <>
                    <EntryColumns />
                    <div className="card-entries pt-1 pb-1 px-1 w-full">
                      <ul className="m-0 flex list-none flex-col gap-1 p-0">
                        {orderedEntries.slice(0, 3).map(renderEntry)}
                      </ul>
                    </div>
                  </>
                ) : (
                  <div className="px-5 py-4 text-[13px] text-[#bcbcc8]">
                    <p>{copy.body}</p>
                  </div>
                )}
              </section>
            ) : null}
            <p className="sr-only" aria-live="polite">
              {liveText}
            </p>

            {historicalWins.length > 0 ? (
              <section
                className="mt-4 w-full overflow-hidden rounded-xl border border-[#303333] bg-[#1d1e1e]"
                aria-label="Your wins"
              >
                <h2 className="border-b border-[#303333] px-5 py-4 text-base leading-6 font-semibold text-[#f2f4f3]">
                  Earlier wins
                </h2>
                <EntryColumns />
                <div className="earlier-card-entries pt-1 pb-1 px-1 w-full">
                  <ul className="m-0 flex list-none flex-col gap-1 p-0">
                    {historicalWins.map(renderEntry)}
                  </ul>
                </div>
              </section>
            ) : null}

            <p className="mt-[clamp(22px,3.5vh,34px)] pt-2 flex items-center gap-2.5 text-[15px] text-[#a7a9ad] [&_svg]:size-5 [&_svg]:shrink-0 [&_svg]:text-[#3dffbe]">
              <AssureIcon />
              Your shield transfer lands in your own shield balance. The money stays yours.
            </p>
          </div>

          <aside
            className="relative min-w-0 rounded-3xl border border-[rgba(61,255,190,0.3)] bg-[linear-gradient(180deg,rgba(20,22,30,0.94),rgba(13,14,20,0.97))] p-[clamp(22px,2.4vw,32px)] shadow-[0_0_0_4px_rgba(61,255,190,0.04),0_30px_80px_rgba(0,0,0,0.5)] max-[1040px]:max-w-[560px] max-[760px]:px-[18px] max-[760px]:py-5"
            aria-label="Campaign progress"
          >
            <div className="flex items-center justify-between gap-3 text-[15px] text-[#a7a9ad]">
              {campaignState === 'loading' ? (
                <>
                  <span className="block animate-shield-sk bg-white/12 motion-reduce:animate-none h-[34px] w-[196px] rounded-[17px] max-[760px]:h-8" />
                  <span className="block animate-shield-sk bg-white/12 motion-reduce:animate-none h-[15px] w-[112px] rounded-lg max-[760px]:hidden" />
                </>
              ) : (
                <>
                  <span
                    className={
                      board.state === 'live'
                        ? 'inline-flex h-[34px] items-center gap-2 rounded-[17px] border border-[rgba(61,255,190,0.35)] bg-[rgba(0,209,138,0.1)] px-3.5 text-[15px] font-medium whitespace-nowrap text-[#3dffbe] max-[760px]:h-8 max-[760px]:px-3 max-[760px]:text-sm'
                        : 'inline-flex h-[34px] items-center gap-2 rounded-[17px] border border-[#3a3a3a] bg-white/5 px-3.5 text-[15px] font-medium whitespace-nowrap text-[#a7a9ad] max-[760px]:h-8 max-[760px]:px-3 max-[760px]:text-sm'
                    }
                  >
                    <i
                      className={
                        board.state === 'live'
                          ? 'size-2 rounded-full bg-[#3dffbe] shadow-[0_0_8px_#3dffbe]'
                          : 'size-2 rounded-full bg-[#666]'
                      }
                    />
                    <span>{board.pill}</span>
                  </span>
                  {board.winnerNote ? (
                    <span className="max-[760px]:hidden">{board.winnerNote}</span>
                  ) : null}
                </>
              )}
            </div>
            {campaignState === 'loading' ? (
              <div className="mt-[clamp(20px,3vh,30px)] flex items-center gap-[clamp(14px,1.6vw,22px)] border-b border-[#262630] pb-[clamp(20px,3vh,28px)]">
                <div className="block animate-shield-sk bg-white/12 motion-reduce:animate-none size-[clamp(64px,6.5vw,96px)] shrink-0 rounded-full" />
                <div className="w-[240px] max-w-[calc(100%-clamp(78px,8vw,118px))] shrink-0">
                  <div className="block animate-shield-sk bg-white/12 motion-reduce:animate-none h-[clamp(44px,5vw,72px)] w-[180px] max-w-full rounded-xl" />
                  <div className="block animate-shield-sk bg-white/12 motion-reduce:animate-none mt-2.5 h-[calc(clamp(15px,1.2vw,18px)*1.55)] w-[240px] max-w-full rounded-lg" />
                </div>
              </div>
            ) : prizeReady ? (
              <div className="mt-[clamp(20px,3vh,30px)] flex items-center gap-[clamp(14px,1.6vw,22px)] border-b border-[#262630] pb-[clamp(20px,3vh,28px)]">
                <img
                  className="aspect-square h-auto w-[clamp(64px,6.5vw,96px)]"
                  src="/shield-and-win/zec.svg"
                  alt=""
                />
                <div>
                  <b className="block text-[clamp(44px,5vw,72px)] leading-none font-semibold tracking-[-0.02em] text-white">
                    {board.prizeAmount} {board.prizeAsset}
                  </b>
                  {board.prizePoolLabel ? (
                    <span className="mt-2.5 block text-[clamp(15px,1.2vw,18px)] text-[#bcbcc8]">
                      {board.prizePoolLabel}
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null}
            {campaignState === 'loading' || typeof board.drawsSoFar === 'number' ? (
              <div className="mt-[clamp(18px,2.6vh,26px)]">
                <span className="text-[15px] text-[#a7a9ad]">Draws so far</span>
                <span className="mt-2.5 block font-['Doto',ui-monospace,monospace] text-[clamp(56px,min(6.4vw,11vh),104px)] leading-none font-bold text-[#3dffbe] [text-shadow:0_0_26px_rgba(61,255,190,0.35)]">
                  {(typeof board.drawsSoFar === 'number' ? board.drawsSoFar : 0).toLocaleString(
                    'en-US'
                  )}
                </span>
              </div>
            ) : null}
            {campaignState === 'loading' ? (
              <div className="mt-[clamp(16px,2.6vh,24px)] grid grid-cols-2 gap-3.5 max-[440px]:grid-cols-1">
                <div className="@container min-w-0 rounded-[14px] border border-[#2a2a33] bg-white/[0.03] px-[18px] py-4 max-[760px]:p-3.5 max-[440px]:flex max-[440px]:items-baseline max-[440px]:justify-between max-[440px]:gap-3">
                  <span className="block text-sm text-[#a7a9ad]">Odds per draw</span>
                  <span className="block animate-shield-sk bg-white/12 motion-reduce:animate-none mt-2 h-[clamp(24px,2.3vw,36px)] w-[120px] max-w-full rounded-lg" />
                </div>
                <div className="@container min-w-0 rounded-[14px] border border-[#2a2a33] bg-white/[0.03] px-[18px] py-4 max-[760px]:p-3.5 max-[440px]:flex max-[440px]:items-baseline max-[440px]:justify-between max-[440px]:gap-3">
                  <span className="block text-sm text-[#a7a9ad]">Ends in</span>
                  <span className="block animate-shield-sk bg-white/12 motion-reduce:animate-none mt-2 h-[clamp(24px,2.3vw,36px)] w-[120px] max-w-full rounded-lg" />
                </div>
              </div>
            ) : campaignState === 'ready' && campaign ? (
              <div className="mt-[clamp(16px,2.6vh,24px)] grid grid-cols-2 gap-3.5 max-[440px]:grid-cols-1">
                <div className="@container min-w-0 rounded-[14px] border border-[#2a2a33] bg-white/[0.03] px-[18px] py-4 max-[760px]:p-3.5 max-[440px]:flex max-[440px]:items-baseline max-[440px]:justify-between max-[440px]:gap-3">
                  <span className="block text-sm text-[#a7a9ad]">{board.oddsLabel}</span>
                  <b className="mt-2 block max-w-full font-['Doto',ui-monospace,monospace] text-[clamp(15px,12.5cqi,36px)] leading-[1.1] font-bold whitespace-nowrap text-white max-[440px]:mt-0 max-[440px]:text-[clamp(14px,11cqi,26px)]">
                    {board.oddsValue}
                  </b>
                </div>
                <div className="@container min-w-0 rounded-[14px] border border-[#2a2a33] bg-white/[0.03] px-[18px] py-4 max-[760px]:p-3.5 max-[440px]:flex max-[440px]:items-baseline max-[440px]:justify-between max-[440px]:gap-3">
                  <span className="block text-sm text-[#a7a9ad]">{board.endsLabel}</span>
                  <b className="mt-2 block max-w-full font-['Doto',ui-monospace,monospace] text-[clamp(15px,12.5cqi,36px)] leading-[1.1] font-bold whitespace-nowrap text-white max-[440px]:mt-0 max-[440px]:text-[clamp(14px,11cqi,26px)]">
                    {board.endsValue}
                  </b>
                </div>
              </div>
            ) : null}
          </aside>
        </section>
      </main>

      <footer className="px-4 pt-[22px] pb-[26px] text-center text-[13px] leading-[1.6] text-[#8b8e93]">
        {prizeReady && board.prizePoolLabel ? (
          <p>
            {board.prizePoolLabel}. The campaign ends when it is no longer active.{' '}
            <button
              type="button"
              className="cursor-pointer border-0 bg-transparent p-0 font-[inherit] text-[length:inherit] leading-[inherit] text-[#bcbcc8] underline decoration-white/30 underline-offset-[3px] hover:text-white"
              onClick={() => setRulesOpen(true)}
            >
              Rules
            </button>
          </p>
        ) : (
          <p>
            <button
              type="button"
              className="cursor-pointer border-0 bg-transparent p-0 font-[inherit] text-[length:inherit] leading-[inherit] text-[#bcbcc8] underline decoration-white/30 underline-offset-[3px] hover:text-white"
              onClick={() => setRulesOpen(true)}
            >
              Rules
            </button>
          </p>
        )}
        <p className="mt-1 text-[#5d5d66]">© 2026 Noir Privacy Terminal. All Rights Reserved.</p>
      </footer>

      <dialog
        ref={rulesRef}
        className="m-auto max-h-[min(82dvh,760px)] overflow-hidden border border-[#333] bg-[#141414] p-0 text-white open:flex open:flex-col [&::backdrop]:bg-black/74 w-[min(560px,calc(100%-32px))] rounded-[10px] [&_b]:font-medium [&_b]:text-white [&_ul]:m-0 [&_ul]:list-none [&_ul]:px-[22px] [&_ul]:py-0 [&_li]:relative [&_li]:border-t [&_li]:border-[#232323] [&_li]:py-3 [&_li]:pl-5 [&_li]:text-[15px] [&_li]:leading-[1.55] [&_li]:text-[#bcbcc8] [&_li]:[overflow-wrap:anywhere] [&_li]:before:absolute [&_li]:before:top-[21px] [&_li]:before:left-0.5 [&_li]:before:size-1.5 [&_li]:before:rounded-full [&_li]:before:bg-[#3dffbe] [&_li]:before:content-['']"
        aria-labelledby="rules-title"
        onClose={() => setRulesOpen(false)}
        onClick={event => closeOnBackdrop(event, () => setRulesOpen(false))}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 bg-[#141414] px-[22px] pt-5 pb-3">
          <h2 id="rules-title" className="text-xl font-semibold text-white">
            Rules
          </h2>
          <button
            type="button"
            className="grid size-10 cursor-pointer place-items-center rounded-lg border border-[#333] bg-transparent text-white [&_svg]:size-[18px]"
            aria-label="Close"
            onClick={() => setRulesOpen(false)}
          >
            <CloseIcon />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-3">
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
        className="m-auto max-h-[min(82dvh,760px)] overflow-hidden border border-[#333] bg-[#141414] p-0 text-white open:flex open:flex-col [&::backdrop]:bg-black/74 w-[min(680px,calc(100%-32px))] rounded-[10px] [&_li]:px-[22px]"
        aria-labelledby="entries-title"
        onClose={() => setAllEntriesOpen(false)}
        onClick={event => closeOnBackdrop(event, () => setAllEntriesOpen(false))}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 bg-[#141414] px-[22px] pt-5 pb-3">
          <div>
            <h2 id="entries-title" className="text-xl font-semibold text-white">
              Your entries
            </h2>
            <span className="text-xs text-[#8b8e93]">{entryTotal} entries</span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <EntriesRefreshButton
              busy={entryRefreshBusy}
              cooling={entryRefreshCooling}
              blocked={allEntriesLoading || claimBusy}
              onRefresh={() => void onRefreshEntry()}
            />
            <button
              type="button"
              className="grid size-10 cursor-pointer place-items-center rounded-lg border border-[#333] bg-transparent text-white [&_svg]:size-[18px]"
              aria-label="Close"
              onClick={() => setAllEntriesOpen(false)}
            >
              <CloseIcon />
            </button>
          </div>
        </div>
        {orderedEntries.length > 0 ? <EntryColumns dialog /> : null}
        <div className="min-h-0 flex-1 overflow-auto pt-1 pb-2 px-1">
          {allEntriesLoading ? (
            <p className="text-center px-[22px] py-4 text-[12px] text-[#bcbcc8]" role="status">
              Loading all entries…
            </p>
          ) : null}
          {allEntriesError ? (
            <div className="px-[22px] py-4 text-[13px] text-[#bcbcc8]" role="alert">
              Could not load all entries.{' '}
              <button
                type="button"
                className="cursor-pointer border-0 bg-transparent p-0 font-[inherit] text-[length:inherit] leading-[inherit] text-[#bcbcc8] underline decoration-white/30 underline-offset-[3px] hover:text-white"
                onClick={() => setAllEntriesRetry(value => value + 1)}
              >
                Retry
              </button>
            </div>
          ) : null}
          {orderedEntries.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {orderedEntries.map(renderEntry)}
            </ul>
          ) : !allEntriesLoading ? (
            <p className="px-[22px] py-4 text-[13px] text-[#bcbcc8]">No entries yet.</p>
          ) : null}
        </div>
      </dialog>

      <dialog
        ref={claimRef}
        className="m-auto max-h-[min(82dvh,760px)] overflow-hidden border border-[#333] bg-[#141414] p-0 text-white open:flex open:flex-col [&::backdrop]:bg-black/74 w-[min(360px,calc(100%-32px))] rounded-[10px]"
        aria-labelledby="claim-title"
        onCancel={event => {
          if (claimBusy) event.preventDefault()
        }}
        onClose={() => setClaimOpen(false)}
        onClick={event => {
          if (!claimBusy) closeOnBackdrop(event, () => setClaimOpen(false))
        }}
      >
        {claimTarget ? (
          <>
            <div className="flex shrink-0 items-center justify-between gap-3 bg-[#141414] px-5 pt-[22px] pb-1">
              <h2 id="claim-title" className="text-xl font-semibold text-white">
                Claim {rewardText(claimTarget)}
              </h2>
              {walletPayout ? (
                <button
                  type="button"
                  className="grid size-7 text-[#FF5E59] shrink-0 cursor-pointer place-items-center rounded-lg border border-[#333] bg-transparent text-white enabled:hover:border-[#666] disabled:cursor-default disabled:opacity-[0.55] [&_svg]:size-[18px]"
                  aria-label="Disconnect Zcash"
                  disabled={claimBusy}
                  onClick={() => void onDisconnectZcash()}
                >
                  <DisconnectIcon className="scale-75" color="#FF5E59" />
                </button>
              ) : null}
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <div className="px-5 pt-2 pb-5">
                <div className="flex flex-col items-center gap-1.5 px-0 pt-2 pb-3.5 text-center">
                  <img className="size-11" src="/shield-and-win/zec.svg" alt="" />
                  <span className="font-['Doto',ui-monospace,monospace] text-[34px] leading-none font-normal text-[#ffcc00]">
                    {rewardText(claimTarget)}
                  </span>
                  <small className="text-xs leading-[1.45] text-[#a7a9ad]">
                    Network fee paid by Noir. You receive the full {rewardText(claimTarget)}.
                  </small>
                </div>
                <p className="mx-0.5 pb-1.5 text-xs leading-[1.4] text-[#8b8e93]">Send to</p>
                <div className="flex flex-col gap-2" role="radiogroup" aria-label="Send to">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={walletSelected}
                    className={destinationRowClass(walletSelected)}
                    onClick={() => setPayoutSource('wallet')}
                  >
                    <img
                      className="size-[30px] shrink-0 rounded-lg"
                      src="/shield-and-win/zec.svg"
                      alt=""
                    />
                    <span className="min-w-0 flex-1">
                      <b className="block font-medium text-white">Zcash · Transparent</b>
                      <small
                        className="block truncate text-xs leading-[1.4] text-[#8b8e93]"
                        aria-label={walletPayout ?? undefined}
                      >
                        {walletPayout ? shortPayoutAddress(walletPayout) : 'Not connected'}
                      </small>
                    </span>
                    <DestinationRadio selected={walletSelected} />
                  </button>
                  <div
                    role="radio"
                    aria-checked={!walletSelected}
                    tabIndex={0}
                    className={destinationRowClass(!walletSelected)}
                    onClick={selectManualPayout}
                    onKeyDown={event => {
                      if (event.target !== event.currentTarget) return
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      selectManualPayout()
                    }}
                  >
                    <img
                      className="size-[30px] shrink-0 rounded-lg"
                      src="/shield-and-win/zec.svg"
                      alt=""
                    />
                    <span className="min-w-0 flex-1">
                      <b className="block font-medium text-white">Transparent address</b>
                      <input
                        ref={manualPayoutRef}
                        value={manualPayout}
                        readOnly={walletSelected}
                        aria-label="Transparent address"
                        aria-invalid={manualInvalid}
                        aria-describedby={manualInvalid ? 'shield-win-address-error' : undefined}
                        placeholder="t1..."
                        className="mt-0.5 w-full bg-transparent text-xs leading-[1.4] text-white outline-none placeholder:text-[#5d5d66] read-only:cursor-pointer read-only:text-[#8b8e93]"
                        onChange={event => setManualPayout(event.target.value)}
                        onFocus={() => setPayoutSource('manual')}
                        onClick={event => event.stopPropagation()}
                      />
                    </span>
                    <DestinationRadio selected={!walletSelected} />
                  </div>
                  {manualInvalid ? (
                    <p
                      id="shield-win-address-error"
                      className="mx-0.5 text-xs leading-normal text-[#ffc04d]"
                    >
                      {INVALID_TRANSPARENT_ADDRESS}
                    </p>
                  ) : null}
                </div>
                <p className="mx-0.5 pt-3 pb-3.5 text-xs leading-normal text-[#a7a9ad]">
                  We ask for this address only because you won, and we don&apos;t link it to your
                  Public or Shield accounts.
                </p>
                {claimError ? (
                  <p
                    className="mx-0.5 mb-3.5 text-sm leading-normal text-[#ffc04d]"
                    id="shield-win-claim-error"
                  >
                    {claimError}
                  </p>
                ) : null}
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    className="inline-flex cursor-pointer items-center justify-center gap-2.5 border font-['DM_Sans',system-ui,sans-serif] leading-none font-medium no-underline transition-[background-color,border-color] duration-150 disabled:cursor-default disabled:opacity-[0.55] [&_svg]:block [&_svg]:size-[18px] [&_svg]:shrink-0 h-[46px] w-full rounded-[10px] px-7 text-[15px] border-transparent bg-[#00d18a] text-black hover:bg-[#1ee3a0] hover:text-black"
                    disabled={
                      claimBusy || claimAction === 'enter' || (claimAction === 'claim' && !address)
                    }
                    aria-describedby={
                      [
                        manualInvalid ? 'shield-win-address-error' : null,
                        claimError ? 'shield-win-claim-error' : null
                      ]
                        .filter(Boolean)
                        .join(' ') || undefined
                    }
                    onClick={() => {
                      if (claimAction === 'connect') void onConnectZcash()
                      else void onSign()
                    }}
                  >
                    {claimAction === 'connect'
                      ? 'Connect Noir Wallet'
                      : claimAction === 'enter'
                        ? 'Enter address'
                        : `Claim ${rewardText(claimTarget)}`}
                  </button>
                  <button
                    type="button"
                    className="inline-flex cursor-pointer items-center justify-center gap-2.5 border font-['DM_Sans',system-ui,sans-serif] leading-none font-medium no-underline transition-[background-color,border-color] duration-150 disabled:cursor-default disabled:opacity-[0.55] [&_svg]:block [&_svg]:size-[18px] [&_svg]:shrink-0 h-[46px] w-full rounded-[10px] px-7 text-[15px] border-transparent bg-[#2a2a32] text-white hover:border-transparent hover:bg-[#34343d] hover:text-white"
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
