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

  it('renders the campaign page for /d/:publicId', () => {
    at('/d/abc')
    // The claim flow owns everything past this point; the router's job is only
    // to hand `/d/:publicId` to it. Behaviour lives in `pages/Drop.test.tsx`.
    expect(screen.getByText(/opening this nimdrop/i)).toBeTruthy()
  })

  it('sends unknown paths home', () => {
    at('/nope/nope')
    expect(screen.getByLabelText(/NIM per person/i)).toBeTruthy()
  })
})
