import type { ReactNode } from 'react'
import { MessageCircleMore, X } from 'lucide-react'

export function Logo({ small = false }: { small?: boolean }) {
  return <div className={`logo-mark ${small ? 'small' : ''}`}><MessageCircleMore /></div>
}

export function Avatar({ initials, color, online, size = 'md' }: { initials: string; color: string; online?: boolean; size?: 'sm' | 'md' | 'lg' }) {
  return <div className={`avatar avatar-${size}`} style={{ background: color }}><span>{initials}</span>{online && <i />}</div>
}

export function Modal({ title, children, onClose, footer }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="modal" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
      <header><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="关闭"><X /></button></header>
      <div className="modal-body">{children}</div>
      {footer && <footer>{footer}</footer>}
    </section>
  </div>
}

export function EmptyState({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return <div className="empty-state"><div>{icon}</div><h3>{title}</h3><p>{text}</p></div>
}
