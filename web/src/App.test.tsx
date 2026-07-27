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
  it('renders the create flow at /', () => {
    at('/')
    expect(screen.getByLabelText(/NIM per person/i)).toBeTruthy()
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

  it('sends unknown paths home', () => {
    at('/nope/nope')
    expect(screen.getByLabelText(/NIM per person/i)).toBeTruthy()
  })
})
