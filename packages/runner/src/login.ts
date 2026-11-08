import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentKind } from "@lemonlime/protocol";
import { killGently } from "./agents/process.ts";

export type LoginState = "starting" | "open_url" | "needs_input" | "done" | "failed";
export interface LoginUpdate {
  state: LoginState;
  url?: string;
  code?: string;
  message?: string;
}

/** What a finished sign-in leaves behind, to keep for the user's next sandboxes. */
export interface AgentCredential {
  kind: "env" | "file";
  /** Variable name, or path relative to the home directory. */
  name: string;
  value: string;
}

export interface LoginPlan {
  command: string[];
  /** The credential, from the command's output or the files it wrote. */
  credential(output: string, home: string): AgentCredential | null;
}

/**
 * How each agent signs in to the user's own account without a browser in the sandbox.
 * Claude Code: `claude setup-token` (open a link, paste the code back, get a long-lived
 * token). Codex: device sign-in (open a link, type the code shown here).
 */
export const LOGIN_PLANS: Partial<Record<AgentKind, LoginPlan>> = {
  "claude-code": {
    command: ["claude", "setup-token"],
    credential(output) {
      const token = /\bsk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}/.exec(output)?.[0];
      return token ? { kind: "env", name: "CLAUDE_CODE_OAUTH_TOKEN", value: token } : null;
    },
  },
  codex: {
    command: ["codex", "login", "--device-auth"],
    credential(_output, home) {
      const file = join(process.env.CODEX_HOME || join(home, ".codex"), "auth.json");
      return existsSync(file) ? { kind: "file", name: ".codex/auth.json", value: readFileSync(file, "utf8") } : null;
    },
  },
};

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007|\r/g;
const URL_RE = /https:\/\/[^\s"'<>)]+/;
const DEVICE_CODE = /\b([A-Z0-9]{4}-[A-Z0-9]{4,5})\b/;
const ASKS_FOR_INPUT = /paste|enter (the )?(code|token)|authorization code/i;

/**
 * Runs one sign-in. Updates go to `onUpdate` as the CLI prints its link, code and
 * prompts; the output itself is never stored anywhere.
 */
export class LoginSession {
  private child: ChildProcess | null = null;
  private output = "";
  private lastUrl: string | undefined;
  private lastCode: string | undefined;
  private asked = false;
  private finished = false;

  constructor(
    private readonly kind: AgentKind,
    private readonly onUpdate: (u: LoginUpdate) => void,
    private readonly opts: {
      cwd: string;
      command?: string[];
      home?: string;
      usePty?: boolean;
      /** Another plan than the agent's sandbox one (signing in to an account on the user's own computer). */
      plan?: LoginPlan;
      /** More environment for the sign-in, e.g. the account's config folder. */
      env?: Record<string, string>;
      /** Let the CLI open the user's browser (their own computer, not a sandbox). */
      openBrowser?: boolean;
    } = { cwd: process.cwd() },
  ) {}

  /** Start the sign-in. Resolves with the credential, or null if it failed or was cancelled. */
  run(): Promise<AgentCredential | null> {
    const plan = this.opts.plan ?? LOGIN_PLANS[this.kind];
    if (!plan) {
      this.finish({ state: "failed", message: "Signing this agent in from LemonLime isn't supported yet. Add an API key as a secret instead." });
      return Promise.resolve(null);
    }
    const argv = this.opts.command ?? plan.command;
    // These CLIs want a terminal. On Linux, `script` gives them one without a real TTY.
    const usePty = this.opts.usePty ?? (process.platform === "linux" && existsSync("/usr/bin/script"));
    const [cmd, args] = usePty ? ["script", ["-qfec", argv.map(a => `'${a.replace(/'/g, `'\\''`)}'`).join(" "), "/dev/null"]] : [argv[0]!, argv.slice(1)];
    this.onUpdate({ state: "starting" });
    return new Promise(resolve => {
      const child = spawn(cmd, args, {
        cwd: this.opts.cwd,
        // Nothing should try to open a browser inside a sandbox.
        env: {
          ...process.env,
          ...(this.opts.openBrowser ? {} : { BROWSER: "true" }),
          NO_COLOR: "1",
          TERM: usePty ? "xterm-256color" : "dumb",
          ...this.opts.env,
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.child = child;
      const onData = (d: Buffer) => this.read(d.toString());
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.on("error", err => {
        this.finish({ state: "failed", message: `Couldn't start ${argv[0]}: ${err.message}` });
        resolve(null);
      });
      child.on("close", code => {
        this.child = null;
        if (this.finished) return resolve(null);
        const credential = code === 0 ? plan.credential(this.output.replace(ANSI, ""), this.opts.home ?? homedir()) : null;
        if (credential) {
          this.finish({ state: "done", message: "Signed in. New messages use your account." });
          resolve(credential);
        } else {
          const tail = this.output.replace(ANSI, "").trim().split("\n").slice(-3).join(" ").slice(0, 400);
          this.finish({
            state: "failed",
            message: code === 0 ? "The sign-in finished but no credential was found." : `Sign-in didn't finish${tail ? `: ${tail}` : "."}`,
          });
          resolve(null);
        }
      });
    });
  }

  /** Text the user was asked for, e.g. the code shown after authorizing. */
  input(text: string): void {
    this.child?.stdin?.write(`${text.trim()}\n`);
  }

  cancel(): void {
    if (this.child) killGently(this.child);
    this.finish({ state: "failed", message: "Sign-in cancelled." });
  }

  private read(chunk: string): void {
    this.output = (this.output + chunk).slice(-64_000);
    const clean = this.output.replace(ANSI, "");
    const url = URL_RE.exec(clean)?.[0];
    const code = DEVICE_CODE.exec(clean)?.[1];
    if (url && (url !== this.lastUrl || code !== this.lastCode)) {
      this.lastUrl = url;
      this.lastCode = code;
      this.onUpdate({ state: "open_url", url, ...(code ? { code } : {}) });
    }
    if (!this.asked && ASKS_FOR_INPUT.test(clean)) {
      this.asked = true;
      this.onUpdate({ state: "needs_input", ...(this.lastUrl ? { url: this.lastUrl } : {}), message: "After signing in, paste the code the page shows you." });
    }
  }

  private finish(u: LoginUpdate): void {
    if (this.finished) return;
    this.finished = true;
    this.onUpdate(u);
  }
}
