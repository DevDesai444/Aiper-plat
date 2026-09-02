import { X } from 'lucide-react'
import { useToastStore } from './toastStore'

export default function Toaster(): React.JSX.Element | null {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)
  if (toasts.length === 0) return null

  return (
    <div className="toaster">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.tone}`}>
          <span>{t.message}</span>
          <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <X size={12} strokeWidth={1.5} />
          </button>
        </div>
      ))}
    </div>
  )
}
