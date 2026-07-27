import { describe, expect, it } from 'vitest'
import { NIMIQ_ECOSYSTEM_LINKS } from './nimiq'

describe('Nimiq ecosystem links', () => {
  it('uses allowlisted HTTPS destinations without claim data', () => {
    const links = Object.values(NIMIQ_ECOSYSTEM_LINKS)
    const allowedOrigins = new Set(['https://map.nimiq.com', 'https://www.nimiq.com'])

    for (const link of links) {
      const url = new URL(link.href)
      expect(allowedOrigins.has(url.origin)).toBe(true)
      expect(url.protocol).toBe('https:')
      expect(url.search).toBe('')
      expect(url.hash).toBe('')
    }
  })
})
