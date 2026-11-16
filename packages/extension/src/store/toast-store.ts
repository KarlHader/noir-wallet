import { create } from 'zustand'

export type ToastType = 'success' | 'error' | 'warning' | 'info'
export type ToastVariant = 'compact' | 'notification' | 'bottom-action'

export interface ToastAction {
  label: string
  onClick: () => void
}

interface ToastOptions {
  action?: ToastAction
  secondaryAction?: ToastAction
  variant?: ToastVariant
}

interface Toast {
  id: string
  type: ToastType
  title: string
  description?: string
  action?: ToastAction
  secondaryAction?: ToastAction
  variant?: ToastVariant
}

interface ToastStore {
  toasts: Toast[]
  addToast: (toast: Omit<Toast, 'id'>) => void
  removeToast: (id: string) => void
}

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],
  addToast: toast => {
    const id = `${Date.now()}-${crypto.randomUUID()}`
    const durationMs =
      toast.variant === 'bottom-action' ? 12_000 : toast.variant === 'notification' ? 8000 : 4000
    set({ toasts: [...get().toasts, { ...toast, id }] })
    setTimeout(() => get().removeToast(id), durationMs)
  },
  removeToast: id => {
    set({ toasts: get().toasts.filter(t => t.id !== id) })
  }
}))

// Helper functions for easy access
export const toast = {
  success: (title: string, description?: string) => {
    useToastStore.getState().addToast({ type: 'success', title, description })
  },
  error: (title: string, description?: string) => {
    useToastStore.getState().addToast({ type: 'error', title, description })
  },
  warning: (title: string, description?: string) => {
    useToastStore.getState().addToast({ type: 'warning', title, description })
  },
  info: (title: string, description?: string, options?: ToastOptions) => {
    useToastStore.getState().addToast({ type: 'info', title, description, ...options })
  },
  action: (
    title: string,
    description: string,
    options: Pick<ToastOptions, 'action' | 'secondaryAction'> &
      Required<Pick<ToastOptions, 'action'>>
  ) => {
    useToastStore.getState().addToast({
      type: 'info',
      title,
      description,
      variant: 'bottom-action',
      ...options
    })
  }
}
