import { ResyncZcashContent } from '../components/account/AccountModals'
import { openModal } from '../provider/ModalManager'
import { useNavigate } from '../provider/Router'
import { resyncZcashWallet } from '../services/zcash-settings-client'

export function useResyncZcash() {
  const { navigate } = useNavigate()

  return async (
    walletId: string,
    accountId: string,
    birthdayHeight: number,
    options?: { recovery?: boolean }
  ) => {
    await openModal<void>({
      title: options?.recovery ? 'Restore Zcash' : 'Resync Zcash',
      body: resolve => (
        <ResyncZcashContent
          walletId={walletId}
          accountId={accountId}
          birthdayHeight={birthdayHeight}
          recovery={options?.recovery}
          onGetHelp={
            options?.recovery
              ? () => {
                  resolve()
                  navigate('/help')
                }
              : undefined
          }
          onConfirm={async height => {
            await resyncZcashWallet({ walletId, accountId, birthdayHeight: height })
            resolve()
            navigate('/')
          }}
          close={() => resolve()}
        />
      )
    })
  }
}
