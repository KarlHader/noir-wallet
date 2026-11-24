import { useSearchParams } from 'react-router-dom'
import { DepositWithdraw } from './DepositWithdraw'
import type { ShieldFundsFormProps } from '@/popup/services/shield-funds-route'

export function ShieldFundsForm(props: ShieldFundsFormProps) {
  return <DepositWithdraw fixedShield={props} />
}

function ShieldFundsRoute({ direction }: Pick<ShieldFundsFormProps, 'direction'>) {
  const [params] = useSearchParams()
  const provider = params.get('provider')
  return (
    <ShieldFundsForm
      direction={direction}
      assetId={params.get('assetId')}
      provider={provider === 'zcash-shield' || provider === 'near-confidential' ? provider : null}
    />
  )
}

export function ShieldFundsPage() {
  return <ShieldFundsRoute direction="shield" />
}

export function UnshieldFundsPage() {
  return <ShieldFundsRoute direction="unshield" />
}
