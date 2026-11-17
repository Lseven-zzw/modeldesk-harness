import { useId } from 'react'

/** The ModelDesk mark used beside the ModelDesk product name. */
export function ModelDeskMark({ size, className }: { size: number; className?: string | undefined }) {
  const id = useId()
  return <svg className={className} data-modeldesk-mark width={size} height={size} viewBox="0 0 512 512"
    aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={id} x1="64" y1="64" x2="448" y2="448" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#72D5FA" /><stop offset="1" stopColor="#4F7DFF" />
      </linearGradient>
    </defs>
    <rect width="512" height="512" rx="112" fill="#0E0F12" />
    <g transform="translate(64 64) scale(.75)" fill="none"
      stroke={`url(#${id})`} strokeWidth="48" strokeLinecap="round" strokeLinejoin="round">
      <path d="M 72 328 V 160 L 164 246 L 256 128 L 348 246 L 440 160 V 328 M 72 384 H 440" />
    </g>
  </svg>
}

/** Wordmark shared by the sidebar and new conversation. */
export function ModelDeskName() {
  return <span data-modeldesk-name lang="en">ModelDesk</span>
}
