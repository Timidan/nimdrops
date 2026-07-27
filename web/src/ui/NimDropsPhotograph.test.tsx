import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import NimDropsPhotograph, { NimDropsPhotographPreload } from './NimDropsPhotograph'

afterEach(cleanup)

describe('NimDropsPhotograph', () => {
  it('ships responsive AVIF with a WebP fallback and reserved dimensions', () => {
    const { container } = render(<NimDropsPhotograph variant="packet-cutout" priority />)
    const sources = container.querySelectorAll('source')
    const image = container.querySelector('img')

    expect(sources).toHaveLength(2)
    expect(sources[0].type).toBe('image/avif')
    expect(sources[0].srcset).toContain('red-packet-cutout-256.avif 256w')
    expect(sources[0].srcset).toContain('red-packet-cutout-426.avif 426w')
    expect(sources[1].type).toBe('image/webp')
    expect(image?.src).toContain('red-packet-cutout-426.webp')
    expect(image?.getAttribute('width')).toBe('426')
    expect(image?.getAttribute('height')).toBe('420')
    expect(image?.getAttribute('loading')).toBe('eager')
    expect(image?.getAttribute('fetchpriority')).toBe('high')
  })

  it('lazy-loads decorative material photography by default', () => {
    const { container } = render(<NimDropsPhotograph variant="gold-foil" />)
    const image = container.querySelector('img')

    expect(image?.alt).toBe('')
    expect(image?.getAttribute('loading')).toBe('lazy')
    expect(image?.getAttribute('width')).toBe('1080')
    expect(image?.getAttribute('height')).toBe('540')
  })

  it('emits an AVIF preload with the same responsive candidates', () => {
    render(<NimDropsPhotographPreload variant="packet-cutout" />)
    const preload = document.head.querySelector<HTMLLinkElement>(
      'link[rel="preload"][href$="red-packet-cutout-426.avif"]',
    )

    expect(preload?.type).toBe('image/avif')
    expect(preload?.getAttribute('imagesrcset')).toContain(
      'red-packet-cutout-256.avif 256w',
    )
    expect(preload?.getAttribute('imagesizes')).toBe('(max-width: 480px) 256px, 426px')
  })
})
