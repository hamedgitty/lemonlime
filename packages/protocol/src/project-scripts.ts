import { z } from "zod";

/**
 * Project scripts: a few named commands (Dev, Test, Lint…) a project keeps in
 * `lemonlime.json` at its repository root. They run in a terminal in the thread's own
 * folder. The runner reads the file itself, from the repository next to it, so the app never
 * sends a command to run: a script only exists where its file does.
 *
 * ```json
 * {
 *   "scripts": [
 *     { "name": "Setup", "command": "cp \"$LEMONLIME_PROJECT_ROOT/.env\" . && pnpm install", "runOnWorktreeCreate": true },
 *     { "name": "Dev", "command": "pnpm dev", "icon": "play", "previewUrl": "http://localhost:5173", "keybinding": "run-script-1" },
 *     { "name": "Test", "command": "pnpm test", "icon": "test" }
 *   ]
 * }
 * ```
 */

export const PROJECT_FILE = "lemonlime.json";
/** Most scripts one project may have. */
export const MAX_PROJECT_SCRIPTS = 20;
/** The project file is read only when it's smaller than this. */
export const PROJECT_FILE_MAX_BYTES = 64 * 1024;
/** How long a setup script may run when a worktree is made, unless it says otherwise. */
export const SETUP_SCRIPT_TIMEOUT_SECONDS = 600;

/** The icons a script can pick for its button. */
export const SCRIPT_ICONS = ["play", "test", "lint", "build", "server", "package", "wrench", "terminal", "bug", "rocket", "database", "sparkles"] as const;
export const ScriptIcon = z.enum(SCRIPT_ICONS);
export type ScriptIcon = z.infer<typeof ScriptIcon>;

/** The keyboard shortcuts scripts can take (their keys are set in Settings, Keyboard). */
export const SCRIPT_KEYBINDINGS = ["run-script-1", "run-script-2", "run-script-3", "run-script-4"] as const;
export const ScriptKeybinding = z.enum(SCRIPT_KEYBINDINGS);
export type ScriptKeybinding = z.infer<typeof ScriptKeybinding>;

/** Short enough that `script-<id>` is a terminal id. */
export const ScriptId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);

/** A local address (localhost, 127.0.0.1 or [::1]) for the panel's browser. */
export const LocalPreviewUrl = z
  .string()
  .max(2000)
  .refine(v => {
    try {
      const u = new URL(v);
      return (u.protocol === "http:" || u.protocol === "https:") && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    } catch {
      return false;
    }
  }, "previewUrl must be a local address, like http://localhost:5173");

export const ProjectScript = z.object({
  /** Stable id, for the terminal and shortcuts; made from the name when left out. */
  id: ScriptId.optional(),
  name: z.string().trim().min(1).max(40),
  command: z.string().min(1).max(8000),
  icon: ScriptIcon.optional(),
  /** Run once when the thread's worktree is first made, before the agent starts (setup: copy .env files, install dependencies). */
  runOnWorktreeCreate: z.boolean().optional(),
  /** How long that setup may take, in seconds (default SETUP_SCRIPT_TIMEOUT_SECONDS). */
  timeoutSeconds: z.number().int().min(1).max(3600).optional(),
  /** Open this local address in the panel's browser when the script starts. */
  previewUrl: LocalPreviewUrl.optional(),
  /** Run it with one of the app's script shortcuts. */
  keybinding: ScriptKeybinding.optional(),
});
export type ProjectScript = z.infer<typeof ProjectScript>;

/** A script as the runner hands it to apps: always with an id. */
export type ResolvedScript = ProjectScript & { id: string };

export const ProjectConfig = z.object({
  scripts: z.array(ProjectScript).max(MAX_PROJECT_SCRIPTS).default([]),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;

/** "Run tests!" → "run-tests". */
export function scriptIdFor(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return slug || "script";
}

/**
 * The project file's scripts, each with a unique id, or what's wrong with the file in plain
 * words. A missing file is just no scripts.
 */
export function parseProjectConfig(text: string): { scripts: ResolvedScript[] } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: `${PROJECT_FILE} isn't valid JSON.` };
  }
  const parsed = ProjectConfig.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? ` (at ${issue.path.join(".")})` : "";
    return { error: `${PROJECT_FILE} has a problem${where}: ${issue?.message ?? "it doesn't match the expected shape"}.` };
  }
  const used = new Set<string>();
  const scripts = parsed.data.scripts.map(s => {
    const base = s.id ?? scriptIdFor(s.name);
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base.slice(0, 28)}-${n}`;
    used.add(id);
    return { ...s, id };
  });
  return { scripts };
}

/** Environment variables every script gets, so it can find the project and its worktree. */
export function scriptEnv(o: { projectRoot: string; worktree: string; threadId: string }): Record<string, string> {
  return { LEMONLIME_PROJECT_ROOT: o.projectRoot, LEMONLIME_WORKTREE_PATH: o.worktree, LEMONLIME_THREAD_ID: o.threadId };
}

/** The terminal a script runs in (one per script, per thread). */
export const scriptTerminalId = (id: string) => `script-${id}`;

/** `GET /project-scripts` on the runner. */
export const ProjectScriptsResponse = z.object({
  scripts: z.array(ProjectScript.extend({ id: ScriptId })),
  /** What's wrong with the project file, when it couldn't be read. */
  error: z.string().optional(),
});
export type ProjectScriptsResponse = z.infer<typeof ProjectScriptsResponse>;
