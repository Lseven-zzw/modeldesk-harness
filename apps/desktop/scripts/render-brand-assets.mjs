/** Render the ModelDesk Harness desktop and management-console artwork. */

import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const require = createRequire(join(APP_ROOT, 'package.json'))
const sharp = require('sharp')

export const MODELDESK_BG = '#0E0F12'
export const MODELDESK_TEXT = '#F2F3F5'
export const MODELDESK_TEXT_2 = '#A6ADB6'
const FONT = "'Microsoft YaHei','PingFang SC','Noto Sans CJK SC','Source Han Sans SC',sans-serif"

function defs(id = 'modeldesk-gradient') {
  return `<defs>
    <linearGradient id="${id}" x1="64" y1="64" x2="448" y2="448" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#72D5FA"/>
      <stop offset="1" stop-color="#4F7DFF"/>
    </linearGradient>
  </defs>`
}

/** An M shaped like two connected peaks above a desk. */
export function markFragment(gradientId = 'modeldesk-gradient') {
  return `<g fill="none" stroke="url(#${gradientId})" stroke-width="48" stroke-linecap="round" stroke-linejoin="round">
    <path d="M 72 328 V 160 L 164 246 L 256 128 L 348 246 L 440 160 V 328"/>
    <path d="M 72 384 H 440"/>
  </g>`
}

/** Place the 512-unit mark inside a box of `size` px centered on (cx, cy). */
function placed(cx, cy, size, gradientId = 'modeldesk-gradient') {
  // Visible geometry spans ~44..468 (424 units); scale by size/424 and center on (256,256).
  const scale = size / 424
  const tx = cx - 256 * scale
  const ty = cy - 256 * scale
  return `<g transform="translate(${round(tx)} ${round(ty)}) scale(${round(scale, 6)})">${markFragment(gradientId)}</g>`
}

function round(value, digits = 2) {
  return Number(value.toFixed(digits))
}

