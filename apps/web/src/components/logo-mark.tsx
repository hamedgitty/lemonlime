// Drawn by brand/build.py. Don't edit by hand: change the script and run it again.

/** The LemonLime mark: one citrus slice, lemon on the left and lime on the right. Sizes up to 40 px use a bolder drawing. */
export function LogoMark({ size = 24, className = "" }: { size?: number; className?: string }) {
  const small = size <= 40;
  const [w, h] = small ? [492, 492] : [480, 480];
  return (
    <svg aria-hidden="true" focusable="false" viewBox={`0 0 ${w} ${h}`} width={(size * w) / h} height={size} className={`shrink-0 ${className}`}>
      {small ? (
        <g transform="translate(-10.000 -10.000) scale(1)"><path d="M10 256A246 246 0 1 1 502 256A246 246 0 1 1 10 256Z" fill="#7CC81E" /><path d="M256 502A246 246 0 0 1 256 10Z" fill="#FFD60A" /><path d="M54 256A202 202 0 1 1 458 256A202 202 0 1 1 54 256Z" fill="#FFFBEA" /><path d="M226.00 328.43L226.00 419.27A166 166 0 0 1 161.77 392.66ZM183.57 286.00L119.34 350.23A166 166 0 0 1 92.73 286.00ZM183.57 226.00L92.73 226.00A166 166 0 0 1 119.34 161.77ZM226.00 183.57L161.77 119.34A166 166 0 0 1 226.00 92.73Z" fill="#FFE135" stroke="#FFE135" strokeWidth="32" strokeLinejoin="round" /><path d="M286.00 183.57L286.00 92.73A166 166 0 0 1 350.23 119.34ZM328.43 226.00L392.66 161.77A166 166 0 0 1 419.27 226.00ZM328.43 286.00L419.27 286.00A166 166 0 0 1 392.66 350.23ZM286.00 328.43L350.23 392.66A166 166 0 0 1 286.00 419.27Z" fill="#A3E635" stroke="#A3E635" strokeWidth="32" strokeLinejoin="round" /></g>
      ) : (
        <g transform="translate(-16.000 -16.000) scale(1)"><path d="M16 256A240 240 0 1 1 496 256A240 240 0 1 1 16 256Z" fill="#7CC81E" /><path d="M256 496A240 240 0 0 1 256 16Z" fill="#FFD60A" /><path d="M46 256A210 210 0 1 1 466 256A210 210 0 1 1 46 256Z" fill="#FFFBEA" /><path d="M234.50 307.91L234.50 437.73A183 183 0 0 1 142.70 399.71ZM204.09 277.50L112.29 369.30A183 183 0 0 1 74.27 277.50ZM204.09 234.50L74.27 234.50A183 183 0 0 1 112.29 142.70ZM234.50 204.09L142.70 112.29A183 183 0 0 1 234.50 74.27Z" fill="#FFE135" stroke="#FFE135" strokeWidth="26" strokeLinejoin="round" /><path d="M277.50 204.09L277.50 74.27A183 183 0 0 1 369.30 112.29ZM307.91 234.50L399.71 142.70A183 183 0 0 1 437.73 234.50ZM307.91 277.50L437.73 277.50A183 183 0 0 1 399.71 369.30ZM277.50 307.91L369.30 399.71A183 183 0 0 1 277.50 437.73Z" fill="#A3E635" stroke="#A3E635" strokeWidth="26" strokeLinejoin="round" /></g>
      )}
    </svg>
  );
}
