/**
 * Colour maths for the contrast tests, in one place.
 *
 * This was inline in `surface.contrast.test.ts` until a second surface needed
 * the same derivation. It is pure sRGB arithmetic with no opinion about where
 * the colours came from: `surface.contrast.test.ts` reads them out of
 * `index.css`, `pages/design/reveal.contrast.test.ts` reads them out of a
 * `Palette`'s own CSS, and both then composite and measure the same way.
 *
 * Nothing here reads a rendered pixel, on purpose. The field MOVES, so a ratio
 * measured against one frame of it is a ratio measured against a coincidence.
 * The callers derive the brightest the field can physically be and measure
 * against that, which is pessimistic, which is the correct direction to be
 * wrong in on a screen that hands out money.
 */

export type Rgb = [number, number, number]

/** `#rrggbb`, `rgb(r g b / a)` or `rgba(r, g, b, a)`. Alpha comes back separately. */
export function parseColour(value: string): { rgb: Rgb; alpha: number } {
  const hex = value.trim().match(/^#([0-9a-f]{6})$/i)
  if (hex) {
    const h = hex[1]
    return { rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb, alpha: 1 }
  }
  const fn = value.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[/,]\s*([\d.]+))?\s*\)/)
  if (!fn) throw new Error(`cannot parse colour ${value}`)
  return {
    rgb: [Number(fn[1]), Number(fn[2]), Number(fn[3])] as Rgb,
    alpha: fn[4] === undefined ? 1 : Number(fn[4]),
  }
}

/** Source-over: `fg` at `alpha` composited onto `bg`. */
export function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return fg.map((c, i) => c * alpha + bg[i] * (1 - alpha)) as Rgb
}

/**
 * `filter: saturate()`'s matrix, in sRGB, which is the space CSS filter
 * shorthand functions operate in. Clamped, because it can push a channel out of
 * gamut and the compositor clamps too.
 */
export function saturate(rgb: Rgb, s: number): Rgb {
  const [r, g, b] = rgb.map((c) => c / 255) as Rgb
  const rows = [
    [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s],
  ]
  return rows.map(
    (row) => Math.min(1, Math.max(0, row[0] * r + row[1] * g + row[2] * b)) * 255,
  ) as Rgb
}

export function relativeLuminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => {
    const x = c / 255
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2.x contrast ratio. Order does not matter. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

export const round2 = (n: number) => Math.round(n * 100) / 100
