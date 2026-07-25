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

  it('renders the campaign page for /d/:publicId with the campaign id', () => {
    at('/d/abc')
    expect(screen.getByText(/abc/)).toBeTruthy()
    expect(screen.getByText(/task 16/i)).toBeTruthy()
  })

  it('sends unknown paths home', () => {
    at('/nope/nope')
    expect(screen.getByLabelText(/NIM per person/i)).toBeTruthy()
  })
})
