import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { NIMIQ_ECOSYSTEM_LINKS } from '../integrations/nimiq'
import PostClaimActions from './PostClaimActions'

afterEach(cleanup)

describe('PostClaimActions', () => {
  it('offers spend and sell handoffs without pretending NimDrops converts the claim', () => {
    render(<PostClaimActions />)

    const panel = screen.getByTestId('post-claim-actions')
    const spend = within(panel).getByRole('link', { name: NIMIQ_ECOSYSTEM_LINKS.spend.label })
    const sell = within(panel).getByRole('link', { name: NIMIQ_ECOSYSTEM_LINKS.sell.label })

    expect(spend.getAttribute('href')).toBe(NIMIQ_ECOSYSTEM_LINKS.spend.href)
    expect(sell.getAttribute('href')).toBe(NIMIQ_ECOSYSTEM_LINKS.sell.href)
    for (const link of [spend, sell]) {
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toMatch(/noopener/)
      expect(link.getAttribute('rel')).toMatch(/noreferrer/)
      expect(link.getAttribute('referrerpolicy')).toBe('no-referrer')
    }

    const text = panel.textContent ?? ''
    expect(text).toMatch(/already in Nimiq Pay/i)
    expect(text).toMatch(/availability, minimums, fees, and identity checks vary/i)
    expect(text).not.toMatch(/instant|one.?tap|receive USD/i)
  })
})
