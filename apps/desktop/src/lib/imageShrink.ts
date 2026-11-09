/**
 * Big images are made smaller before they're uploaded. Once a conversation carries many
 * images the model's API turns away any wider or taller than 2000 px, and that breaks every
 * later turn in the thread, so nothing longer than that goes up. Images already within the
 * limits are sent exactly as they are.
 */

/** The longest side an image may have once sent. */
export const IMAGE_MAX_EDGE = 2000;
/** The most an image may weigh once sent (well under the API's per-image limit, base64 and all). */
export const IMAGE_MAX_BYTES = 3.5 * 1024 * 1024;

const QUALITY_STEPS = [0.9, 0.82, 0.74, 0.66, 0.58];
/** Formats we can draw and encode again; GIFs (maybe animated), SVGs and the rest go as they are. */
const SHRINKABLE = /^image\/(png|jpeg|webp)$/;

/** The size to draw an image at so its longest side is at most `max`, keeping its shape. */
export function fitWithin(width: number, height: number, max = IMAGE_MAX_EDGE): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= max) return { width, height };
  const k = max / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** Whether an image has to be made smaller. */
export const needsShrinking = (width: number, height: number, bytes: number) => Math.max(width, height) > IMAGE_MAX_EDGE || bytes > IMAGE_MAX_BYTES;

/** The file name with the extension for `type` (photo.png → photo.jpg). */
export function renameFor(name: string, type: string): string {
  const ext = type === "image/jpeg" ? "jpg" : type.slice("image/".length);
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name || "image";
  return `${base}.${ext}`;
}

/**
 * The encodings to try, in order, for a source of `type`: a PNG first stays a PNG (sharp
 * text in screenshots), then tries WebP and JPEG at falling quality; a JPEG or WebP keeps
 * its format.
 */
export function encodePlan(type: string): { type: string; quality?: number }[] {
  const lossy = (t: string) => QUALITY_STEPS.map(quality => ({ type: t, quality }));
  if (type === "image/png") return [{ type: "image/png" }, ...lossy("image/webp"), ...lossy("image/jpeg")];
  if (type === "image/webp") return [...lossy("image/webp"), ...lossy("image/jpeg")];
  return lossy("image/jpeg");
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) => new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, quality));

/**
 * The image, at most 2000 px on its longest side and under the size cap, or the same file
 * when it already fits (or isn't one we can redraw, or can't be decoded here).
 */
export async function shrinkImage(file: File): Promise<File> {
  if (!SHRINKABLE.test(file.type) || typeof createImageBitmap !== "function") return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  try {
    if (!needsShrinking(bitmap.width, bitmap.height, file.size)) return file;
    let { width, height } = fitWithin(bitmap.width, bitmap.height);
    // If even the lowest quality is too big, draw smaller and try again.
    for (let round = 0; round < 3; round++) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return file;
      ctx.imageSmoothingQuality = "high";
      for (const step of encodePlan(file.type)) {
        ctx.clearRect(0, 0, width, height);
        if (step.type === "image/jpeg") {
          // JPEG has no transparency: put a white page behind see-through pixels.
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, width, height);
        }
        ctx.drawImage(bitmap, 0, 0, width, height);
        const blob = await toBlob(canvas, step.type, step.quality);
        // An engine that can't write the format hands back a PNG instead; skip to the next.
        if (!blob || blob.type !== step.type) continue;
        if (blob.size <= IMAGE_MAX_BYTES) return new File([blob], renameFor(file.name, blob.type), { type: blob.type, lastModified: file.lastModified });
      }
      width = Math.max(1, Math.round(width * 0.75));
      height = Math.max(1, Math.round(height * 0.75));
    }
    return file;
  } finally {
    bitmap.close();
  }
}
