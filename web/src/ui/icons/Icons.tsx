import { useId, type ReactNode, type SVGProps } from 'react'

export const ICON_GRID = 24
export const ICON_STROKE_WIDTH = 1.75

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  /** Accessible name for an icon used without adjacent visible text. */
  title?: string
  /** Rendered width and height. Defaults to the native 24px grid size. */
  size?: number | string
}

export type IconComponent = (props: IconProps) => ReactNode

interface IconBaseProps extends IconProps {
  children: ReactNode
}

/**
 * Shared geometry and accessibility contract for every NimDrops icon.
 *
 * Decorative icons are hidden from assistive technology. Supplying a title
 * promotes the SVG to a named image for standalone use.
 */
function IconBase({ title, size = ICON_GRID, children, ...svgProps }: IconBaseProps) {
  const titleId = useId()

  return (
    <svg
      {...svgProps}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox={`0 0 ${ICON_GRID} ${ICON_GRID}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      aria-hidden={title ? undefined : true}
      aria-labelledby={title ? titleId : undefined}
      role={title ? 'img' : undefined}
    >
      {title ? <title id={titleId}>{title}</title> : null}
      {children}
    </svg>
  )
}

/** NimDrops' envelope-and-seal mark, kept single-colour for host-wallet use. */
export function AppMarkIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3.25" y="5.5" width="17.5" height="13" rx="2.25" />
      <path d="m4.5 7 7.5 6 7.5-6" />
      <circle cx="12" cy="13" r="2.15" fill="currentColor" stroke="none" />
    </IconBase>
  )
}

export function EnvelopeSealedIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="6" width="18" height="12.5" rx="2.25" />
      <path d="m4.35 7.25 7.65 6 7.65-6M4.2 17.25l5.25-4.35M19.8 17.25l-5.25-4.35" />
      <circle cx="12" cy="13.25" r="1.65" />
    </IconBase>
  )
}

export function EnvelopeOpenIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 10.25 12 4.5l8 5.75" />
      <path d="M4 10.25v8.15c0 .88.72 1.6 1.6 1.6h12.8c.88 0 1.6-.72 1.6-1.6v-8.15" />
      <path d="m4.5 18.9 6.25-5.15a1.95 1.95 0 0 1 2.5 0l6.25 5.15M4.45 10.7l5.15 4.2M19.55 10.7l-5.15 4.2" />
    </IconBase>
  )
}

export function WaxSealIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M11.3 3.5c1.7-.3 2.7 1.3 4.05 1.2 1.55-.15 3.05-.4 3.5 1.25.4 1.5-.65 2.45.25 3.7 1.05 1.4 1.9 2.6.65 3.95-1 1.1-2.4 1.1-2.65 2.6-.25 1.55.2 3.05-1.45 3.35-1.2.25-1.8-.75-2.85.15l-1.15 1c-.8.75-1.5-1.05-2.75-1.3-1.6-.3-3.05.35-3.75-1.2-.65-1.45.3-2.45-.6-3.7-1-1.35-1.75-2.65-.65-3.95 1-1.15 1.8-1.55 1.4-2.95-.45-1.5.25-2.7 1.85-2.75 1.45-.05 2.5-1.05 4.15-1.35Z" />
      <rect x="8" y="9.25" width="8" height="5.5" rx="1" />
      <path d="m8.8 10.3 3.2 2.45 3.2-2.45" />
    </IconBase>
  )
}

/** An incoming share entering the open envelope: receiving a drop. */
export function ClaimIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 3.5v9m-3.5-3.25 3.5 3.5 3.5-3.5" />
      <path d="M4 11.25v7.15c0 .88.72 1.6 1.6 1.6h12.8c.88 0 1.6-.72 1.6-1.6v-7.15" />
      <path d="m4.5 18.9 6.25-5.15a1.95 1.95 0 0 1 2.5 0l6.25 5.15M4.45 11.7l5.15 3.2M19.55 11.7l-5.15 3.2" />
    </IconBase>
  )
}

export function ShareIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 15.75V3.5m0 0L7.75 7.75M12 3.5l4.25 4.25" />
      <path d="M6.25 11.25H5.5A2.5 2.5 0 0 0 3 13.75v4.5a2.5 2.5 0 0 0 2.5 2.5h13a2.5 2.5 0 0 0 2.5-2.5v-4.5a2.5 2.5 0 0 0-2.5-2.5h-.75" />
    </IconBase>
  )
}

export function CopyIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="8" y="7.75" width="12" height="12.25" rx="2" />
      <path d="M16 7.75V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </IconBase>
  )
}

export function QrCodeIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 9V4h5M15 4h5v5M9 20H4v-5" />
      <rect x="6" y="6" width="1" height="1" fill="currentColor" stroke="none" />
      <rect x="17" y="6" width="1" height="1" fill="currentColor" stroke="none" />
      <rect x="6" y="17" width="1" height="1" fill="currentColor" stroke="none" />
      <path d="M13.5 12.5h2v2h-2zM18 12.5h2v2h-2zM13.5 17h2v3h-2zM18 17h2v3h-2z" fill="currentColor" stroke="none" />
    </IconBase>
  )
}

export function WalletIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M5.75 5.25h10.5a2 2 0 0 1 2 2v1.5" />
      <path d="M5.5 7.75h12.75A2.75 2.75 0 0 1 21 10.5v7A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5V8.25a3 3 0 0 1 3-3" />
      <path d="M15.25 11.25H21v4.5h-5.75a2.25 2.25 0 0 1 0-4.5Z" />
      <circle cx="15.5" cy="13.5" r=".75" fill="currentColor" stroke="none" />
    </IconBase>
  )
}

export function ClockExpiryIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12.25" r="8.5" />
      <path d="M12 7.25v5l3.35 2M7 2.75l-2.5 2.5M17 2.75l2.5 2.5" />
    </IconBase>
  )
}

/** A return arrow entering the envelope where unclaimed NIM goes back. */
export function RefundReturnIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M9 6H5m0 0 2.5-2.5M5 6h9a5 5 0 0 1 5 5" />
      <path d="M4 12.75h16v5.5A1.75 1.75 0 0 1 18.25 20H5.75A1.75 1.75 0 0 1 4 18.25v-5.5Z" />
      <path d="m5 13.5 7 4.5 7-4.5" />
    </IconBase>
  )
}

export function CustodyShieldIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 3.25 19 6v5.35c0 4.45-2.9 7.62-7 9.4-4.1-1.78-7-4.95-7-9.4V6l7-2.75Z" />
      <rect x="9.15" y="10.75" width="5.7" height="4.75" rx="1.15" />
      <path d="M10.4 10.75V9.5a1.6 1.6 0 0 1 3.2 0v1.25" />
    </IconBase>
  )
}

export function WarningIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M10.28 4.3 2.9 17.1A2 2 0 0 0 4.64 20h14.72a2 2 0 0 0 1.74-2.9L13.72 4.3a2 2 0 0 0-3.44 0Z" />
      <path d="M12 9v4.25" />
      <circle cx="12" cy="16.5" r=".8" fill="currentColor" stroke="none" />
    </IconBase>
  )
}

export function SuccessCheckIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.1 12.2 2.55 2.55 5.45-5.5" />
    </IconBase>
  )
}

export function ErrorIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m9 9 6 6m0-6-6 6" />
    </IconBase>
  )
}

export function InfoIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="8.25" r=".85" fill="currentColor" stroke="none" />
      <path d="M12 11.25v5" />
    </IconBase>
  )
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m9 5.5 6.5 6.5L9 18.5" />
    </IconBase>
  )
}

export function CloseIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m6.25 6.25 11.5 11.5m0-11.5-11.5 11.5" />
    </IconBase>
  )
}

export function QuestionMarkIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.65 9.2a2.55 2.55 0 1 1 3.1 2.48c-.5.13-.75.53-.75 1.02v.8" />
      <circle cx="12" cy="16.55" r=".8" fill="currentColor" stroke="none" />
    </IconBase>
  )
}
