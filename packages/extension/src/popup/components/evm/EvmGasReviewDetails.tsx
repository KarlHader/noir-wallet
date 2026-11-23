import { formatEvmWeiAsGwei } from '@/infrastructure/chains/evm'
import { AmountDisplay } from '../common/AmountDisplay'
import {
  TransactionActionDetails,
  TransactionActionRow,
  TransactionActionRows
} from '../transaction/TransactionActionReview'

export function EvmGasReviewDetails({
  nonce,
  gasLimit,
  gasPriceWei,
  maxFeePerGasWei,
  maxPriorityFeePerGasWei
}: {
  readonly nonce: string
  readonly gasLimit: string
  readonly gasPriceWei: string | null
  readonly maxFeePerGasWei: string | null
  readonly maxPriorityFeePerGasWei: string | null
}) {
  const fees = gasPriceWei
    ? [{ label: 'Gas price', value: gasPriceWei }]
    : [
        { label: 'Max fee per gas', value: maxFeePerGasWei ?? '0' },
        { label: 'Priority fee per gas', value: maxPriorityFeePerGasWei ?? '0' }
      ]

  return (
    <TransactionActionDetails>
      <TransactionActionRows>
        <TransactionActionRow label="Nonce">
          <span className="font-mono">{nonce}</span>
        </TransactionActionRow>
        <TransactionActionRow label="Gas limit">
          <span className="font-mono">{gasLimit}</span>
        </TransactionActionRow>
        {fees.map(({ label, value }) => (
          <TransactionActionRow key={label} label={label}>
            <AmountDisplay value={formatEvmWeiAsGwei(value)} symbol="GWEI" profile="fee" />
          </TransactionActionRow>
        ))}
      </TransactionActionRows>
    </TransactionActionDetails>
  )
}
