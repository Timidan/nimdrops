import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { AppRoutes } from './App'

afterEach(cleanup)

function at(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  )
}

describe('router', () => {
  // The root explains the product; it does not ask for money. A stranger who
  // arrives without a link has no drop to claim and nothing to fund, and the
  // form used to be the first thing they saw.
  it('renders the landing page at /, not the create form', () => {
    at('/')
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy()
    expect(screen.queryByLabelText(/NIM per person/i)).toBe(null)
  })

  it('renders the create flow at /create', () => {
    at('/create')
    expect(screen.getByLabelText(/NIM per person/i)).toBeTruthy()
  })

  it('renders the drop page for /drop/:publicId', () => {
    at('/drop/abc')
    // The sealed envelope is the drop page's first frame: a claimant lands on
    // the seal, not on the claim surface. The claim flow owns everything past
    // this point; the router's job is only to hand `/drop/:publicId` to it.
    // Behaviour lives in `pages/Drop.test.tsx`.
    expect(screen.getByTestId('hold-open')).toBeTruthy()
  })

  // A printed QR cannot be reissued, so the old path has to keep landing on the
  // drop rather than on the create form. Asserted at the router because that is
  // the only place a client-side navigation to `/d/…` is still reachable.
  it('carries a legacy /d/:publicId link through to the drop', () => {
    at('/d/abc')
    expect(screen.getByTestId('hold-open')).toBeTruthy()
  })

  // A stale or mistyped link now lands on an explanation rather than on a
  // funding form. Someone who mistyped a claim link is a claimant, not a
  // sponsor, and the useful answer to "this address is wrong" is "here is
  // what this is" — not a field asking them for money.
  it('sends unknown paths to the landing page, not to the create form', () => {
    at('/nope/nope')
    expect(screen.queryByLabelText(/NIM per person/i)).toBe(null)
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy()
  })
})
