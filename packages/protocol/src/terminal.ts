import { z } from "zod";

/**
 * The thread's terminals: shells in the thread's working folder, over their own WebSocket
 * at `/terminal` on the runner. A thread can have up to `MAX_TERMINALS`, each named by an
 * id the app picks (`terminal` in hello; "main" when left out). Each is shared by every app
 * that opens it, and kept running while nobody is watching. Output is counted in characters from the
 * shell's start (`end`), so a client that reconnects asks for what it missed
 * (`resumeFrom`) and gets up to the last `TERMINAL_REPLAY_CHARS` of it.
 */

/** How much recent output the runner keeps for clients that reconnect. */
export const TERMINAL_REPLAY_CHARS = 1024 * 1024;
/** Most characters of input in one message (a big paste is split by the client). */
export const TERMINAL_MAX_INPUT_CHARS = 64 * 1024;
/** Most shells one thread may have open at once. */
export const MAX_TERMINALS = 8;
/** The terminal an app opens when it doesn't name one (and the only one older apps know). */
export const DEFAULT_TERMINAL_ID = "main";
/** A terminal's id: picked by the app, short and plain. */
export const TerminalId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);

const Size = { cols: z.number().int().min(2).max(1000), rows: z.number().int().min(1).max(500) };

export const TerminalClientMessage = z.discriminatedUnion("type", [
  /** First message: a client token for the thread, the window size, and where to resume. */
  z.object({
    type: z.literal("hello"),
    token: z.string().min(1),
    ...Size,
    /** From an earlier `ready`/`output`: the shell and position the client got up to. */
    shell: z.number().int().nonnegative().optional(),
    resumeFrom: z.number().int().nonnegative().optional(),
    /** Which of the thread's terminals; opened if it isn't running yet. */
    terminal: TerminalId.optional(),
    /**
     * This terminal runs one of the project's scripts (by id, from the runner's own copy of
     * the project file) instead of a shell. It isn't started by hello: `restart` runs it.
     */
    script: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,31}$/)
      .optional(),
  }),
  z.object({ type: z.literal("input"), data: z.string().min(1).max(TERMINAL_MAX_INPUT_CHARS) }),
  z.object({ type: z.literal("resize"), ...Size }),
  /** Start a new shell after the last one exited (or run the terminal's script again). */
  z.object({ type: z.literal("restart") }),
  /** End this terminal's shell for good and forget it (the app closed its tab). */
  z.object({ type: z.literal("close") }),
]);
export type TerminalClientMessage = z.infer<typeof TerminalClientMessage>;

export const TerminalServerMessage = z.discriminatedUnion("type", [
  /**
   * After hello. `reset`: what the client had is gone (too old, or a new shell), so it
   * should clear its screen before the output that follows.
   */
  z.object({
    type: z.literal("ready"),
    reset: z.boolean(),
    running: z.boolean(),
    shell: z.number().int().nonnegative(),
    /** The shell program's name, e.g. "zsh", for the app's tab. */
    name: z.string().max(80).optional(),
  }),
  /** Output; `end` is the position right after it, to resume from later. */
  z.object({ type: z.literal("output"), data: z.string(), end: z.number().int().nonnegative() }),
  z.object({ type: z.literal("exit"), code: z.number().int().nullable() }),
  /** A new shell started (after `restart`): clear the screen; positions start again from 0. */
  z.object({ type: z.literal("restarted"), shell: z.number().int().nonnegative() }),
  z.object({ type: z.literal("error"), code: z.enum(["unauthorized", "bad_request", "unavailable", "limit"]), message: z.string() }),
]);
export type TerminalServerMessage = z.infer<typeof TerminalServerMessage>;

export function parseTerminalClientMessage(raw: string): TerminalClientMessage | null {
  try {
    const r = TerminalClientMessage.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function parseTerminalServerMessage(raw: string): TerminalServerMessage | null {
  try {
    const r = TerminalServerMessage.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/**
 * The runner's `/tunnel?port=N`: after a text `hello` with a client token, every binary
 * frame is raw bytes to and from that port inside the sandbox (only ports the agent offered
 * for preview). One WebSocket per TCP connection.
 */
export const TunnelHello = z.object({ type: z.literal("hello"), token: z.string().min(1) });
