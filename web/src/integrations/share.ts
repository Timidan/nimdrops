export function canonicalDropUrl(
  publicId: string,
  origin: string = typeof window === 'undefined' ? '' : window.location.origin,
): string {
  return `${origin.replace(/\/+$/, '')}/drop/${encodeURIComponent(publicId)}`
}

export function dropShareData({ url, amount }: { url: string; amount?: string }): ShareData {
  return {
    title: 'A NimDrop for you',
    text: amount
      ? `A fixed ${amount} NIM share is waiting. First come, one per wallet.`
      : 'A fixed share of NIM is waiting. First come, one per wallet.',
    url,
  }
}

export function appShareData(origin: string): ShareData {
  return {
    title: 'NimDrops',
    text: 'Send one link with a fixed share of NIM for each recipient.',
    url: origin.replace(/\/+$/, ''),
  }
}

export type ShareResult = 'shared' | 'copied' | 'dismissed' | 'failed'

export interface ShareNavigator {
  share?: (data?: ShareData) => Promise<void>
  clipboard?: { writeText: (text: string) => Promise<void> }
}

export async function shareOrCopy(
  data: ShareData,
  host: ShareNavigator | undefined = typeof navigator === 'undefined' ? undefined : navigator,
): Promise<ShareResult> {
  if (!host) return 'failed'

  if (host.share) {
    try {
      await host.share(data)
      return 'shared'
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'dismissed'
    }
  }

  const text = data.url || data.text
  if (!text || !host.clipboard) return 'failed'
  try {
    await host.clipboard.writeText(text)
    return 'copied'
  } catch {
    return 'failed'
  }
}
