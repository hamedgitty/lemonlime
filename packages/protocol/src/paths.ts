/**
 * A long file path, kept to its last few parts so the file's name shows in a one-line row
 * ("…/src/app/page.tsx"), since the start of an absolute path says little.
 */
export function shortPath(path: string, max = 48): string {
  if (path.length <= max) return path;
  const parts = path.split("/").filter(Boolean);
  let out = parts.pop() ?? path;
  while (parts.length && out.length + parts[parts.length - 1]!.length + 1 <= max - 2) out = `${parts.pop()}/${out}`;
  return `…/${out}`;
}
