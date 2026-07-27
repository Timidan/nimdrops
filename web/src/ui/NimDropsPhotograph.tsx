import type { CSSProperties } from 'react'
import './NimDropsPhotograph.css'

export type NimDropsPhotographVariant =
  | 'packet-cutout'
  | 'packet-photo'
  | 'foil-seal'
  | 'red-paper'
  | 'gold-foil'

interface AssetVariant {
  alt: string
  width: number
  height: number
  sizes: string
  avif: readonly [string, number][]
  webp: readonly [string, number][]
}

const ROOT = '/images/nimdrops'

const ASSETS: Record<NimDropsPhotographVariant, AssetVariant> = {
  'packet-cutout': {
    alt: 'A photographed red paper packet with a gold foil seal',
    width: 426,
    height: 420,
    sizes: '(max-width: 480px) 256px, 426px',
    avif: [
      [`${ROOT}/red-packet-cutout-256.avif`, 256],
      [`${ROOT}/red-packet-cutout-426.avif`, 426],
    ],
    webp: [
      [`${ROOT}/red-packet-cutout-256.webp`, 256],
      [`${ROOT}/red-packet-cutout-426.webp`, 426],
    ],
  },
  'packet-photo': {
    alt: 'A real red envelope with a reflective gold foil emblem',
    width: 426,
    height: 640,
    sizes: '(max-width: 480px) 213px, 426px',
    avif: [
      [`${ROOT}/red-packet-photo-213.avif`, 213],
      [`${ROOT}/red-packet-photo-426.avif`, 426],
    ],
    webp: [
      [`${ROOT}/red-packet-photo-213.webp`, 213],
      [`${ROOT}/red-packet-photo-426.webp`, 426],
    ],
  },
  'foil-seal': {
    alt: 'A photographed circular gold foil seal',
    width: 256,
    height: 256,
    sizes: '(max-width: 480px) 128px, 256px',
    avif: [
      [`${ROOT}/foil-seal-128.avif`, 128],
      [`${ROOT}/foil-seal-256.avif`, 256],
    ],
    webp: [
      [`${ROOT}/foil-seal-128.webp`, 128],
      [`${ROOT}/foil-seal-256.webp`, 256],
    ],
  },
  'red-paper': {
    alt: '',
    width: 512,
    height: 512,
    sizes: '(max-width: 480px) 256px, 512px',
    avif: [
      [`${ROOT}/red-paper-texture-256.avif`, 256],
      [`${ROOT}/red-paper-texture-512.avif`, 512],
    ],
    webp: [
      [`${ROOT}/red-paper-texture-256.webp`, 256],
      [`${ROOT}/red-paper-texture-512.webp`, 512],
    ],
  },
  'gold-foil': {
    alt: '',
    width: 1080,
    height: 540,
    sizes: '(max-width: 600px) 540px, 1080px',
    avif: [
      [`${ROOT}/gold-foil-texture-540.avif`, 540],
      [`${ROOT}/gold-foil-texture-1080.avif`, 1080],
    ],
    webp: [
      [`${ROOT}/gold-foil-texture-540.webp`, 540],
      [`${ROOT}/gold-foil-texture-1080.webp`, 1080],
    ],
  },
}

function srcSet(entries: readonly [string, number][]): string {
  return entries.map(([url, width]) => `${url} ${width}w`).join(', ')
}

export interface NimDropsPhotographProps {
  variant?: NimDropsPhotographVariant
  alt?: string
  className?: string
  sizes?: string
  priority?: boolean
  style?: CSSProperties
}

/**
 * A self-hosted, responsive photograph with an AVIF source and WebP fallback.
 *
 * Use `priority` only for the one image visible above the fold. All other
 * variants lazy-load by default. The rendered dimensions reserve layout space
 * before either format decodes.
 */
export default function NimDropsPhotograph({
  variant = 'packet-cutout',
  alt,
  className,
  sizes,
  priority = false,
  style,
}: NimDropsPhotographProps) {
  const asset = ASSETS[variant]
  const resolvedSizes = sizes ?? asset.sizes
  const classes = ['nd-photograph', className].filter(Boolean).join(' ')
  const fallback = asset.webp.at(-1)![0]

  return (
    <span className={classes} data-variant={variant} style={style}>
      <picture>
        <source
          type="image/avif"
          srcSet={srcSet(asset.avif)}
          sizes={resolvedSizes}
        />
        <source
          type="image/webp"
          srcSet={srcSet(asset.webp)}
          sizes={resolvedSizes}
        />
        <img
          src={fallback}
          srcSet={srcSet(asset.webp)}
          sizes={resolvedSizes}
          alt={alt ?? asset.alt}
          width={asset.width}
          height={asset.height}
          loading={priority ? 'eager' : 'lazy'}
          fetchPriority={priority ? 'high' : 'auto'}
          decoding="async"
        />
      </picture>
    </span>
  )
}

export interface NimDropsPhotographPreloadProps {
  variant?: NimDropsPhotographVariant
  sizes?: string
}

/** Preload the AVIF candidate set used by an above-the-fold photograph. */
export function NimDropsPhotographPreload({
  variant = 'packet-cutout',
  sizes,
}: NimDropsPhotographPreloadProps) {
  const asset = ASSETS[variant]

  return (
    <link
      rel="preload"
      as="image"
      type="image/avif"
      href={asset.avif.at(-1)![0]}
      imageSrcSet={srcSet(asset.avif)}
      imageSizes={sizes ?? asset.sizes}
      fetchPriority="high"
    />
  )
}