function svg(width, height, body, extra = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"${extra}>
${body.replace(/[ \t]+$/gm, '')}
</svg>
`
}

/** Square application tile: dark rounded background with the mark at ~60% height. */
function appIcon(withTrayGroup) {
  const body = `  <rect x="24" y="24" width="976" height="976" rx="216" fill="${MODELDESK_BG}"/>
  ${withTrayGroup ? '<g id="tray-glyph">' : ''}
    <g transform="translate(166.4 166.4) scale(1.35)">${markFragment()}</g>
  ${withTrayGroup ? '</g>' : ''}`
  return svg(1024, 1024, `${defs()}\n${body}`)
}

/** Wordmark lockup used by the Welcome window and installer dark theme. */
function lockup(width, height, options = {}) {
  const {
    background = null, radius = 0, markSize = 132, gap = 40,
    fontSize: requestedFontSize = 76, subtitle = false, textColor = MODELDESK_TEXT,
  } = options
  const fontSize = Math.min(requestedFontSize, (width - markSize - gap - 20) / 6.6)
  const nameWidth = fontSize * 6.6
  const subtitleWidth = subtitle ? fontSize * 3.8 : 0
  const textWidth = Math.max(nameWidth, subtitleWidth)
  const groupWidth = markSize + gap + textWidth
  const startX = (width - groupWidth) / 2
  const markCx = startX + markSize / 2
  const textX = startX + markSize + gap
  const baseline = height / 2 + fontSize * 0.35
  const bg = background === null ? '' : `  <rect width="${width}" height="${height}" rx="${radius}" fill="${background}"/>\n`
  const sub = subtitle
    ? `  <text x="${round(textX)}" y="${round(baseline + fontSize * 0.42)}" font-family="${FONT}" font-size="${round(fontSize * 0.22)}" letter-spacing="${round(fontSize * 0.055)}" fill="${MODELDESK_TEXT_2}">HARNESS</text>\n`
    : ''
  return svg(width, height, `${defs()}
${bg}${placed(markCx, height / 2, markSize)}
  <text x="${round(textX)}" y="${round(baseline)}" font-family="${FONT}" font-size="${fontSize}" font-weight="700" letter-spacing="${round(fontSize * 0.08)}" fill="${textColor}">ModelDesk</text>
${sub}`.trimEnd())
}

const SVG_FILES = {
  'docs/assets/modeldesk-mark.svg': svg(512, 512, `${defs()}
${markFragment()}`.trimEnd()),
  'docs/assets/modeldesk-logo-dark.svg': lockup(600, 196, { background: MODELDESK_BG, radius: 16 }),
  'docs/assets/modeldesk-logo-light.svg': svg(600, 196, `${defs()}
${placed(300, 98, 120)}`.trimEnd()),
  'apps/desktop/resources/icon.svg': appIcon(false),
  'apps/desktop/resources/icon-windows.svg': appIcon(true),
  'apps/desktop/resources/icon-macos.svg': appIcon(false),
  'apps/desktop/renderer/assets/welcome-brand.svg': lockup(300, 112, {
    background: MODELDESK_BG, radius: 16, markSize: 64, gap: 14, fontSize: 33, subtitle: true,
  }),
}

/** PNG outputs: [relative path, source SVG]. All keep transparent backgrounds. */
const PNG_FILES = [
  ['apps/desktop/resources/icon.png', SVG_FILES['apps/desktop/resources/icon.svg']],
  ['apps/desktop/resources/icon-windows.png', SVG_FILES['apps/desktop/resources/icon-windows.svg']],
  ['apps/desktop/resources/icon-macos.png', SVG_FILES['apps/desktop/resources/icon-macos.svg']],
  ['apps/desktop/installer/assets/brand.png', svg(600, 196, `${defs()}\n${placed(300, 98, 112)}`.trimEnd())],
  ['apps/desktop/installer/assets/brand-2x.png', svg(1200, 392, `${defs()}\n${placed(600, 196, 224)}`.trimEnd())],
  ['apps/desktop/installer/assets/brand-dark.png', lockup(600, 196, { markSize: 112, gap: 34, fontSize: 64 })],
  ['apps/desktop/installer/assets/brand-dark-2x.png', lockup(1200, 392, { markSize: 224, gap: 68, fontSize: 128 })],
  ['apps/desktop/installer/assets/uninstaller-sidebar.png', (() => {
    const markSize = 36, gap = 6, fontSize = 18
    const groupWidth = markSize + gap + fontSize * 6.6
    const startX = (164 - groupWidth) / 2
    return svg(164, 314, `${defs()}
${placed(startX + markSize / 2, 157, markSize)}
  <text x="${round(startX + markSize + gap)}" y="${round(157 + fontSize * 0.35)}" font-family="${FONT}" font-size="${fontSize}" font-weight="700" letter-spacing="${round(fontSize * 0.08)}" fill="${MODELDESK_TEXT}">ModelDesk</text>`.trimEnd())
  })()],
  ['server/admin/public/brand/modeldesk-logo.png', svg(512, 512, `\${defs()}\n\${markFragment()}`)],
  ['docs/assets/modeldesk-logo.png', lockup(268, 84, { markSize: 52, gap: 12, fontSize: 32, subtitle: true })],
  ['docs/assets/modeldesk-logo@2x.png', lockup(536, 168, { markSize: 104, gap: 24, fontSize: 64, subtitle: true })],
]

async function main() {
  for (const [relative, source] of Object.entries(SVG_FILES)) {
    const target = join(REPO_ROOT, relative)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, source, 'utf8')
  }
  for (const [relative, source] of PNG_FILES) {
    const target = join(REPO_ROOT, relative)
    await mkdir(dirname(target), { recursive: true })
    await sharp(Buffer.from(source)).png().toFile(target)
  }
  console.log(`brand assets: wrote ${Object.keys(SVG_FILES).length} SVG + ${PNG_FILES.length} PNG files`)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()
