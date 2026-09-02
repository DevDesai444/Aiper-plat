/**
 * Generates self-contained SVG data URIs for the Insert tab's drawing commands.
 *
 * These go into the document as ordinary image nodes, which means shapes, charts and
 * diagrams travel through save/open and the docx export path exactly like a pasted picture —
 * no new node type, no new export branch, and nothing that only renders inside Aiper.
 */

const svgToDataUri = (svg: string): string =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace(/\s+/g, ' ').trim())}`

/**
 * Converts a generated SVG to a PNG data URI before it goes into the document.
 *
 * The docx export path writes image bytes straight into the package, and Word will not
 * render an inline SVG the way the editor does. Rasterising here means one image format
 * reaches every consumer — editor, PDF and .docx — instead of looking right on screen and
 * arriving broken in the file that gets submitted. Falls back to the SVG if the browser
 * cannot decode it, which at worst preserves today's behaviour.
 */
export function rasterize(svgDataUri: string, scale = 2): Promise<string> {
  return new Promise((resolve) => {
    const img = new window.Image()
    img.onload = (): void => {
      const canvas = document.createElement('canvas')
      canvas.width = (img.naturalWidth || img.width) * scale
      canvas.height = (img.naturalHeight || img.height) * scale
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve(svgDataUri)
        return
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      try {
        resolve(canvas.toDataURL('image/png'))
      } catch {
        resolve(svgDataUri)
      }
    }
    img.onerror = (): void => resolve(svgDataUri)
    img.src = svgDataUri
  })
}

export type ShapeKind = 'rectangle' | 'rounded' | 'ellipse' | 'triangle' | 'arrow' | 'line' | 'star'

export const SHAPE_KINDS: ShapeKind[] = ['rectangle', 'rounded', 'ellipse', 'triangle', 'arrow', 'line', 'star']

export function shapeSvg(kind: ShapeKind, accent: string): string {
  const body = {
    rectangle: '<rect x="8" y="8" width="204" height="104" />',
    rounded: '<rect x="8" y="8" width="204" height="104" rx="16" />',
    ellipse: '<ellipse cx="110" cy="60" rx="102" ry="52" />',
    triangle: '<polygon points="110,10 210,110 10,110" />',
    arrow: '<polygon points="10,44 130,44 130,16 210,60 130,104 130,76 10,76" />',
    line: `<line x1="10" y1="60" x2="210" y2="60" stroke="${accent}" stroke-width="3" />`,
    star: '<polygon points="110,10 133,52 180,60 146,92 154,138 110,116 66,138 74,92 40,60 87,52" />'
  }[kind]

  return svgToDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="120" viewBox="0 0 220 120">
       <g fill="${accent}22" stroke="${accent}" stroke-width="2">${body}</g>
     </svg>`
  )
}

export type IconKind = 'check' | 'warning' | 'info' | 'flask' | 'shield' | 'document' | 'clock'

export const ICON_KINDS: IconKind[] = ['check', 'warning', 'info', 'flask', 'shield', 'document', 'clock']

