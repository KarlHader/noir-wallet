import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  type ComponentProps,
  type Dispatch,
  type ReactNode,
  type SetStateAction
} from 'react'
import { SendFormView } from './SendInputCards'

type SendFormProps = ComponentProps<typeof SendFormView>
type SendFormRegistration = { owner: symbol; props: SendFormProps }

const SendFormContext = createContext<Dispatch<SetStateAction<SendFormRegistration | null>> | null>(
  null
)

export function SendFormLayout({ children }: { readonly children: ReactNode }) {
  const [form, setForm] = useState<SendFormRegistration | null>(null)
  return (
    <SendFormContext.Provider value={setForm}>
      <div className="page-container">
        {children}
        {form && <SendFormView {...form.props} />}
      </div>
    </SendFormContext.Provider>
  )
}

export function useSharedSendForm(): boolean {
  return useContext(SendFormContext) !== null
}

export function SendFormSlot({ inline = false, ...props }: SendFormProps & { inline?: boolean }) {
  const context = useContext(SendFormContext)
  const register = inline ? null : context
  const [owner] = useState(() => Symbol())

  // Update the shared form in the same commit as its adapter, before paint.
  useLayoutEffect(() => {
    register?.({ owner, props })
  })
  useLayoutEffect(
    () => () => register?.(current => (current?.owner === owner ? null : current)),
    [register, owner]
  )

  return register ? null : <SendFormView {...props} />
}
