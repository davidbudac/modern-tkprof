import type { ReactNode } from 'react'

/**
 * Line icons for icon-only buttons (lucide shapes, ISC). Decorative: the button carries the name (`aria-label`) and the tooltip
 * (`title`). 1em square; inside `button.icon-btn` (app.css) the box is one line tall, so the button matches its text neighbours.
 */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  )
}

export const CopyIcon = () => (
  <Icon>
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </Icon>
)

/** Shown in place of `CopyIcon` for a moment after a copy. */
export const CheckIcon = () => <Icon><path d="M20 6 9 17l-5-5" /></Icon>