export function iconSvg(kind: IconKind, accent: string): string {
  const paths: Record<IconKind, string> = {
    check: '<path d="M5 13l4 4L19 7" />',
    warning: '<path d="M12 3l9 16H3z" /><path d="M12 10v4" /><path d="M12 17h.01" />',
    info: '<circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" />',
    flask: '<path d="M9 3v6l-5 9a2 2 0 002 3h12a2 2 0 002-3l-5-9V3" /><path d="M8 3h8" />',
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />',
    document: '<path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" />',
    clock: '<circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />'
  }
  return svgToDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24"
          fill="none" stroke="${accent}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
       ${paths[kind]}
     </svg>`
  )
}

export interface ChartPoint {
  label: string
  value: number
}

export type ChartKind = 'bar' | 'column' | 'line' | 'pie'

/** Renders a small labelled chart. Values are the caller's — nothing is invented here. */
export function chartSvg(kind: ChartKind, points: ChartPoint[], accent: string, title: string): string {
  const w = 420
  const h = 240
  const pad = { top: title ? 30 : 12, right: 12, bottom: 34, left: 40 }
  const plotW = w - pad.left - pad.right
  const plotH = h - pad.top - pad.bottom
  const max = Math.max(...points.map((p) => p.value), 1)
  const heading = title
    ? `<text x="${w / 2}" y="18" text-anchor="middle" font-family="sans-serif" font-size="13" fill="#333">${escapeXml(title)}</text>`
    : ''

  if (kind === 'pie') {
    const total = points.reduce((s, p) => s + p.value, 0) || 1
    let angle = -Math.PI / 2
    const cx = 120
    const cy = pad.top + plotH / 2
    const r = Math.min(plotH, 200) / 2
    const slices = points
      .map((p, i) => {
        const sweep = (p.value / total) * Math.PI * 2
        const x1 = cx + r * Math.cos(angle)
        const y1 = cy + r * Math.sin(angle)
        angle += sweep
        const x2 = cx + r * Math.cos(angle)
        const y2 = cy + r * Math.sin(angle)
        const large = sweep > Math.PI ? 1 : 0
        return `<path d="M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${large} 1 ${x2.toFixed(1)},${y2.toFixed(1)} Z" fill="${shade(accent, i)}" stroke="#fff" stroke-width="1" />`
      })
      .join('')
    const legend = points
      .map(
        (p, i) =>
          `<rect x="250" y="${pad.top + i * 20}" width="10" height="10" fill="${shade(accent, i)}" />
           <text x="266" y="${pad.top + i * 20 + 9}" font-family="sans-serif" font-size="11" fill="#333">${escapeXml(p.label)} — ${p.value}</text>`
      )
      .join('')
    return svgToDataUri(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${heading}${slices}${legend}</svg>`
    )
  }

  if (kind === 'line') {
    const step = points.length > 1 ? plotW / (points.length - 1) : 0
    const coords = points.map((p, i) => [pad.left + i * step, pad.top + plotH - (p.value / max) * plotH] as const)
    const path = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
    const dots = coords.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${accent}" />`).join('')
    const labels = points
      .map((p, i) => `<text x="${(pad.left + i * step).toFixed(1)}" y="${h - 14}" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#666">${escapeXml(p.label)}</text>`)
      .join('')
    return svgToDataUri(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
         ${heading}${axes(pad, plotW, plotH, max)}
         <path d="${path}" fill="none" stroke="${accent}" stroke-width="2" />${dots}${labels}
       </svg>`
    )
  }

  // bar (horizontal) and column (vertical)
  if (kind === 'bar') {
    const band = plotH / points.length
    const bars = points
      .map((p, i) => {
        const barW = (p.value / max) * plotW
        const y = pad.top + i * band + band * 0.2
        return `<rect x="${pad.left}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${(band * 0.6).toFixed(1)}" fill="${accent}" />
                <text x="${(pad.left + barW + 6).toFixed(1)}" y="${(y + band * 0.42).toFixed(1)}" font-family="sans-serif" font-size="10" fill="#333">${p.value}</text>
                <text x="${pad.left - 6}" y="${(y + band * 0.42).toFixed(1)}" text-anchor="end" font-family="sans-serif" font-size="10" fill="#666">${escapeXml(p.label)}</text>`
      })
      .join('')
    return svgToDataUri(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${heading}${bars}</svg>`
    )
  }

  const band = plotW / points.length
  const cols = points
    .map((p, i) => {
      const barH = (p.value / max) * plotH
      const x = pad.left + i * band + band * 0.2
      const y = pad.top + plotH - barH
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(band * 0.6).toFixed(1)}" height="${barH.toFixed(1)}" fill="${accent}" />
              <text x="${(x + band * 0.3).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#333">${p.value}</text>
              <text x="${(x + band * 0.3).toFixed(1)}" y="${h - 14}" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#666">${escapeXml(p.label)}</text>`
    })
    .join('')
  return svgToDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
       ${heading}${axes(pad, plotW, plotH, max)}${cols}
     </svg>`
  )
}

export type SmartArtKind = 'process' | 'list' | 'cycle' | 'hierarchy'

export const SMARTART_KINDS: SmartArtKind[] = ['process', 'list', 'cycle', 'hierarchy']

/** Lays the given steps out as a diagram. */
export function smartArtSvg(kind: SmartArtKind, steps: string[], accent: string): string {
  const w = 460
  const items = steps.slice(0, 6)

  if (kind === 'list') {
    const h = 24 + items.length * 40
    const rows = items
      .map(
        (s, i) =>
          `<rect x="10" y="${14 + i * 40}" width="440" height="32" rx="4" fill="${accent}18" stroke="${accent}" stroke-width="1" />
           <text x="24" y="${34 + i * 40}" font-family="sans-serif" font-size="12" fill="#222">${escapeXml(s)}</text>`
      )
      .join('')
    return svgToDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${rows}</svg>`)
  }

  if (kind === 'cycle') {
    const h = 300
    const cx = w / 2
    const cy = h / 2
    const r = 105
    const nodes = items
      .map((s, i) => {
        const a = (i / items.length) * Math.PI * 2 - Math.PI / 2
        const x = cx + r * Math.cos(a)
        const y = cy + r * Math.sin(a)
        return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="42" fill="${accent}20" stroke="${accent}" stroke-width="1.5" />
                <text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#222">${escapeXml(truncate(s, 12))}</text>`
      })
      .join('')
    return svgToDataUri(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
         <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${accent}55" stroke-width="1.5" stroke-dasharray="5 5" />${nodes}
       </svg>`
    )
  }

  if (kind === 'hierarchy') {
    const h = 220
    const [root, ...children] = items
    const childW = children.length ? (w - 40) / children.length : 0
    const kids = children
      .map((s, i) => {
        const x = 20 + i * childW + childW / 2
        return `<line x1="${w / 2}" y1="76" x2="${x.toFixed(1)}" y2="130" stroke="${accent}" stroke-width="1.5" />
                <rect x="${(x - childW / 2 + 8).toFixed(1)}" y="130" width="${Math.max(childW - 16, 40).toFixed(1)}" height="46" rx="4" fill="${accent}18" stroke="${accent}" stroke-width="1" />
                <text x="${x.toFixed(1)}" y="${158}" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#222">${escapeXml(truncate(s, 14))}</text>`
      })
      .join('')
    return svgToDataUri(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
         <rect x="${w / 2 - 90}" y="30" width="180" height="46" rx="4" fill="${accent}30" stroke="${accent}" stroke-width="1.5" />
         <text x="${w / 2}" y="58" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#222">${escapeXml(truncate(root ?? '', 22))}</text>
         ${kids}
       </svg>`
    )
  }

  // process — chevrons left to right
  const h = 110
  const boxW = (w - 20) / Math.max(items.length, 1)
  const chevrons = items
    .map((s, i) => {
      const x = 10 + i * boxW
      const tip = 12
      const pts = `${x},30 ${x + boxW - tip - 4},30 ${x + boxW - 4},55 ${x + boxW - tip - 4},80 ${x},80 ${x + tip},55`
      return `<polygon points="${pts}" fill="${accent}22" stroke="${accent}" stroke-width="1.4" />
              <text x="${(x + boxW / 2).toFixed(1)}" y="59" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#222">${escapeXml(truncate(s, 14))}</text>`
    })
    .join('')
  return svgToDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${chevrons}</svg>`)
}

/** Big display lettering, inserted as a picture so it keeps its look everywhere. */
export function wordArtSvg(text: string, accent: string): string {
  const width = Math.max(160, text.length * 26)
  return svgToDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="72" viewBox="0 0 ${width} 72">
       <defs>
         <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
           <stop offset="0%" stop-color="${accent}" />
           <stop offset="100%" stop-color="${shade(accent, 2)}" />
         </linearGradient>
       </defs>
       <text x="${width / 2}" y="52" text-anchor="middle" font-family="Georgia, serif" font-size="44"
             font-weight="bold" fill="url(#g)" stroke="${accent}" stroke-width="0.6">${escapeXml(text)}</text>
     </svg>`
  )
}

function axes(
  pad: { top: number; right: number; bottom: number; left: number },
  plotW: number,
  plotH: number,
  max: number
): string {
  return `<line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}" stroke="#ccc" />
          <line x1="${pad.left}" y1="${pad.top + plotH}" x2="${pad.left + plotW}" y2="${pad.top + plotH}" stroke="#ccc" />
          <text x="${pad.left - 6}" y="${pad.top + 8}" text-anchor="end" font-family="sans-serif" font-size="9" fill="#999">${max}</text>`
}

/** Rotate the hue of the accent so multi-series charts stay distinguishable. */
function shade(hex: string, i: number): string {
  const n = parseInt(hex.slice(1), 16)
  const shift = (i * 47) % 200
  const r = Math.min(255, ((n >> 16) & 255) + shift - 60)
  const g = Math.min(255, ((n >> 8) & 255) + ((shift * 3) % 120) - 40)
  const b = Math.min(255, (n & 255) + ((shift * 7) % 150) - 50)
  const clamp = (v: number): number => Math.max(30, Math.min(230, v))
  return `#${((clamp(r) << 16) | (clamp(g) << 8) | clamp(b)).toString(16).padStart(6, '0')}`
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] as string)
}
