import { describe, expect, it } from 'vitest'
import { canonicalDropUrl, dropShareData, shareOrCopy } from './share'

describe('drop distribution', () => {
  it('builds a canonical link without carrying query strings or fragments', () => {
    expect(canonicalDropUrl('Ab3Cd4Ef5Gh6Ij7Kl8Mn9O', 'https://nimdrops.example/')).toBe(
      'https://nimdrops.example/drop/Ab3Cd4Ef5Gh6Ij7Kl8Mn9O',
    )
  })

  it('puts the useful context in text because chat apps may omit the title', () => {
    expect(
      dropShareData({
        url: 'https://nimdrops.example/drop/Ab3Cd4Ef5Gh6Ij7Kl8Mn9O',
        amount: '2',
      }),
    ).toEqual({
      title: 'A NimDrop for you',
      text: 'A fixed 2 NIM share is waiting. First come, one per wallet.',
      url: 'https://nimdrops.example/drop/Ab3Cd4Ef5Gh6Ij7Kl8Mn9O',
    })
  })

  it('copies the link when an exposed share sheet fails to open', async () => {
    const written: string[] = []
    const result = await shareOrCopy(
      dropShareData({ url: 'https://nimdrops.example/drop/abc', amount: '2' }),
      {
        share: async () => {
          throw new DOMException('not available here', 'NotAllowedError')
        },
        clipboard: { writeText: async (text) => void written.push(text) },
      },
    )
    expect(result).toBe('copied')
    expect(written).toEqual(['https://nimdrops.example/drop/abc'])
  })

  it('treats dismissing the share sheet as a choice and does not copy', async () => {
    let copied = false
    const result = await shareOrCopy(
      dropShareData({ url: 'https://nimdrops.example/drop/abc', amount: '2' }),
      {
        share: async () => {
          throw new DOMException('cancelled', 'AbortError')
        },
        clipboard: { writeText: async () => void (copied = true) },
      },
    )
    expect(result).toBe('dismissed')
    expect(copied).toBe(false)
  })
})
