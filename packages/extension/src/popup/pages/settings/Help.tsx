import { useState } from 'react'
import { Icon } from '@iconify/react'
import { PageHeader } from '../../components/common/PageHeader'
import { Button } from '../../components/ui/button'
import { toast } from '@/store/toast-store'
import { TELEGRAM_SUPPORT_URL } from '@/config/social-links'

interface DiagnosticExportResponse {
  success: boolean
  text?: string
  filename?: string
  count?: number
}

export function Help() {
  const [isDownloading, setIsDownloading] = useState(false)

  const handleDownload = async () => {
    if (isDownloading) return
    setIsDownloading(true)
    try {
      const result = (await chrome.runtime.sendMessage({
        type: 'EXPORT_DIAGNOSTIC_LOGS'
      })) as DiagnosticExportResponse
      if (
        !result?.success ||
        typeof result.text !== 'string' ||
        typeof result.filename !== 'string'
      ) {
        throw new Error('Could not export diagnostic logs')
      }
      const url = URL.createObjectURL(new Blob([result.text], { type: 'text/plain;charset=utf-8' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = result.filename
      anchor.style.display = 'none'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
      const count = result.count ?? 0
      toast.success(
        'Logs downloaded',
        `${count} diagnostic ${count === 1 ? 'entry' : 'entries'} exported`
      )
    } catch (error) {
      toast.error(
        'Download failed',
        error instanceof Error ? error.message : 'Could not export diagnostic logs'
      )
    } finally {
      setIsDownloading(false)
    }
  }

  return (
    <div className="page-container">
      <PageHeader title="Help" showBack />

      <div className="page-content">
        <div className="space-y-3 rounded-lg bg-card p-4">
          <p className="text-xs leading-relaxed text-muted">
            Download recent technical logs to help Noir Support investigate an issue.
          </p>
          <p className="text-xs leading-relaxed text-muted">
            Logs stay on this device and never include recovery phrases, private keys, passwords,
            addresses, balances, or transaction amounts. Up to 500 entries from the last 24 hours
            are kept.
          </p>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            isLoading={isDownloading}
            onClick={handleDownload}
          >
            {!isDownloading && <Icon icon="lucide:download" width={16} height={16} />}
            {isDownloading ? 'Preparing' : 'Download Logs'}
          </Button>
        </div>
      </div>

      <div className="page-footer grid grid-cols-2 gap-3">
        <Button asChild variant="outline" className="h-[45px] min-w-0 px-3">
          <a
            href={TELEGRAM_SUPPORT_URL}
            target="_blank"
            rel="noopener noreferrer"
            data-analytics-outbound="social_telegram"
            data-analytics-domain="t.me"
          >
            <Icon icon="lucide:send" width={16} height={16} />
            Telegram
          </a>
        </Button>
        <Button asChild className="h-[45px] min-w-0 px-3">
          <a href="https://app.zknoir.com/?zendesk=1" target="_blank" rel="noopener noreferrer">
            <Icon icon="lucide:life-buoy" width={16} height={16} />
            Support
          </a>
        </Button>
      </div>
    </div>
  )
}
