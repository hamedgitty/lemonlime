import { useMemo } from "react";
import qrcode from "qrcode-generator";

/** The dark squares of a QR code for `text`, as one SVG path (one square per module). */
export function qrPath(text: string): { size: number; d: string } {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  let d = "";
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  return { size, d };
}

/** A QR code a phone camera can open. Only ever give it public addresses, never a secret. */
export function QrCode({ text, label, px = 152 }: { text: string; label: string; px?: number }) {
  const { size, d } = useMemo(() => qrPath(text), [text]);
  const quiet = 2;
  return (
    <svg
      role="img"
      aria-label={label}
      width={px}
      height={px}
      viewBox={`${-quiet} ${-quiet} ${size + quiet * 2} ${size + quiet * 2}`}
      shapeRendering="crispEdges"
      className="shrink-0 rounded-lg border border-line bg-paper"
    >
      <path d={d} className="fill-ink" />
    </svg>
  );
}
