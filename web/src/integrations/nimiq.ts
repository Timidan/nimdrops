export interface NimiqEcosystemLink {
  href: string
  label: string
}

export const NIMIQ_ECOSYSTEM_LINKS = {
  spend: {
    href: 'https://map.nimiq.com/',
    label: 'Find places to spend NIM',
  },
  sell: {
    href: 'https://www.nimiq.com/buy-and-sell/',
    label: 'See ways to sell NIM',
  },
} as const satisfies Record<'spend' | 'sell', NimiqEcosystemLink>
