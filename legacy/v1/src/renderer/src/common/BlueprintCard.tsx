import type { CSSProperties, ReactNode } from 'react'

interface BlueprintCardProps {
  children: ReactNode
  className?: string
  style?: CSSProperties
  onClick?: () => void
}

export default function BlueprintCard({ children, className, style, onClick }: BlueprintCardProps): React.JSX.Element {
  return (
    <div className={`blueprint${className ? ` ${className}` : ''}`} style={style} onClick={onClick}>
      <i className="corner tl" />
      <i className="corner tr" />
      <i className="corner bl" />
      <i className="corner br" />
      {children}
    </div>
  )
}
