/**
 * Spotting file paths in the agent's replies (`src/app.ts:12` in inline code, or a link to
 * a relative path) so they can open in the side panel. Only text that looks like a file in
 * the project counts: no URLs, no paths outside it, no `console.log` or version numbers.
 */

export interface FileRef {
  /** Relative to the project folder, without "./". */
  path: string;
  line?: number;
}

/** Extensions common enough that a bare name (no folder) still reads as a file. */
const BARE_EXTENSIONS = new Set(
  "ts tsx mts cts js jsx mjs cjs json jsonc md mdx css scss sass less html htm vue svelte astro py rs go java kt kts swift rb php c h cc cpp hpp cs fs ex exs erl dart scala lua r sql sh bash zsh fish ps1 toml yaml yml ini cfg conf lock xml proto graphql gql prisma tf txt csv tsv gradle".split(
    " ",
  ),
);
/** Files known by name alone. */
const NAMED = new Set(["Dockerfile", "Makefile", "Procfile", "Gemfile", "Rakefile", "Justfile", "LICENSE", "README", "CHANGELOG"]);

const SEGMENT = /^\.?[\w@+-][\w.@+-]*$/;

/**
 * The file `text` points at, or null. Takes `path`, `./path`, `path:12`, `path:12:5` and
 * `path#L12`; an absolute path counts only inside `root` (the project folder).
 */
export function fileRef(text: string, root?: string | null): FileRef | null {
  let s = text.trim();
  if (!s || s.length > 300 || /\s|:\/\/|^[~$]|[*?<>|"'`]/.test(s)) return null;
  let line: number | undefined;
  const at = /(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/.exec(s);
  if (at) {
    line = Number(at[1] ?? at[2]);
    s = s.slice(0, at.index);
  }
  if (s.startsWith("/")) {
    const base = root?.replace(/\/+$/, "");
    if (!base || !s.startsWith(`${base}/`)) return null;
    s = s.slice(base.length + 1);
  }
  s = s.replace(/^(\.\/)+/, "");
  const parts = s.split("/");
  if (parts.some(p => !SEGMENT.test(p) || p === "..")) return null;
  const name = parts.at(-1)!;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  const hasExt = /^[A-Za-z0-9]{1,10}$/.test(ext) && /[A-Za-z]/.test(ext) && /[A-Za-z_]/.test(name.slice(0, dot));
  const ok = parts.length > 1 ? hasExt || NAMED.has(name) || /^\.[\w-]+$/.test(name) : (hasExt && BARE_EXTENSIONS.has(ext.toLowerCase())) || NAMED.has(name);
  if (!ok) return null;
  return line && line > 0 ? { path: s, line } : { path: s };
}
