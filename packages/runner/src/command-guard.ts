/**
 * Blocks the few shell commands that destroy a computer rather than a project: deleting
 * the root or home folder, wiping or reformatting a disk, and fork bombs. Also deleting a
 * whole GitHub repository, which no branch or backup brings back. Everything else is the
 * agent's business. Used as a Claude Code PreToolUse hook
 * (`lemonlime-runner command-guard`); a thread can turn it off.
 */

const HOME = /^(?:~|\$HOME|\$\{HOME\}|\/(?:Users|home)\/[^/\s]+)\/?$/;
const ROOTISH = /^\/(?:\*|bin|boot|dev|etc|lib|lib64|opt|private|proc|sbin|sys|System|usr|var|Applications|Library|Users|home)?\/?\*?$/;

/** Split a command line into simple commands (on ; && || | and newlines), roughly. */
function parts(command: string): string[] {
  return command
    .split(/;|&&|\|\||\||\n/)
    .map(s => s.trim())
    .filter(Boolean);
}

function words(cmd: string): string[] {
  return (cmd.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(w => w.replace(/^["']|["']$/g, ""));
}

/** Why `command` is blocked, or null if it may run. */
export function dangerousCommand(command: string): string | null {
  const flat = command.replace(/\s+/g, " ");
  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/.test(flat)) return "That's a fork bomb: it would freeze the computer.";
  for (const part of parts(command)) {
    let w = words(part);
    while (w[0] === "sudo" || w[0] === "doas" || w[0] === "command" || w[0] === "exec" || w[0] === "nohup" || /^[A-Z_]+=/.test(w[0] ?? "")) w = w.slice(1);
    const [cmd, ...args] = w;
    if (!cmd) continue;
    const name = cmd.split("/").pop()!;
    if (name === "rm") {
      const flags = args.filter(a => a.startsWith("-")).join("");
      const recursive = /r|R|--recursive/.test(flags);
      const targets = args.filter(a => !a.startsWith("-"));
      if (args.includes("--no-preserve-root")) return "Deleting with --no-preserve-root is blocked.";
      if (recursive) {
        for (const t of targets) {
          if (ROOTISH.test(t)) return `Deleting ${t} would wipe the computer's system files.`;
          if (HOME.test(t) || t === "~/*" || t === "$HOME/*") return `Deleting ${t} would wipe the home folder.`;
        }
      }
    }
    if (
      /^mkfs(\.|$)|^newfs/.test(name) ||
      (name === "diskutil" && /^(eraseDisk|eraseVolume|reformat|zeroDisk|randomDisk|secureErase|partitionDisk)$/i.test(args[0] ?? ""))
    ) {
      return "Formatting or erasing a disk is blocked.";
    }
    if (name === "gh" && args.filter(a => !a.startsWith("-"))[0] === "repo" && args.filter(a => !a.startsWith("-"))[1] === "delete") {
      return "Deleting a GitHub repository is blocked: it can't be undone.";
    }
    if (name === "dd" && args.some(a => /^of=\/dev\/(?!null$|zero$|stdout$|stderr$)/.test(a))) return "Writing straight to a disk device is blocked.";
    if (/^(shred|wipefs)$/.test(name) && args.some(a => a.startsWith("/dev/"))) return "Wiping a disk device is blocked.";
    if (name === "chmod" || name === "chown") {
      const recursive = args.some(a => /^-\w*R/.test(a));
      if (recursive && args.some(a => a === "/" || HOME.test(a)))
        return `Changing ${name === "chmod" ? "permissions" : "owners"} on the whole ${args.includes("/") ? "computer" : "home folder"} is blocked.`;
    }
  }
  if (/>\s*\/dev\/(sd[a-z]|nvme\d|disk\d|hd[a-z])/.test(flat)) return "Writing straight to a disk device is blocked.";
  return null;
}

/**
 * The hook itself: reads Claude Code's PreToolUse input on stdin. Exit code 2 blocks the
 * tool call and shows the reason to the agent.
 */
export function runCommandGuardHook(input: string): { code: 0 | 2; stderr: string } {
  let req: { tool_name?: string; tool_input?: { command?: unknown } };
  try {
    req = JSON.parse(input) as typeof req;
  } catch {
    return { code: 0, stderr: "" };
  }
  const command = typeof req.tool_input?.command === "string" ? req.tool_input.command : "";
  const why = req.tool_name === "Bash" && command ? dangerousCommand(command) : null;
  return why
    ? { code: 2, stderr: `LemonLime blocked this command. ${why} If it's really needed, ask the user to run it themselves.` }
    : { code: 0, stderr: "" };
}
