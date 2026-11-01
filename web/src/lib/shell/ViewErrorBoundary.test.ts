import { isValidElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ViewErrorBoundary, errorDetails } from './ViewErrorBoundary'

// vitest runs in node here (no DOM library in the dev dependencies), so the boundary is driven
// by hand the way React drives it: a child throws -> getDerivedStateFromError -> render().

type Props = ConstructorParameters<typeof ViewErrorBoundary>[0]

/** A boundary instance whose setState applies at once (React is not mounting it). */
function boundary(props: Partial<Props> = {}) {
  const b = new ViewErrorBoundary({ title: 'a.trc', resetKey: 's1', children: 'CHILD-VIEWS', ...props })
  b.setState = ((u: unknown) => {
    const patch = typeof u === 'function' ? (u as (s: typeof b.state) => object)(b.state) : (u as object)
    b.state = { ...b.state, ...patch }
  }) as typeof b.setState
  return b
}

function render(children: () => ReactNode): Error {
  try {
    children()
  } catch (e) {
    return e as Error
  }
  throw new Error('child did not throw')
}

const textOf = (n: ReactNode): string =>
  n == null || typeof n === 'boolean' ? '' : isValidElement<{ children?: ReactNode }>(n) ? textOf(n.props.children) : Array.isArray(n) ? n.map(textOf).join(' ') : String(n)

const buttons = (n: ReactNode): { label: string; onClick?: () => void }[] => {
  if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(n)) return Array.isArray(n) ? n.flatMap(buttons) : []
  const own = n.type === 'button' ? [{ label: textOf(n.props.children), onClick: n.props.onClick }] : []
  return [...own, ...buttons(n.props.children)]
}

function crash(b: ReturnType<typeof boundary>, message = 'boom') {
  const err = render(() => {
    throw new Error(message)
  })
  b.state = { ...b.state, ...ViewErrorBoundary.getDerivedStateFromError(err) }
  return err
}

describe('ViewErrorBoundary', () => {
  it('renders its children while nothing throws', () => {
    const el = boundary().render()
    expect(isValidElement(el) && (el.props as { children: ReactNode }).children).toBe('CHILD-VIEWS')
  })

  it('does not mention tabs unless told to', () => {
    const b = boundary()
    crash(b)
    expect(textOf(b.render())).not.toMatch(/\btab\b/i)
    const desk = boundary({ note: 'The other tabs are not affected.' })
    crash(desk)
    expect(textOf(desk.render())).toContain('The other tabs are not affected.')
  })

  it('shows the error card with the message and the two buttons after a child threw', () => {
    const b = boundary()
    crash(b, 'cannot read x of undefined')
    const card = b.render()
    expect(textOf(card)).toContain('a.trc')
    expect(textOf(card)).toContain('cannot read x of undefined')
    expect(buttons(card).map((x) => x.label)).toEqual(['Reload', 'Copy details'])
    expect(JSON.stringify(card)).not.toContain('CHILD-VIEWS')
  })

  it('"Reload" clears the error and remounts the children', () => {
    const b = boundary()
    crash(b)
    const before = (boundary().render() as { key: string }).key
    buttons(b.render()).find((x) => x.label === 'Reload')!.onClick!()
    expect(b.state.error).toBeNull()
    const after = b.render() as { key: string }
    expect(after.key).not.toBe(before)
  })

  it('resets on another resetKey, not before', () => {
    const b = boundary({ resetKey: 's1' })
    crash(b)
    b.componentDidUpdate({ ...b.props })
    expect(b.state.error).not.toBeNull()
    const prev = b.props
    ;(b as { props: Props }).props = { ...prev, resetKey: 's2' }
    b.componentDidUpdate(prev)
    expect(b.state.error).toBeNull()
  })

  it('copies the details to the clipboard', () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    try {
      const b = boundary({ context: ['path: /t/a.trc', 'session: s1'] })
      crash(b, 'kaput')
      buttons(b.render()).find((x) => x.label === 'Copy details')!.onClick!()
      expect(writeText).toHaveBeenCalledTimes(1)
      const text = (writeText.mock.calls[0] as unknown as [string])[0]
      expect(text).toContain('crashed in "a.trc"')
      expect(text).toContain('path: /t/a.trc')
      expect(text).toContain('Error: kaput')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('wraps a non-Error throw', () => {
    expect(ViewErrorBoundary.getDerivedStateFromError('plain').error?.message).toBe('plain')
  })
})

describe('errorDetails', () => {
  it('lists title, context, error and component stack', () => {
    const e = new Error('x')
    const t = errorDetails('T', ['p: 1'], e, '\n  at View')
    expect(t.split('\n').slice(0, 3)).toEqual(['mtkprof: view crashed in "T"', 'p: 1', ''])
    expect(t).toContain('Component stack:\n  at View')
  })
  it('names the product it is given', () => {
    expect(errorDetails('T', [], new Error('x'), '', 'mtkprof-desktop').split('\n')[0]).toBe('mtkprof-desktop: view crashed in "T"')
  })
})

