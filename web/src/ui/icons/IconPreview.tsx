import {
  AppMarkIcon,
  ChevronRightIcon,
  ClaimIcon,
  ClockExpiryIcon,
  CloseIcon,
  CopyIcon,
  CustodyShieldIcon,
  EnvelopeOpenIcon,
  EnvelopeSealedIcon,
  ErrorIcon,
  InfoIcon,
  QrCodeIcon,
  QuestionMarkIcon,
  RefundReturnIcon,
  ShareIcon,
  SuccessCheckIcon,
  WalletIcon,
  WarningIcon,
  WaxSealIcon,
  type IconComponent,
} from './Icons'

const ICONS: ReadonlyArray<readonly [name: string, Icon: IconComponent]> = [
  ['App mark', AppMarkIcon],
  ['Envelope sealed', EnvelopeSealedIcon],
  ['Envelope open', EnvelopeOpenIcon],
  ['Wax seal', WaxSealIcon],
  ['Claim / open', ClaimIcon],
  ['Share', ShareIcon],
  ['Copy', CopyIcon],
  ['QR code', QrCodeIcon],
  ['Wallet', WalletIcon],
  ['Clock / expiry', ClockExpiryIcon],
  ['Refund / return', RefundReturnIcon],
  ['Custody shield', CustodyShieldIcon],
  ['Warning', WarningIcon],
  ['Success check', SuccessCheckIcon],
  ['Error', ErrorIcon],
  ['Info', InfoIcon],
  ['Chevron right', ChevronRightIcon],
  ['Close', CloseIcon],
  ['Question mark', QuestionMarkIcon],
]

const SIZES = [16, 20, 24, 32] as const

interface SurfaceProps {
  Icon: IconComponent
  iconName: string
  tone: 'plate' | 'ink'
}

function Surface({ Icon, iconName, tone }: SurfaceProps) {
  const onInk = tone === 'ink'

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, minmax(2.5rem, 1fr))',
        alignItems: 'end',
        gap: '0.5rem',
        borderRadius: '0.5rem',
        padding: '0.75rem',
        color: onInk ? 'var(--color-plate)' : 'var(--color-ink)',
        background: onInk ? 'var(--color-ink)' : 'var(--color-plate)',
      }}
    >
      {SIZES.map((size) => (
        <div
          key={size}
          style={{
            display: 'grid',
            justifyItems: 'center',
            gap: '0.4rem',
            minWidth: 0,
          }}
        >
          <Icon size={size} title={`${iconName}, ${size} pixels, on ${tone}`} />
          <span style={{ fontSize: '0.6875rem', lineHeight: 1, opacity: 0.7 }}>{size}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * Development-only visual inventory. It is intentionally not mounted by any
 * production screen; import it into an isolated design route or Storybook-like
 * harness when reviewing the icon set.
 */
export function IconPreview() {
  return (
    <section
      aria-labelledby="nimdrops-icon-preview-title"
      style={{
        padding: '1.5rem',
        color: 'var(--color-ink)',
        background: 'var(--color-plate)',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <h1
        id="nimdrops-icon-preview-title"
        style={{ margin: '0 0 1.5rem', fontSize: '1.25rem', lineHeight: 1.2 }}
      >
        NimDrops icon inventory
      </h1>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 18rem), 1fr))',
          gap: '1rem',
        }}
      >
        {ICONS.map(([name, Icon]) => (
          <article key={name} style={{ display: 'grid', gap: '0.5rem' }}>
            <h2 style={{ margin: 0, fontSize: '0.8125rem', fontWeight: 650 }}>{name}</h2>
            <Surface Icon={Icon} iconName={name} tone="plate" />
            <Surface Icon={Icon} iconName={name} tone="ink" />
          </article>
        ))}
      </div>
    </section>
  )
}

export default IconPreview
