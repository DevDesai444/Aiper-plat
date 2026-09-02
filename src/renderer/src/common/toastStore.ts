import { create } from 'zustand'

export interface Toast {
  id: number
  message: string
  tone: 'info' | 'warn' | 'error'
}

interface ToastState {
  toasts: Toast[]
  push: (message: string, tone?: Toast['tone']) => void
  dismiss: (id: number) => void
}

let nextId = 1

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (message, tone = 'info') => {
    const id = nextId++
    set((s) => ({ toasts: [...s.toasts, { id, message, tone }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4000)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))

/** Convenience for the many ribbon commands that are present in the UI but not yet built.
 *  Saying so out loud beats a button that appears to work and does nothing. */
export function notImplemented(feature: string): void {
  useToastStore.getState().push(`${feature} isn’t implemented yet.`, 'warn')
}
