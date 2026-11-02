import './branding.css'

/** The selected TraceLens mark. Inherits the surrounding ink color in either theme. */
export function BrandIcon({ motion, className = '' }: { motion?: 'loop' | 'once'; className?: string }) {
  return (
    <span className={`brand-icon ${className}`} data-motion={motion} aria-hidden="true">
      <span className="brand-icon-left" />
      <span className="brand-icon-center" />
      <span className="brand-icon-right" />
    </span>
  )
}
