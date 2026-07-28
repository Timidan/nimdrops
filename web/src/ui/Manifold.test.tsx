import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import Manifold, { MANIFOLD_CSS, SPOKE_LEN } from './Manifold'

afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: undefined })
})

/** jsdom has no `matchMedia`; this is the whole of one. */
function stubMotion(reduce: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({
      matches: reduce && q.includes('prefers-reduced-motion'),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }),
  })
}

/**
 * The finished diagram, asserted the way it actually fails: not by reading a
 * cascade jsdom does not have, but by proving nothing in the tree is parked in
 * a state that only an animation frame could clear.
 */
function assertFullyDrawn(container: HTMLElement): void {
  const svg = container.querySelector('svg')!

  for (const el of Array.from(svg.querySelectorAll('*'))) {
    for (const attr of ['opacity', 'fill-opacity', 'stroke-opacity']) {
      const value = el.getAttribute(attr)
      if (value !== null) expect(Number(value)).toBeGreaterThan(0)
    }
    expect(el.getAttribute('stroke-dashoffset')).toBeNull()

    const inline = el.getAttribute('style') ?? ''
    expect(inline).not.toMatch(/(^|[;\s])opacity\s*:\s*0/)
    expect(inline).not.toMatch(/stroke-dashoffset\s*:\s*(?!0)/)
  }

  // Every drawn part is present, not just un-hidden.
  expect(svg.querySelectorAll('.mf-capsule')).toHaveLength(1)
  expect(svg.querySelectorAll('.mf-hub')).toHaveLength(1)
  expect(svg.querySelectorAll('.mf-trunk')).toHaveLength(1)
  expect(svg.querySelectorAll('.mf-spoke')).toHaveLength(6)
  expect(svg.querySelectorAll('.mf-node')).toHaveLength(6)
}

function spokes(container: HTMLElement): SVGLineElement[] {
  return Array.from(container.querySelectorAll<SVGLineElement>('.mf-spoke'))
}

function num(el: Element, attr: string): number {
  return Number(el.getAttribute(attr))
}

describe('Manifold', () => {
  it('renders the instrument, fluidly and without a headcount in it', () => {
    const { container } = render(<Manifold />)
    const svg = container.querySelector('svg')!

    expect(svg.getAttribute('viewBox')).toBe('0 0 440 408')
    expect(svg.getAttribute('width')).toBeNull()
    expect(svg.getAttribute('height')).toBeNull()

    // Decorative: the heading beside it carries the meaning, and six cards are
    // a composition rather than a claim about how many people can claim.
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.textContent).toBe('')
    expect(container.querySelector('img')).toBeNull()
    expect(svg.outerHTML).not.toMatch(/aria-label|aria-labelledby|<text|<title/)

    assertFullyDrawn(container)
  })

  it('gives all six branches an identical length, stroke and endpoint', () => {
    const { container } = render(<Manifold />)
    const six = spokes(container)

    expect(six).toHaveLength(6)

    const lengths = six.map((s) =>
      Math.hypot(num(s, 'x2') - num(s, 'x1'), num(s, 'y2') - num(s, 'y1')),
    )
    // Identical to the resolution the markup is rounded to, and equal to the
    // one constant both ends are built from.
    expect(new Set(lengths.map((l) => l.toFixed(2))).size).toBe(1)
    for (const length of lengths) expect(length).toBeCloseTo(SPOKE_LEN, 2)

    // Same endpoint radius, so no card is reached further out than another.
    const ends = six.map((s) => Math.hypot(num(s, 'x2') - 220, num(s, 'y2') - 188))
    expect(new Set(ends.map((r) => r.toFixed(2))).size).toBe(1)

    // Same stroke, same dash, same class: one rule drives all six.
    for (const attr of ['class', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray']) {
      expect(new Set(six.map((s) => s.getAttribute(attr))).size).toBe(1)
    }
  })

  it('settles all six cards by the same distance, so none arrives first', () => {
    const { container } = render(<Manifold />)
    const travel = Array.from(container.querySelectorAll('.mf-node')).map((node) => {
      const style = node.getAttribute('style') ?? ''
      const x = Number(/--mf-in-x:\s*(-?[\d.]+)px/.exec(style)?.[1])
      const y = Number(/--mf-in-y:\s*(-?[\d.]+)px/.exec(style)?.[1])
      return Math.hypot(x, y)
    })

    expect(travel).toHaveLength(6)
    for (const distance of travel) expect(distance).toBeCloseTo(8, 2)
  })

  it('starts every animation behind one gate, and staggers nothing', () => {
    const rules = Array.from(MANIFOLD_CSS.matchAll(/([^{}]*)\{[^{}]*animation-name:[^{}]*\}/g))

    expect(rules.length).toBeGreaterThan(0)
    for (const [, selector] of rules) {
      expect(selector).toContain("[data-animate='true']")
    }

    // One rule for the branches and one for the cards: no per-index delay can
    // creep in and make one recipient arrive before another.
    expect(rules.filter(([, s]) => s.includes('.mf-spoke'))).toHaveLength(1)
    expect(rules.filter(([, s]) => s.includes('.mf-node'))).toHaveLength(1)
    expect(MANIFOLD_CSS).not.toMatch(/nth-child|nth-of-type/)

    // Belt and braces on top of the JS gate, for a preference flipped live.
    expect(MANIFOLD_CSS).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('renders the finished diagram and never opens the gate under reduced motion', () => {
    stubMotion(true)
    const { container } = render(<Manifold />)

    expect(container.querySelector('.nd-manifold')!.getAttribute('data-animate')).toBe('false')
    assertFullyDrawn(container)
  })

  it('opens the gate when the reader has no preference against motion', () => {
    stubMotion(false)
    const { container } = render(<Manifold />)

    expect(container.querySelector('.nd-manifold')!.getAttribute('data-animate')).toBe('true')
    // Even mid-animation the markup itself is still the finished diagram.
    assertFullyDrawn(container)
  })

  it('does not throw, or animate, where there is no matchMedia at all', () => {
    expect(window.matchMedia).toBeUndefined()

    const { container } = render(<Manifold />)

    expect(container.querySelector('.nd-manifold')!.getAttribute('data-animate')).toBe('false')
    assertFullyDrawn(container)
  })

  it('unmounts without throwing', () => {
    stubMotion(false)
    const { unmount } = render(<Manifold />)

    expect(() => unmount()).not.toThrow()
  })
})
