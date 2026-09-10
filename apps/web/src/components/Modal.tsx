import { useEffect, useRef, type ReactNode } from 'react'

/**
 * Generic modal primitive. Renders a fixed backdrop + a centered card.
 * Closes on Escape and on click outside the card. Aria-labelled by
 * `titleId`, which the caller passes in and applies to the dialog's
 * heading element (so screen readers announce the right label).
 *
 * Not a focus-trap yet — the dialog we ship first has only a handful of
 * interactive elements and no adjacent tab-scope to worry about. Add
 * one when we ship a modal with a text editor or nested picker.
 */
export function Modal({
  onClose,
  children,
  titleId,
}: {
  onClose: () => void
  children: ReactNode
  titleId: string
}) {
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
          onClose()
        }
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="modal-card"
      >
        {children}
      </div>
    </div>
  )
}
