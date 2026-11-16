import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { NYM_DOWNLOAD_URL, TOR_DOWNLOAD_URL } from '@/lib/legacy-pool-privacy-notice'

interface LegacyPoolPrivacyNoticeProps {
  open: boolean
  onDismiss: () => void
}

export function LegacyPoolPrivacyNotice({ open, onDismiss }: LegacyPoolPrivacyNoticeProps) {
  const openPrivacyTool = (url: string) => {
    chrome.tabs.create({ url }).catch(openError => {
      console.warn('[PrivacyNotice] Failed to open privacy tool:', openError)
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) onDismiss()
      }}
    >
      <DialogContent
        showCloseButton={false}
        onOpenAutoFocus={event => event.preventDefault()}
        className="max-w-[351px] gap-0 rounded-2xl border border-border bg-card p-5"
      >
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close privacy notice"
          className="absolute top-3 right-3 rounded-full text-muted hover:bg-white/10 hover:text-white"
          onClick={onDismiss}
        >
          <span aria-hidden className="text-xl leading-none">
            ×
          </span>
        </Button>

        <DialogHeader className="items-center text-center">
          <div
            aria-hidden
            className="mb-1 flex size-11 items-center justify-center rounded-full bg-primary/15 text-[10px] font-bold text-primary"
          >
            IP
          </div>
          <DialogTitle className="leading-snug">Protect your network privacy</DialogTitle>
          <DialogDescription className="sr-only">
            Important privacy information about migrating ZEC from Orchard to Ironwood.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 space-y-3 text-left text-xs leading-5 text-[#a6adb5]">
          <p>
            Zcash mainnet has activated the new Ironwood shielded pool. Some ZEC in your wallet
            remains in Orchard and will migrate to Ironwood when used in future transactions.
          </p>
          <p>
            Cross-pool amounts may be visible on-chain. To reduce links between your transactions,
            wallet balance, activity timing, and real IP address, enable{' '}
            <button
              type="button"
              className="inline-flex items-center gap-1 align-middle font-medium text-[#73b7ef] hover:underline"
              onClick={() => openPrivacyTool(NYM_DOWNLOAD_URL)}
            >
              <img
                aria-hidden
                alt=""
                src="https://www.google.com/s2/favicons?domain=nym.com&sz=128"
                className="size-4"
                onError={event => {
                  event.currentTarget.style.display = 'none'
                }}
              />
              NymVPN
            </button>
            {' or '}
            <button
              type="button"
              className="inline-flex items-center gap-1 align-middle font-medium text-[#9fc4ef] hover:underline"
              onClick={() => openPrivacyTool(TOR_DOWNLOAD_URL)}
            >
              <img
                aria-hidden
                alt=""
                src="https://www.google.com/s2/favicons?domain=torproject.org&sz=128"
                className="size-4"
                onError={event => {
                  event.currentTarget.style.display = 'none'
                }}
              />
              Tor
            </button>{' '}
            before transferring. Split funds into standardized amounts of 1, 2, or 5 × 10ⁿ and
            process them individually at different times, avoiding multiple transactions in quick
            succession.
          </p>
          <p>
            NoirWallet will not initiate transactions automatically; each migration requires your
            confirmation. Staggering transactions reduces linkage risk but cannot guarantee complete
            anonymity.
          </p>
        </div>

        <Button className="mt-4 h-11 w-full rounded-lg font-semibold" onClick={onDismiss}>
          Got it
        </Button>
      </DialogContent>
    </Dialog>
  )
}
