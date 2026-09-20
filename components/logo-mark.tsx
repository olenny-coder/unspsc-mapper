/**
 * Brand mark.
 *
 * The geometry lives in `public/icon.svg` (a rounded container with three
 * ascending rounded bars — spend rolled up and classified), and this component
 * renders the same shape inline so the header mark inherits the theme and needs
 * no network request.
 *
 * Keep this in sync with `public/icon.svg` and `scripts/generate-icons.mjs`; all
 * three are generated from the same description, and the raster assets are
 * produced by that script rather than drawn by hand.
 */
export function LogoMark({ className, gradientId = 'logo-mark-gradient' }: { className?: string; gradientId?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      role="img"
      aria-label="UNSPSC Spend Categorizer"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#3b82f6" />
          <stop offset="100%" stopColor="#1d4ed8" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill={`url(#${gradientId})`} />
      <g fill="#ffffff">
        <rect x="14" y="34" width="9" height="17" rx="4.5" />
        <rect x="27.5" y="26" width="9" height="25" rx="4.5" />
      </g>
      <rect x="41" y="16" width="9" height="35" rx="4.5" fill="#bfdbfe" />
    </svg>
  );
}
